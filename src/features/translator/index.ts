// Этап 1 п.1.9: переводчик — очередь, кэш и наблюдатель (строки 2502-3060 монолита).
//
// Что здесь происходит, по шагам:
//   1) MutationObserver видит новые узлы страницы и переводит интерфейс по словарю;
//   2) debouncedFindContent собирает со страницы ссылки на тайтлы/персонажей/авторов;
//   3) queueContent смотрит в кэш IndexedDB и кладёт в очередь только промахи;
//   4) processTransQueue берёт пачку, спрашивает AniList и Shikimori, кладёт в кэш;
//   5) applyTranslation подставляет русское название в конкретные элементы.
//
// Отличия от монолита (все сознательные):
//   - глобальный window.ensureWidgets заменён на подписку registerMutationHook():
//     модуль медиа-виджетов подпишется сам, когда будет вынесен;
//   - globalPendingQueues наружу не торчит, вместо него getPendingQueueSizes();
//   - флаг activeRound висел на самой функции, теперь это переменная модуля;
//   - каждый элемент пачки обрабатывается в try/catch: одна битая карточка больше
//     не роняет всю очередь перевода (в монолите один сбой сети мог её заморозить);
//   - перевод никогда не пишется через textContent в элемент, внутри которого есть
//     разметка (см. writeText): монолит на этом ломал вёрстку карточек.
//
// ВАЖНО про маркеры. AniList переиспользует один и тот же узел .tooltip для разных
// карточек, а ссылки в списках переиспользует при виртуальном скролле. Поэтому
// dataset.translated и dataset.queued хранят id (ключ) тайтла, а не флаг '1', иначе
// узел навсегда глохнет после первого перевода и покажет оригинал.
//
// ВАЖНО про потерю элементов (аудит журнала от 31.07). Пачка удаляла id из pending
// ДО запроса к AniList. Любой сбой сети, любой id, на который AniList не вернул
// строку, и любое исключение внутри строки означали: id из pending исчез, а на
// элементе остался маркер dataset.queued. Следующий скан такой элемент пропускал,
// запросов по нему больше не было — карточка оставалась английской до перезагрузки
// страницы. Теперь любой неуспех возвращает id в очередь и снимает маркер, а после
// трёх неудач ключ отпускается совсем, чтобы не крутиться вечно.
//
// Пункт 3.8: темп запросов больше НЕ регулируется отсюда.
//
// Раньше после каждого элемента пачки стояла своя пауза (250 мс для тайтлов, 300 мс
// для персон) поверх шлюза внутри api-клиентов. Получался двойной троттлинг: пачка
// из сорока тайтлов простаивала десять секунд даже когда все сорок брались из кэша
// и ни одного сетевого запроса не делалось. Теперь темп держит общий ограничитель
// (src/api/rate-limit.ts), а очередь просто отдаёт работу так быстро, как её берут.
// Ждать здесь нечего: acquireSlot() внутри клиента сам притормозит отправку.
//
// Второе изменение 3.8: в проверку лимитов добавлен anime365. Он стоит в той же
// цепочке резолва названий, что и Shikimori, и если он ушёл в паузу или бэкофф,
// запускать новую пачку так же бессмысленно.
//
// Правка 2 августа 2026: спим до конца паузы, а не по секунде.
//
// Когда AniList выключил API целиком и отвечал 403, клиент не ставил паузу, и очередь
// шла по кругу два раза в секунду: пачка падала → requeue снимал маркеры → обход
// страницы находил те же карточки заново. Отступ теперь живёт в api/anilist.ts,
// а здесь осталось второе полуследствие: ждать надо ровно столько, сколько просит
// источник. С прежней секундой пятнадцатиминутная пауза дала бы девятьсот записей
// WARN и вытеснила из журнала (LOG_LIMIT = 1000) всё остальное.
//
// РИСК №4 из AUDITION.md: наблюдатель слушает всю страницу, поэтому собственный UI
// обязательно помечать классом am-notr, иначе на Этапе 2 будет цикл Vue <-> переводчик.

