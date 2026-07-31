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
//   1. Собственный троттлинг (sleep после каждого запроса плюс ручная пауза) заменён
//      общим ограничителем из rate-limit.ts. Режим теперь тот же, что у Shikimori:
//      источники стоят в одной цепочке резолва названий, и разная скорость означала
//      бы, что фоллбэк обгоняет основной источник и первым ловит блокировку. Оба зеркала
//      делят один бюджет: уход на anime365.ru не даёт права на второй темп.
//
//   2. Повтор после 429 ограничен MAX_RATE_RETRIES. Раньше была рекурсия без счётчика,
//      да ещё с двойным ожиданием: сначала sleep на пять секунд, потом повторный вызов
//      снова ждал ту же паузу — десять секунд на ровном месте.
//
//   3. Куки не шлём (credentials: 'omit'): API анонимный, а дефолтный 'include' у моста
//      уже один раз привёл к HTTP 400 Request Header Or Cookie Too Large на другом источнике.
//
// Уровни логов здесь были правильными изначально, поэтому в 3.8 под них подгонялся
// shikimori.ts, а не наоборот: WARN — источник жив, но сейчас не отвечает; ERROR —
// источник потерян совсем. Добавлен лишь явный лог на исход «ответил, но данных нет»:
// раньше 404 и пустой ответ возвращали null молча, и в журнале это было неотличимо
// от «запрос вообще не делался».

import { Bridge } from '@/bridge'
import { ANIME365_DOMAINS, ANIME365_FAIL_LIMIT } from '../core/constants'
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

let anime365FailStreak = 0
let anime365Disabled = false

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
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

  for (const domain of ANIME365_DOMAINS) {
    try {
      // Слот берём перед каждой отправкой: ограничитель сам учтёт и интервал,
      // и окно, и действующую паузу после 429 или бэкоффа.
      await anime365Limiter.acquireSlot()

      const res = await Bridge.http.request({
        method: 'GET',
        url: mirrorUrl(domain, `/api/series?myAnimeListId=${malId}&limit=1`),
        timeoutMs: MIRROR_TIMEOUT_MS,
        credentials: 'omit',
      })

      if (res.status === 429) {
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
      // Сеть, таймаут (BridgeHttpError), неизвестный код или битый JSON.
      anime365FailStreak++
      Logger(
        'WARN',
        `Сбой запроса к зеркалу anime365: ${domain} (${String(e)}). ` +
          `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}.`,
      )
      registerFailure()
    }
  }

  Logger('ERROR', `Все зеркала anime365 недоступны для malId=${malId}`)
  return null
}
