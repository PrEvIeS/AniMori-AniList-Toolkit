// Пункт 1.4 плана: клиент AniList GraphQL (строки 1607-1677 монолита).
//
// alRateLimitPause был глобальной переменной IIFE — теперь это приватное состояние
// модуля. Пауза общая на все запросы AniList, что и требуется: лимит серверный.
//
// Пункт 3.5.2: транспорт переведён с GM_xmlhttpRequest на Bridge.http.
// Два места, где переход не чисто механический:
//
//   1) retry-after раньше выдёргивался регуляркой из сырой строки всех заголовков.
//      Мост отдаёт заголовки разобранным объектом с ключами в нижнем регистре,
//      поэтому читаем headers['retry-after'] напрямую. Значение по умолчанию (5с)
//      и добавка +500мс сохранены.
//
//   2) Код вне 2xx мост исключением не считает, поэтому 429 и прочие ошибки
//      разбираются явными ветками. 429 НИКОГДА не должен стать ошибкой для
//      вызывающего кода: это просьба подождать, а не отказ. Очередь перевода
//      считает отказы попытками и после трёх бросает элементы без перевода.
//
// Сессионное хранилище токена (GM_getValue в getAlToken) сознательно оставлено
// как есть: хранилище переезжает на мост отдельным пунктом 3.5.3, где сразу будет
// решён вопрос асинхронного чтения во всех потребителях токена.

import { Bridge, type HttpResponse } from '@/bridge'
import { IS_ANILIST } from '../core/constants'
import { Logger } from '../utils/logger'

/** Адрес GraphQL-точки AniList. */
const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Пауза по умолчанию, если сервер не прислал retry-after. */
const DEFAULT_RETRY_MS = 5000

/** Unix-время, до которого запросы к AniList приостановлены после 429. */
let alRateLimitPause = 0

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

/** Ставит паузу вручную. Существующая более долгая пауза не укорачивается. */
export function pauseAniList(ms: number): void {
  alRateLimitPause = Math.max(alRateLimitPause, Date.now() + ms)
}

export interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: unknown
}

/**
 * Токен AniList: из настроек, либо (на anilist.co) из Vuex у залогиненного пользователя.
 */
export function getAlToken(): string | null {
  const stored = GM_getValue('AL_TOKEN')
  if (typeof stored === 'string' && stored) return stored

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
 * GraphQL-запрос к AniList с паузой после 429 и автоматическим повтором.
 * @param useAuth Добавлять ли заголовок Authorization (см. getAlToken()).
 */
export async function anilistQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  useAuth = false,
): Promise<GraphQLResponse<T>> {
  if (Date.now() < alRateLimitPause) {
    await sleep(alRateLimitPause - Date.now() + Math.floor(Math.random() * 500))
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
    })
  } catch (e) {
    // Только транспортный сбой, таймаут или отмена — бывший onerror.
    Logger('ERROR', 'AniList Network Error', e)
    throw new Error('AniList Network Error')
  }

  if (res.status === 429) {
    const waitTime = readRetryAfter(res.headers)
    alRateLimitPause = Date.now() + waitTime + 500
    Logger('ERROR', `AniList Rate Limit 429! Ожидание ${waitTime}ms`, res)
    // Повтор после паузы (429)
    await sleep(waitTime + 500 + Math.floor(Math.random() * 500))
    return anilistQuery<T>(query, variables, useAuth)
  }

  if (res.status !== 200) {
    Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.text)
    throw new Error(`Error ${res.status}`)
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