import { anilistPauseRemaining, anilistQuery, isAniListRateLimited } from '../../api/anilist'
import { isAnime365RateLimited } from '../../api/anime365'
import { fetchShiki, isShikimoriRateLimited, pauseShikimori } from '../../api/shikimori'
import {
  fetchShikiPersonREST,
  resolveShikiPersonByMedia,
  type AniListPersonRef,
  type PersonEndpoint,
} from '../../api/shikimori-people'
import { resolveTitle } from '../../api/titles'
import { CACHE_TIME, SHIKI_DOMAINS } from '../../core/constants'
import { dbGet, dbSet } from '../../core/db'
import { registerRetranslateCallback } from '../../core/dictionary'
import { settings } from '../../core/settings'
import type { AniListMedia, MediaType, ShikiCacheRecord } from '../../core/types'
import { Logger } from '../../utils/logger'
import {
  NO_TRANSLATE_CLASS,
  TRANSLATABLE_ATTRS,
  cleanShikiBB,
  safelySetText,
  setupVueInputInterceptor,
  translateNode,
} from './dom'

/** Категории очереди. Они же — префиксы ключей в IndexedDB. */
export type QueueKind = 'MED2' | 'CHR2' | 'STF3'

/** Что лежит в кэше: русское имя и готовый HTML описания. */
interface TranslationPayload {
  ru: string
  desc?: string
}

/** Один элемент страницы, ждущий перевода. */
interface QueueEntry {
  el: HTMLElement
  /** true — это заголовок самой страницы: там же меняется и заголовок вкладки. */
  extra: boolean
}

/** Маркер «искали, русского нет» — чтобы не долбить API по кругу. */
const NOT_FOUND = 'NOT_FOUND'

const MEDIA_BATCH = 40
const PERSON_BATCH = 10

/**
 * Окно сбора пачки. Первый промах не запускает обработку немедленно: за эти
 * полсекунды в очередь успевают попасть остальные карточки экрана, и вместо
 * десяти запросов к AniList по одному элементу уходит один на десять.
 * Окно фиксированное, а не скользящее: поток промахов не должен откладывать старт.
 */
const DISPATCH_DELAY_MS = 500

/** Пауза перед возвратом сбойного id в очередь — чтобы не крутить цикл на упавшей сети. */
const RETRY_DELAY_MS = 2000

/** Сколько раз пробуем один ключ, прежде чем отпустить его до перезагрузки страницы. */
const MAX_ATTEMPTS = 3

/**
 * Порог «уже неважно» для отбора пачки. Всё, что дальше края экрана, считается
 * фоном и уступает место видимому. Значение не критично: оно влияет только на
 * порядок, ни один элемент из очереди не пропадает.
 */
const VIEWPORT_MARGIN_PX = 600

/**
 * Свои виджеты: их содержимое уже на русском и собрано вручную.
 * Ссылки внутри них переводчику отдавать нельзя — он перепишет наш текст
 * и снесёт бейджи (год, тип, статус в списке).
 */
const SELF_UI_SELECTOR =
  '.animori-franchise, .animori-themes, .animori-extlinks, .animori-ratings, #animori-actions'

const MEDIA_QUERY = `query ($ids: [Int]) {
  Page {
    media(id_in: $ids) {
      id
      type
      idMal
      seasonYear
      title { romaji }
    }
  }
}`

const PERSON_QUERY: Record<'CHR2' | 'STF3', string> = {
  CHR2: `query ($ids: [Int]) {
  Page(page: 1, perPage: ${PERSON_BATCH}) {
    characters(id_in: $ids) {
      id
      name { full native }
      media(sort: POPULARITY_DESC, page: 1, perPage: 6) { nodes { idMal type } }
    }
  }
}`,
  STF3: `query ($ids: [Int]) {
  Page(page: 1, perPage: ${PERSON_BATCH}) {
    staff(id_in: $ids) {
      id
      name { full native }
      staffMedia(sort: POPULARITY_DESC, page: 1, perPage: 6) { nodes { idMal type } }
    }
  }
}`,
}

/** Настройки двух почти одинаковых веток: персонажи и авторы. */
const PERSON_CONFIG: Record<
  'CHR2' | 'STF3',
  {
    gqlField: 'characters' | 'staff'
    endpoint: PersonEndpoint
    resolveType: 'characters' | 'staff'
  }
