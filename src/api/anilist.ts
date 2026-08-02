// Пункт 1.4 плана: клиент AniList GraphQL (строки 1607-1677 монолита).
//
// alRateLimitPause был глобальной переменной IIFE — теперь это приватное состояние
// модуля. Пауза общая на все запросы AniList, что и требуется: лимит серверный.
//
// Пункт 3.5.2: транспорт переведён с GM_xmlhttpRequest на Bridge.http.
// Три места, где переход не чисто механический:
//
//   1) retry-after раньше выдёргивался регуляркой из сырой строки всех заголовков.
//      Мост отдаёт заголовки разобранным объектом с ключами в нижнем регистре,
//      поэтому читаем headers['retry-after'] напрямую. Значение по умолчанию (5с)
//      и добавка +500мс сохранены.
//
//   2) Код вне 2xx мост исключением не считает, поэтому 429 и прочие ошибки
//      разбираются явными ветками. 429 не должен становиться ошибкой для
//      вызывающего кода, пока есть смысл ждать: это просьба подождать, а не отказ.
//      Очередь перевода считает отказы попытками и после трёх бросает элементы
//      без перевода. Оговорка «пока есть смысл ждать» — см. MAX_RATE_RETRIES ниже.
//
//   3) credentials: 'omit' — обязательно, и это не оптимизация, а условие работоспособности.
//      Дефолт моста — 'include', то есть запрос со страницы anilist.co уходит на
//      graphql.anilist.co со всеми куками домена. У залогиненного пользователя они
//      разрастаются настолько, что nginx отвечает «400 Request Header Or Cookie Too
//      Large» ещё до GraphQL, и падают все запросы подряд — перевод имён, рейтинги,
//      франшиза. Куки здесь бесполезны: AniList авторизует GraphQL только заголовком
//      Authorization: Bearer, сессия сайта ему не нужна. В Tauri 'omit' тоже корректен:
//      там куков AniList нет в принципе.
//
// Пункт 3.5.3: токен AL_TOKEN переехал с GM_getValue на Bridge.storage.
// Хранилище моста асинхронное, а getAlToken() зовут из мест, где ждать нельзя
// (сборка заголовков запроса, панель настроек, окно экспорта). Поэтому здесь тот
// же приём, что у настроек и своих ссылок: значение один раз читается в память на
// старте через loadAlToken(), геттеры остаются синхронными, а setAlToken() сначала
// правит память и только потом пишет в хранилище и никогда не отклоняется.
//
// Кэш живёт именно здесь, потому что это единственный модуль, которому токен нужен
// для работы. Панель настроек и окно синхронизации им пользуются, но своей копии
// не держат — иначе после смены токена в настройках запросы ушли бы со старым.
//
// Правка 2 августа 2026: отступ при отказе сервера.
//
// В день финального теста AniList выключил свой API целиком и отвечал 403 на любой
// запрос. Пауза ставилась только на 429, поэтому всё остальное улетало в ошибку
// без всякого торможения, и система вставала в вечный круг: пачка падала →
// очередь снимала с элементов маркеры → обход страницы находил их заново →
// через полсекунды уходила следующая такая же пачка. Счётчик MAX_ATTEMPTS в
// очереди от этого не спасал: он считает попытки по ключу, а ключ после
// «отпускания» тут же создавался заново со свежим элементом страницы.
//
// Поэтому тормоз живёт здесь, а не в очереди: только клиент видит все запросы к
// AniList сразу — и от очереди перевода, и от рейтингов, и от виджета франшизы.

import { Bridge, type HttpResponse } from '@/bridge'
import { IS_ANILIST } from '../core/constants'
import { Logger } from '../utils/logger'

/** Адрес GraphQL-точки AniList. */
const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Пауза по умолчанию, если сервер не прислал retry-after. */
const DEFAULT_RETRY_MS = 5000

/**
 * Сколько раз подряд повторять запрос после 429.
 *
 * До этого повтор был безусловным и рекурсивным, без счётчика попыток. Пока сервер
 * отвечает 429, вызов не завершается никогда: обещание висит, вызывающий код ждёт,
 * интерфейс выглядит зависшим. В браузере это лечилось перезагрузкой вкладки,
 * в оболочке — ничем.
 *
 * Три попытки согласованы с MAX_RATE_RETRIES в api/rate-limit.ts: правило поведения
 * при лимите должно быть одинаковым у всех сетевых клиентов.
 */
const MAX_RATE_RETRIES = 3

/**
 * Первая пауза после отказа сервера и потолок роста.
 *
 * Каждый следующий отказ подряд удваивает паузу: 30с, минута, две, четыре,
 * восемь, дальше пятнадцать как потолок. Жёсткое значение не годится обоим
 * случаям сразу: при минутной аварии долгая пауза зря лишает человека перевода,
 * а при многочасовом отключении API короткая превращается в долбёжку.
 */
