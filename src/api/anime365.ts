// Пункт 1.4 плана: клиент anime365 / smotret-anime (строки 1726-1800 монолита).
//
// Источник нестабилен: отдаёт 403 и коды Cloudflare 520-524 под нагрузкой. Поэтому
// здесь три уровня защиты:
//   1) троттлинг общим ограничителем темпа;
//   2) бэкофф 15 секунд на soft-block;
//   3) полное отключение источника на сессию после ANIME365_FAIL_LIMIT сбоев подряд.
//
// Счётчик и флаг приватные, наружу отдаются только геттеры — так UI не сможет
// случайно сбросить бэкофф.
//
// Пункт 3.5.2: транспорт переведён с GM_xmlhttpRequest на Bridge.http. Защита осталась
// в этом файле: мост знает только про HTTP, а «403 — это блокировка, а не отсутствие
// данных» — знание прикладное. Код вне 2xx мост исключением не считает, поэтому ветки
// по статусам стоят явными проверками.
//
// Пункт 3.8, три изменения:
//
//   1. Собственный троттлинг заменён общим ограничителем из rate-limit.ts. Оба зеркала
//      делят один бюджет: уход на anime365.ru не даёт права на второй темп.
//
//   2. Повтор после 429 ограничен MAX_RATE_RETRIES. Раньше была рекурсия без счётчика,
//      да ещё с двойным ожиданием паузы.
//
//   3. Куки не шлём (credentials: 'omit'): API анонимный.
//
// Этап 5, итерация 5.1: каждое зеркало учтено в core/net-health.ts ОТДЕЛЬНО: смысл
// резервного адреса ровно в том, что он может быть жив когда первый мёртв, и обратно.
// Прикладная логика не тронута: те же статусы soft-block, тот же бэкофф, тот же
// счётчик сбоев и те же возвраты. Собственный счётчик anime365FailStreak НЕ заменён
// на net-health: он управляет отключением источника на сессию, а net-health ничем
// не управляет и только наблюдает.
//
// Уровни логов: WARN — источник жив, но сейчас не отвечает; ERROR — источник потерян
// совсем. Исход «ответил, но данных нет» тоже пишется явно.
//
// Этап 5, итерация 5.2.3 — четыре правки по итогам замеров (диагноз в STAGE-5-PART-03).
// Симптом: отдельные тайтлы уходили в отказ целиком по таймауту обоих зеркал, после
// чего всё оживало само. Причина оказалась не в сети, а в нашей расточительности.
//
//   1. Запрашиваем только нужные поля. Полная запись по malId=21 — 229 063 б и 1158 мс,
//      она же с fields=titles,url,descriptions — 2 515 б и 205 мс. Из записи нам нужны
//      ровно три поля, всё остальное — списки эпизодов и переводов. Поэтому и спотыкались
//      самые толстые сериалы: чем больше серий и озвучек, тем дольше сервер собирает ответ.
//      ВАЖНО при правке: форма ответа обязана остаться той же (data[0].titles.ru,
//      data[0].url, data[0].descriptions[].value) — иначе разбор отвалится молча.
//
//   2. Одна повторная попытка по молчанию. Только на транспортный сбой и таймаут: ответ
//      с любым кодом — это факт, повторять запрос ради того же факта значит впустую жечь
//      бюджет темпа. Слот у ограничителя повтор берёт заново.
//
//   3. Счётчик сбоев считает ВЫЗОВЫ, а не адреса. Раньше он накручивался внутри цикла по
//      зеркалам, поэтому одно спотыкание давало +2 из пяти, и три неудачных тайтла гасили
//      работоспособный источник до перезапуска. Предел и бэкофф не менялись, изменилась
//      только единица учёта.
//
//   4. Отсрочка молчащего зеркала на 10 минут. Держится в памяти и НЕ пишется в хранилище
//      по той же причине, по которой не пишется предпочтённое зеркало Shikimori:
//      доступность адреса — свойство сети вокруг человека прямо сейчас, а не его настройка.
//      Если отложены все зеркала, перебор идёт по полному списку: иначе одна минута плохой
//      связи выключила бы русские названия до перезапуска.