> = {
  CHR2: { gqlField: 'characters', endpoint: 'characters', resolveType: 'characters' },
  STF3: { gqlField: 'staff', endpoint: 'people', resolveType: 'staff' },
}

interface AniListMediaRow {
  id: number
  type: MediaType
  idMal: number | null
  seasonYear?: number | null
  title?: { romaji?: string | null }
}

type AniListPersonRow = AniListPersonRef & { id: number }

// ==== Состояние модуля ====
// Всё приватное: наружу отдаются только функции.

/** Ключ вида "MED2_123" -> элементы страницы, которые надо обновить. */
const queue = new Map<string, QueueEntry[]>()

/** ID, по которым ещё не сделан запрос. */
const pending: Record<QueueKind, Set<number>> = {
  MED2: new Set<number>(),
  CHR2: new Set<number>(),
  STF3: new Set<number>(),
}

/** Счётчик неудачных попыток по ключу. Успех обнуляет запись. */
const attempts = new Map<string, number>()

let isProcessing = false

/**
 * Заявка на повторный прогон. Дефект A7 (журнал ч.3 §6.10).
 * Пока пачка обрабатывается, новые промахи попадают в processTransQueue,
 * та молча выходила по isProcessing — и если работающий цикл к этому моменту
 * уже проверил totalPending() и выходил из while, разбудить очередь было нечем.
 * Элементы висели до следующего перехода по сайту.
 */
let rerunRequested = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let dispatchTimer: ReturnType<typeof setTimeout> | null = null
let mutationHookTimer: ReturnType<typeof setTimeout> | null = null
let isStarted = false
let mutationHook: (() => void) | null = null

/**
 * Подписка на изменения страницы. Нужна медиа-виджетам: AniList любит
 * пересобирать блоки, и их надо вставлять заново.
 * В монолите роль играла глобальная window.ensureWidgets.
 */
export function registerMutationHook(hook: (() => void) | null): void {
  mutationHook = hook
}

/** Размеры очередей для инспектора логгера (только чтение). */
export function getPendingQueueSizes(): Record<QueueKind, number> {
  return { MED2: pending.MED2.size, CHR2: pending.CHR2.size, STF3: pending.STF3.size }
}

/**
 * Сбрасывает счётчики неудач. Дефект A8 (журнал ч.3 §6.11).
 *
 * После MAX_ATTEMPTS ключ отпускался, но запись в attempts оставалась равной 3.
 * Новый узел на странице ставился в очередь и на первом же сбое получал tries = 4,
 * то есть отбрасывался мгновенно, без единой реальной попытки. Один неудачный
 * момент (сеть моргнула) травил ключ на всё время жизни вкладки.
 *
 * Вызывать на смену роута: новая страница — новый шанс. Внутри одной страницы
 * счётчик по-прежнему работает и не даёт крутить цикл на упавшей сети.
 */
export function resetTranslatorRetries(): void {
  const dropped = dropDetachedEntries()
  if (dropped > 0) {
    Logger('QUEUE', `[Process] Смена страницы: снято с очереди оторванных элементов ${dropped}`)
  }

  if (attempts.size === 0) return
  Logger('QUEUE', `[Process] Смена страницы: сброшено счётчиков неудач ${attempts.size}`)
  attempts.clear()
}

/**
 * Выбрасывает из очереди элементы, чьи узлы больше не в документе.
 *
 * Вторая половина дефекта A11. После ухода со списка в MED2 оставались
 * полторы-две сотни карточек покинутой страницы. Писать перевод некуда —
 * узлов нет, — но очередь честно ходила за каждым в anime365 по одному,
 * по четверти секунды на тайтл, и открытая страница ждала минутами.
 *
 * Уже отправленные пачки это не ломает: их id вынуты из pending раньше,
 * а результат всё равно ляжет в кэш и пригодится при возврате.
 */
function dropDetachedEntries(): number {
  let dropped = 0

  for (const [key, entries] of [...queue]) {
    const alive = entries.filter((entry) => entry.el.isConnected)
    if (alive.length === entries.length) continue

    if (alive.length > 0) {
      queue.set(key, alive)
      continue
    }

    queue.delete(key)
    attempts.delete(key)

    const sep = key.indexOf('_')
    const kind = key.slice(0, sep) as QueueKind
    const id = Number(key.slice(sep + 1))
    if (pending[kind]?.delete(id)) dropped++
  }

  return dropped
}