const SERVER_FAIL_PAUSE_MS = 30000
const SERVER_FAIL_MAX_PAUSE_MS = 900000

/**
 * Порог ожидания внутри запроса. Короткую паузу проще переждать на месте,
 * длинную — нельзя: висящее по пятнадцать минут обещание держит вызывающий код
 * и выглядит зависанием. Такой вызов честнее отклонить сразу.
 */
const MAX_INLINE_WAIT_MS = 10000

/** Ключ хранилища для токена. Имя сохранено из монолита ради совместимости. */
const TOKEN_KEY = 'AL_TOKEN'

/** Unix-время, до которого запросы к AniList приостановлены. */
let alRateLimitPause = 0

/** Сколько отказов сервера подряд. Любой успешный ответ обнуляет. */
let serverFailStreak = 0

/** Копия токена в памяти: заполняется loadAlToken() до первого запроса. */
let alTokenCache = ''

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Активна ли сейчас пауза по лимиту AniList.
 * Нужно очереди перевода: она не начинает новую пачку, пока сервер держит паузу.
 */
export function isAniListRateLimited(): boolean {
  return Date.now() < alRateLimitPause
}

/**
 * Сколько миллисекунд осталось до конца паузы.
 *
 * Очередь перевода спрашивает это, чтобы заснуть ровно до конца паузы, а не
 * просыпаться каждую секунду ради очередной записи в журнал.
 */
export function anilistPauseRemaining(): number {
  return Math.max(0, alRateLimitPause - Date.now())
}

/** Ставит паузу вручную. Существующая более долгая пауза не укорачивается. */
export function pauseAniList(ms: number): void {
  alRateLimitPause = Math.max(alRateLimitPause, Date.now() + ms)
}

export interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: unknown
}

/**
 * Читает токен из хранилища в память. Вызывается один раз при старте, до того как
 * что-либо успеет обратиться к AniList с авторизацией. Ошибка чтения не должна
 * ронять запуск: без токена работают все публичные запросы.
 */
export async function loadAlToken(): Promise<void> {
  try {
    const stored = await Bridge.storage.get<unknown>(TOKEN_KEY, '')
    alTokenCache = typeof stored === 'string' ? stored : ''
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения AL_TOKEN', e)
    alTokenCache = ''
  }
}

/**
 * Токен ровно в том виде, в каком его сохранил пользователь, без подстановки из
 * Vuex. Нужен полям ввода в настройках и в окне экспорта: там нельзя показывать
 * чужой сессионный токен сайта как «сохранённый пользователем».
 */
export function getStoredAlToken(): string {
  return alTokenCache
}

/** Сохраняет токен: сначала в память, потом в хранилище. Никогда не отклоняется. */
export function setAlToken(token: string): void {
  alTokenCache = token
  void Bridge.storage.set(TOKEN_KEY, token).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_TOKEN', e)
  })
}

/**
 * Токен AniList: из настроек, либо (на anilist.co) из Vuex у залогиненного пользователя.
 */
export function getAlToken(): string | null {
  if (alTokenCache) return alTokenCache

  if (IS_ANILIST) {
    try {
      const vuex = JSON.parse(localStorage.getItem('vuex') ?? 'null') as {
        auth?: { token?: string }
      } | null
      if (vuex?.auth?.token) return vuex.auth.token
    } catch (e) {
      Logger('ERROR', 'Ошибка чтения Vuex хранилища AniList', e)
    }
  }
  return null
}

/** Сколько ждать после 429: заголовок retry-after в секундах либо дефолт. */
function readRetryAfter(headers: Record<string, string>): number {
  const raw = headers['retry-after']
  const seconds = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS
}

/**
 * Отказ ли это со стороны сервера, после которого надо отступить.
 *
 * 403 включён сознательно: именно им AniList отвечал, когда выключал API целиком.
 * На отдельный запрос этот код означал бы «нет прав», но у нас публичные запросы
 * без авторизации, так что разницы нет: долбиться в такой ответ бессмысленно в обоих
 * случаях. 408 и весь пятый десяток — обычные аварии шлюза.
 */
function isServerFailure(status: number): boolean {
  return status === 403 || status === 408 || status >= 500
}

/**
 * Ставит растущую паузу после отказа сервера и возвращает её длину.
 *
 * Журналится только момент входа в отступ, а не каждый отказ: при лежачем API
 * первые же секунды давали сотни одинаковых записей и вытесняли из журнала
 * всё остальное — разбирать багрепорт с таким логом невозможно.
 */