import { Bridge, BridgeHttpError } from '@/bridge'
import { ANIME365_DOMAINS, ANIME365_FAIL_LIMIT } from '../core/constants'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import { MAX_RATE_RETRIES, anime365Limiter } from './rate-limit'
import type { MediaType } from '../core/types'

/** Коды soft-block: источник жив, но временно не отдаёт данные. */
const BLOCKED_STATUSES = [403, 502, 503, 520, 521, 522, 523, 524]

/** Штрафная пауза после 429. */
const RATE_PAUSE_MS = 5000
/** Бэкофф после soft-block. */
const BACKOFF_MS = 15000
/** Таймаут одного зеркала. */
const MIRROR_TIMEOUT_MS = 5000

/**
 * Поля записи, которые нам действительно нужны. Описания оставлены сознательно:
 * они идут на медиа-страницу, а разница между 150 б и 2,5 КБ ни на что не влияет.
 */
const SERIES_FIELDS = 'titles,url,descriptions'

/** Сколько раз повторяем запрос к молчащему зеркалу, прежде чем идти к следующему. */
const SILENCE_RETRIES = 1

/** После скольких молчаний подряд адрес откладывается. */
const SILENCE_DEFER_LIMIT = 2

/** На сколько откладывается молчащее зеркало. */
const MIRROR_DEFER_MS = 10 * 60 * 1000

let anime365FailStreak = 0
let anime365Disabled = false

/** Молчания подряд по каждому адресу. Любой ответ обнуляет. */
const silenceStreak = new Map<string, number>()

/** До какого времени адрес отложен. Только в памяти, в хранилище не попадает. */
const deferredUntil = new Map<string, number>()

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

/**
 * Имя источника для учёта доступности конкретного зеркала.
 * Собирается здесь, а не в net-health: тот модуль по замыслу не знает адресов.
 */
function netId(domain: string): string {
  return `anime365:${domain}`
}

/** Отключён ли источник до конца сессии (для отображения в настройках). */
export function isAnime365Disabled(): boolean {
  return anime365Disabled
}

/**
 * Активна ли пауза по лимиту или бэкоффу. Очередь перевода спрашивает это
 * наравне с Shikimori: расписание пачек должно учитывать оба источника цепочки.
 */
export function isAnime365RateLimited(): boolean {
  return anime365Limiter.isPaused()
}

/** Текущая серия сбоев подряд (для инспектора). */
export function getAnime365FailStreak(): number {
  return anime365FailStreak
}

/** Отложенные сейчас зеркала — для инспектора логгера. */
export function getAnime365DeferredDomains(): string[] {
  const now = Date.now()
  const list: string[] = []
  deferredUntil.forEach((until, domain) => {
    if (until > now) list.push(domain)
  })
  return list
}

/**
 * Порядок перебора: сначала не отложенные адреса. Если отложены все, идём по полному
 * списку — отсрочка страхует от лишнего ожидания, но не имеет права выключить источник.
 */
function pickDomains(): readonly string[] {
  const now = Date.now()
  const live = ANIME365_DOMAINS.filter((domain) => (deferredUntil.get(domain) ?? 0) <= now)
  return live.length > 0 ? live : ANIME365_DOMAINS
}

/** Адрес ответил: снимаем и счётчик молчаний, и отсрочку. */
function noteAnswer(domain: string): void {
  silenceStreak.delete(domain)
  if (deferredUntil.delete(domain)) {
    Logger('INFO', `anime365: зеркало ${domain} снова отвечает, отсрочка снята`)
  }
}