function totalPending(): number {
  return pending.MED2.size + pending.CHR2.size + pending.STF3.size
}

/**
 * Расстояние от элемента до видимой области, в пикселях. 0 — элемент на экране.
 * Оторванные и скрытые узлы получают бесконечность и уходят в самый хвост.
 *
 * Ключ может держать несколько элементов (карточка в списке и та же ссылка
 * в боковом блоке), поэтому берём ближайший из них.
 */
function entryDistance(key: string): number {
  const viewport = window.innerHeight || document.documentElement.clientHeight
  let best = Number.POSITIVE_INFINITY

  for (const { el } of queue.get(key) ?? []) {
    if (!el.isConnected) continue

    const rect = el.getBoundingClientRect()
    // Нулевая рамка — узел в документе, но не отрисован (скрытая вкладка,
    // свёрнутый блок). Показать ему перевод сейчас всё равно некому.
    if (rect.width === 0 && rect.height === 0) continue

    let distance = 0
    if (rect.bottom < 0) distance = -rect.bottom
    else if (rect.top > viewport) distance = rect.top - viewport

    if (distance < best) best = distance
    if (best === 0) break
  }

  return best
}

/**
 * Набирает пачку, отдавая приоритет тому, что пользователь видит прямо сейчас.
 *
 * Дефект A12. Отбор шёл в порядке постановки в очередь, то есть в порядке обхода
 * DOM. При потолке ограничителя в 60 запросов в минуту длина очереди определяла
 * всё: открыв список из двух сотен тайтлов и пролистав вниз, человек ждал, пока
 * пройдут все карточки выше. Теперь видимое переводится первым, остальное
 * дозаполняется фоном и оседает в кэше.
 *
 * Отбор снимает выбранные id с pending — вызывающему это делать больше не нужно.
 */