function backOffAfterServerFailure(status: number): number {
  const wasIdle = !isAniListRateLimited()

  serverFailStreak++
  const pause = Math.min(
    SERVER_FAIL_PAUSE_MS * Math.pow(2, serverFailStreak - 1),
    SERVER_FAIL_MAX_PAUSE_MS,
  )
  pauseAniList(pause)

  if (wasIdle) {
    Logger(
      'ERROR',
      `AniList отвечает ${status}: запросы приостановлены на ${Math.round(pause / 1000)}с ` +
        `(отказов подряд: ${serverFailStreak})`,
    )
  }

  return pause
}

/**
 * GraphQL-запрос к AniList с паузой после 429 и ограниченным числом повторов.
 *
 * @param useAuth Добавлять ли заголовок Authorization (см. getAlToken()).
 * @param attempt Служебный счётчик повторов после 429. Снаружи не передаётся.
 */
export async function anilistQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  useAuth = false,
  attempt = 0,
): Promise<GraphQLResponse<T>> {
  const remaining = anilistPauseRemaining()
  if (remaining > 0) {
    // Длинную паузу не высиживаем внутри вызова — см. MAX_INLINE_WAIT_MS.
    if (remaining > MAX_INLINE_WAIT_MS) {
      throw new Error(
        `AniList недоступен, повтор через ${Math.ceil(remaining / 1000)}с`,
      )
    }
    await sleep(remaining + Math.floor(Math.random() * 500))
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (useAuth) {
    const token = getAlToken()
    if (token) headers['Authorization'] = 'Bearer ' + token
  }

  Logger('API', 'GraphQL запрос (AniList)', {
    query: query.substring(0, 100) + '...',
    variables,
    useAuth,
  })

  const startTime = performance.now()

  let res: HttpResponse
  try {
    res = await Bridge.http.request({
      method: 'POST',
      url: GRAPHQL_URL,
      headers,
      body: JSON.stringify({ query, variables }),
      // Без куков: см. пункт 3 в шапке файла.
      credentials: 'omit',
    })
  } catch (e) {
    // Только транспортный сбой, таймаут или отмена — бывший onerror.
    // Сеть упала — тот же отступ, что и при отказе сервера: без него очередь
    // перевода крутит пачки вхолостую всё время, пока нет интернета.
    backOffAfterServerFailure(0)
    Logger('ERROR', 'AniList Network Error', e)
    throw new Error('AniList Network Error')
  }

  if (res.status === 429) {
    const waitTime = readRetryAfter(res.headers)
    alRateLimitPause = Date.now() + waitTime + 500

    // Пауза выставляется в любом случае, даже когда повторы исчерпаны: остальные
    // вызовы должны увидеть её и не добивать сервер.
    if (attempt >= MAX_RATE_RETRIES) {
      Logger('ERROR', `AniList Rate Limit 429: повторы исчерпаны (${MAX_RATE_RETRIES})`, res)
      throw new Error('AniList Rate Limit: повторы исчерпаны')
    }

    Logger(
      'ERROR',
      `AniList Rate Limit 429! Ожидание ${waitTime}ms (попытка ${attempt + 1} из ${MAX_RATE_RETRIES})`,
      res,
    )
    await sleep(waitTime + 500 + Math.floor(Math.random() * 500))
    return anilistQuery<T>(query, variables, useAuth, attempt + 1)
  }

  if (res.status !== 200) {
    // Сервер лежит или закрылся — отступаем, а не пробуем снова через полсекунды.
    if (isServerFailure(res.status)) {
      const pause = backOffAfterServerFailure(res.status)
      throw new Error(
        `AniList недоступен (${res.status}), пауза ${Math.round(pause / 1000)}с`,
      )
    }

    Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.text)
    throw new Error(`Error ${res.status}`)
  }

  // Сервер ответил — серия отказов прервана, следующая авария начнёт с 30 секунд.
  if (serverFailStreak > 0) {
    Logger('INFO', `AniList снова отвечает (отказов подряд было: ${serverFailStreak})`)
    serverFailStreak = 0
  }

  const timeTaken = Math.round(performance.now() - startTime)
  Logger('API', `[DONE] GraphQL запрос (AniList) выполнен за ${timeTaken}ms`)

  // Раньше битый JSON падал внутри коллбэка onload и обещание не завершалось
  // никогда: вызывающий код вис в ожидании. Теперь это обычная ошибка.
  let payload: GraphQLResponse<T>
  try {
    payload = JSON.parse(res.text) as GraphQLResponse<T>
  } catch (e) {
    Logger('ERROR', 'AniList: не удалось разобрать ответ', e)
    throw new Error('AniList: некорректный ответ сервера')
  }

  if (payload.errors) {
    const message = JSON.stringify(payload.errors)
    Logger('ERROR', 'AniList GraphQL Error', payload.errors)
    throw new Error(`AniList GraphQL Error: ${message}`)
  }

  return payload
}