/** Адрес промолчал: копим счётчик и при переполнении откладываем. */
function noteSilence(domain: string): void {
  const streak = (silenceStreak.get(domain) ?? 0) + 1
  silenceStreak.set(domain, streak)

  if (streak < SILENCE_DEFER_LIMIT) return

  silenceStreak.set(domain, 0)
  deferredUntil.set(domain, Date.now() + MIRROR_DEFER_MS)
  Logger(
    'WARN',
    `anime365: зеркало ${domain} молчало ${SILENCE_DEFER_LIMIT} раза подряд — ` +
      `отложено на ${MIRROR_DEFER_MS / 60000} мин.`,
  )
}

/**
 * Молчание, а не отказ: сеть не дошла или ответа не дождались. Повторять осмысленно
 * только такое. Отмену (`abort`) сюда не включаем — это наше собственное поведение.
 */
function isSilence(e: unknown): boolean {
  return e instanceof BridgeHttpError && (e.kind === 'network' || e.kind === 'timeout')
}

/** Наша отмена при уходе со страницы: ни сбой источника, ни повод для повтора. */
function isAbort(e: unknown): boolean {
  return e instanceof BridgeHttpError && e.kind === 'abort'
}

/** Общая реакция на серию сбоев: бэкофф и, при переполнении счётчика, отключение. */
function registerFailure(): void {
  if (anime365FailStreak < ANIME365_FAIL_LIMIT) return
  anime365Disabled = true
  anime365Limiter.pause(BACKOFF_MS)
  Logger(
    'ERROR',
    'anime365 отключён на эту сессию после серии сбоев — цепочка уходит на фоллбэк/оригинал.',
  )
}

export interface Anime365Title {
  russian: string
  description: string
  url: string
  domain: string
}

interface Anime365Series {
  titles?: { ru?: string }
  descriptions?: Array<{ value?: string }>
  url?: string
}

/**
 * Грузит русский тайтл и описание с anime365 по MAL ID. Только аниме.
 * @param attempt Номер попытки после 429, считая с нуля. Служебный параметр рекурсии.
 * @returns null при отсутствии данных, soft-block или сбое всех зеркал.
 */