function pickBatch(kind: QueueKind, size: number): number[] {
  const ids = [...pending[kind]]

  // Очередь короче пачки — считать расстояния незачем, берём всё.
  if (ids.length <= size) {
    ids.forEach((id) => pending[kind].delete(id))
    return ids
  }

  const ranked = ids
    .map((id) => ({ id, distance: entryDistance(`${kind}_${id}`) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, size)

  const onScreen = ranked.filter((item) => item.distance <= VIEWPORT_MARGIN_PX).length
  Logger(
    'QUEUE',
    `[Process] ${kind}: взято ${ranked.length} из ${ids.length}, в зоне видимости ${onScreen}`,
  )

  const picked = ranked.map((item) => item.id)
  picked.forEach((id) => pending[kind].delete(id))
  return picked
}

// ==== Очередь ====

/**
 * Ставит обработку в план. Если окно сбора уже открыто, второй раз не переставляем:
 * иначе непрерывный поток промахов при скролле откладывал бы старт бесконечно.
 */
function scheduleDispatch(): void {
  if (dispatchTimer) return
  dispatchTimer = setTimeout(() => {
    dispatchTimer = null
    void processTransQueue()
  }, DISPATCH_DELAY_MS)
}

/**
 * Снимает маркер «уже в очереди» со всех элементов ключа.
 * Без этого повторная постановка невозможна: queueContent отсекает элемент
 * по dataset.queued, и карточка молча остаётся непереведённой.
 */
function releaseQueued(key: string): void {
  for (const { el } of queue.get(key) ?? []) {
    if (el.dataset.queued === key) delete el.dataset.queued
  }
}

/**
 * Возвращает id в очередь немедленно, не считая это неудачей.
 * Для рейт-лимита: элемент не сломан, просто сейчас не время.
 */
function returnToQueue(kind: QueueKind, id: number): void {
  releaseQueued(`${kind}_${id}`)
  pending[kind].add(id)
}

/**
 * Возвращает id в очередь после сбоя, с паузой и счётчиком попыток.
 * После MAX_ATTEMPTS ключ отпускается: маркеры сняты, запись из очереди удалена,
 * так что новый узел на странице сможет попробовать снова с чистого листа.
 */
function requeue(kind: QueueKind, id: number): void {
  const key = `${kind}_${id}`
  const tries = (attempts.get(key) ?? 0) + 1
  attempts.set(key, tries)
  releaseQueued(key)

  if (tries >= MAX_ATTEMPTS) {
    // Это не рутина очереди, а потеря перевода: элемент останется английским
    // до перезагрузки страницы. Уровень QUEUE прятал такие случаи от глаз.
    Logger('WARN', `[Process] ${key}: неудач подряд ${tries}, ключ отпущен`)
    queue.delete(key)
    return
  }

  setTimeout(() => {
    pending[kind].add(id)
    scheduleDispatch()
  }, RETRY_DELAY_MS)
}

/**
 * Кладёт элемент в очередь перевода или сразу берёт готовое из кэша.
 * @param extra true только для главного заголовка страницы.
 * @param force игнорировать маркер «уже в очереди». Нужен тултипам: AniList переиспользует
 *   один узел и сам возвращает в него оригинальный текст, так что перевод надо
 *   применять заново. Лишних запросов не будет: данные берутся из IndexedDB,
 *   а pending — это Set.
 */
async function queueContent(
  id: number,
  kind: QueueKind,
  el: HTMLElement,
  extra = false,
  force = false,
): Promise<void> {
  const key = `${kind}_${id}`
if (el.dataset.queued === key && !extra && !force) return

// Дефект A6 (журнал ч.3 §6.9). Маркер dataset.queued раньше ставился ЗДЕСЬ,
// до await dbGet. Вызывают нас как void queueContent(...), то есть отказ
// IndexedDB никто не ловил: элемент оставался помеченным, в очередь не попадал,
// а повторно его уже не принимали — карточка английская до перезагрузки.
// Теперь маркер ставится только после того, как элемент реально учтён,
// а любой сбой на пути его снимает.
let cached: ShikiCacheRecord<TranslationPayload> | undefined | null = null
try {
  cached = await dbGet<ShikiCacheRecord<TranslationPayload>>('shikiCache', key)
} catch (e) {
  // Промах кэша не повод бросать элемент: идём в сеть как при Cache MISS.
  Logger('WARN', `[Cache] ${key}: чтение кэша не удалось, идём в сеть`, e)
}

try {
  const list = queue.get(key) ?? []
  list.push({ el, extra })
  queue.set(key, list)

  if (cached && Date.now() - cached.ts < CACHE_TIME) {
    const ageMin = Math.round((Date.now() - cached.ts) / 60000)
    Logger('QUEUE', `[Cache HIT] ${key} (возраст ${ageMin} мин)`)
    el.dataset.queued = key
    applyTranslation(kind, id, cached.data)
    return
  }

  Logger('QUEUE', `[Cache MISS] ${key} ➜ Помещено в очередь перевода`)
  pending[kind].add(id)
  el.dataset.queued = key
  scheduleDispatch()
} catch (e) {
  if (el.dataset.queued === key) delete el.dataset.queued
  Logger('WARN', `[Queue] ${key}: постановка в очередь не удалась`, e)
}
}

/** Основной цикл: пачка за пачкой, пока очередь не опустеет. */
async function processTransQueue(): Promise<void> {
  if (isProcessing) {
    rerunRequested = true
    return
  }
  isProcessing = true
  rerunRequested = false

  try {
    while (totalPending() > 0) {
      Logger('QUEUE', `[Process] Запуск обработки. В ожидании: ${totalPending()} элементов.`)

      // Лимит со стороны любого из трёх источников цепочки: отступаем и пробуем
      // позже, а не колотим в закрытую дверь. anime365 добавлен в 3.8 — он стоит
      // в том же резолве названий, что и Shikimori.
      if (isAniListRateLimited() || isShikimoriRateLimited() || isAnime365RateLimited()) {
        // Ждём ровно столько, сколько просит AniList: при его аварии пауза
        // измеряется минутами, и ежесекундный опрос только забивал бы журнал.
        // Для двух других источников секунды хватает: их паузы короткие.
        const wait = Math.max(1000, anilistPauseRemaining()) + Math.floor(Math.random() * 500)
        Logger('WARN', `[Process] Активен лимит API, повтор через ${wait}ms`)
        setTimeout(() => void processTransQueue(), wait)
        return
      }

      // Дефект A11. Строгий приоритет MED2 морил голодом персонажей: после
      // списка из двух сотен тайтлов очередь MED2 не пустеет минутами, и
      // CHR2/STF3 открытой страницы не получают ход вообще.
      // Персоны идут первыми по двум причинам: они бывают только на той
      // странице, где стоит пользователь, и пачка у них вчетверо меньше
      // (10 против 40), то есть задержка для тайтлов пренебрежимая.
      if (pending.CHR2.size > 0) await processPersonBatch('CHR2')
      else if (pending.STF3.size > 0) await processPersonBatch('STF3')
      else if (pending.MED2.size > 0) await processMediaBatch()
    }

    Logger('QUEUE', '[Process] Очередь пуста. Ожидание новых элементов.')
    } finally {
    isProcessing = false
    // Пока мы работали, кто-то стучался в очередь. Гоняем ещё круг через
    // общее окно сбора, а не напрямую: рекурсии нет, лишний холостой прогон
    // стоит один Logger-вызов.
    if (rerunRequested) {
      rerunRequested = false
      scheduleDispatch()
    }
  }
}

/** Пачка тайтлов: один запрос в AniList на до 40 штук, дальше — поштучно в Shikimori. */
async function processMediaBatch(): Promise<void> {
  const ids = pickBatch('MED2', MEDIA_BATCH)

  let rows: AniListMediaRow[] = []
  try {
    const res = await anilistQuery<{ Page?: { media?: AniListMediaRow[] } }>(MEDIA_QUERY, { ids })
    rows = res.data?.Page?.media ?? []
  } catch (e) {
    Logger('ERROR', 'Перевод названий: сбой запроса к AniList', e)
    ids.forEach((id) => requeue('MED2', id))
    return
  }

  // AniList мог не вернуть часть строк. Молча забыть их нельзя: элемент помечен
  // как поставленный в очередь и сам себя больше не предложит.
  const returned = new Set(rows.map((row) => row.id))
  for (const id of ids) {
    if (!returned.has(id)) requeue('MED2', id)
  }

  for (const row of rows) {
    try {
      await dbSet('malCache', { id: row.id, data: row as AniListMedia })

      const resolved = row.idMal ? await resolveTitle(row.idMal, row.type) : null
      const payload: TranslationPayload = resolved
        ? {
            ru: resolved.russian,
            desc: resolved.description
              ? cleanShikiBB(resolved.description, resolved.url, resolved.sourceName)
              : undefined,
          }
        : { ru: NOT_FOUND }

      await dbSet('shikiCache', { key: `MED2_${row.id}`, data: payload, ts: Date.now() })
      attempts.delete(`MED2_${row.id}`)
      applyTranslation('MED2', row.id, payload)
    } catch (e) {
      Logger('ERROR', `Перевод названия: сбой на id ${row.id}`, e)
      requeue('MED2', row.id)
    }
    // Паузы здесь нет: темп держит общий ограничитель внутри api-клиентов.
  }
}

/** Пачка персонажей или авторов: сначала поиск по ролям, потом по имени. */
async function processPersonBatch(kind: 'CHR2' | 'STF3'): Promise<void> {
  const cfg = PERSON_CONFIG[kind]
  const ids = pickBatch(kind, PERSON_BATCH)
  let rows: AniListPersonRow[] = []
  try {
    const res = await anilistQuery<{ Page?: Record<string, AniListPersonRow[] | undefined> }>(
      PERSON_QUERY[kind],
      { ids },
    )
    rows = res.data?.Page?.[cfg.gqlField] ?? []
  } catch (e) {
    Logger('ERROR', `Перевод имён (${kind}): сбой запроса к AniList`, e)
    ids.forEach((id) => requeue(kind, id))
    return
  }

  const returned = new Set(rows.map((row) => row.id))
  for (const id of ids) {
    if (!returned.has(id)) requeue(kind, id)
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue

    try {
      let person: {
        russian: string | null
        description: string | null
        link: string | null
      } | null = null

      // Путь 1: ч