export async function fetchAnime365ByMal(
  malId: number | null,
  type: MediaType,
  attempt = 0,
): Promise<Anime365Title | null> {
  if (!malId || type === 'MANGA') return null // только аниме
  if (anime365Disabled) return null // отключён на сессию

  Logger('API', `Запрос к anime365 API: myAnimeListId=${malId}`)

  // Сбой этого вызова, а не отдельного адреса: счётчик накручивается один раз в конце,
  // сколько бы зеркал ни промолчало по дороге.
  let callFailed = false

  for (const domain of pickDomains()) {
    for (let tryNo = 0; tryNo <= SILENCE_RETRIES; tryNo++) {
      // Замер на каждую попытку свой и включает ожидание слота.
      const startedAt = Date.now()

      try {
        // Слот берём перед каждой отправкой: ограничитель сам учтёт и интервал,
        // и окно, и действующую паузу после 429 или бэкоффа.
        await anime365Limiter.acquireSlot()

        const res = await Bridge.http.request({
          method: 'GET',
          url: mirrorUrl(
            domain,
            `/api/series?myAnimeListId=${malId}&limit=1&fields=${SERIES_FIELDS}`,
          ),
          timeoutMs: MIRROR_TIMEOUT_MS,
          credentials: 'omit',
        })

        // Отчёт до разбора кодов, одним вызовом на все ветки: 403 и 5xx net-health
        // различит сам, 429 пропустит, 404 сочтёт признаком живой связи.
        reportStatus(netId(domain), `anime365 (${domain})`, res.status, Date.now() - startedAt)

        if (res.status === 429) {
          noteAnswer(domain) // ответ пришёл: адрес жив, дело в темпе
          anime365Limiter.pause(RATE_PAUSE_MS)

          if (attempt + 1 >= MAX_RATE_RETRIES) {
            Logger('ERROR', `anime365: лимит 429 не отпустил, запрос отменён (malId=${malId})`, {
              domain,
              attempts: attempt + 1,
            })
            return null // -> resolveTitle: фоллбэк
          }

          Logger(
            'WARN',
            `anime365 429 (${domain}): пауза ${RATE_PAUSE_MS}мс, ` +
              `повтор ${attempt + 2}/${MAX_RATE_RETRIES} — malId=${malId}`,
          )
          // Повтор сам дождётся конца паузы в acquireSlot() — второго sleep не нужно.
          return fetchAnime365ByMal(malId, type, attempt + 1)
        }

        // 403/503 + Cloudflare (520-524) — soft-block, а не «нет данных».
        if (BLOCKED_STATUSES.includes(res.status)) {
          noteAnswer(domain) // отказал осознанно, значит на связи
          anime365FailStreak++
          anime365Limiter.pause(BACKOFF_MS)
          Logger(
            'WARN',
            `anime365 недоступен: HTTP ${res.status} (${domain}). ` +
              `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}, бэкофф ${BACKOFF_MS}мс.`,
          )
          registerFailure()
          return null // -> resolveTitle: фоллбэк
        }

        noteAnswer(domain)

        // Всё прочее, кроме 200 и 404, уходит в catch этого же зеркала.
        if (res.status !== 200 && res.status !== 404) {
          throw new Error(`anime365 HTTP ${res.status}`)
        }

        anime365FailStreak = 0 // успех или 404 — сброс

        // 404 — источник ответил, данных просто нет.
        if (res.status === 404) {
          Logger('WARN', `anime365: тайтл не найден (404, ${domain}): malId=${malId}`)
          return null
        }

        const body = JSON.parse(res.text) as { data?: Anime365Series[] }
        const item = body.data?.[0]
        if (item) {
          let desc = ''
          if (Array.isArray(item.descriptions)) {
            const d = item.descriptions.find((x) => x && x.value)
            if (d?.value) desc = d.value
          }
          return {
            russian: item.titles?.ru ?? '',
            description: desc,
            url: item.url || mirrorUrl(domain, '/'),
            domain,
          }
        }

        // 200, но пусто: тоже штатный исход, но в журнале он должен быть виден.
        Logger('WARN', `anime365: пустой ответ без данных (${domain}): malId=${malId}`)
        return null
      } catch (e) {
        // Уход со страницы: перебор прекращаем, сбоем не считаем.
        if (isAbort(e)) {
          Logger('WARN', `anime365: запрос отменён (${domain}): malId=${malId}`)
          return null
        }

        // Состояние меняют только транспортный сбой и таймаут; ответ со статусом
        // уже учтён выше, а битый JSON net-health пропустит сам.
        reportError(netId(domain), `anime365 (${domain})`, e, Date.now() - startedAt)

        if (isSilence(e)) {
          noteSilence(domain)

          if (tryNo < SILENCE_RETRIES) {
            Logger(
              'WARN',
              `anime365: зеркало ${domain} промолчало (${String(e)}), ` +
                `повторная попытка — malId=${malId}`,
            )
            continue // тот же адрес, новый слот
          }

          Logger(
            'WARN',
            `anime365: зеркало ${domain} молчит после ${SILENCE_RETRIES + 1} попыток ` +
              `(${String(e)}) — malId=${malId}`,
          )
          callFailed = true
          break // следующее зеркало
        }

        // Ответ был, но сломался разбор или пришёл неизвестный код: повторять нечего.
        Logger('WARN', `Сбой запроса к зеркалу anime365: ${domain} (${String(e)})`)
        callFailed = true
        break
      }
    }
  }

  if (callFailed) {
    anime365FailStreak++
    Logger(
      'ERROR',
      `Все зеркала anime365 недоступны для malId=${malId}. ` +
        `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}.`,
    )
    registerFailure()
  }

  return null
}
