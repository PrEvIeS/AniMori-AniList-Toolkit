// Пункт 1.4 плана: REST-клиент Shikimori (строки 1680-1723 монолита).
//
// Перебор зеркал: 404 не считается ответом, потому что тайтл может быть удалён
// по требованию РКН на основном домене и жив на .rip. Поэтому 404 запоминается
// как lastNotFound и отдаётся только если все зеркала ответили так же.
//
// РИСК №2 из AUDITION.md: на Этапе 4 запросы к Shikimori из Rust не увидят куки
// WebView, и приватные эндпоинты (списки пользователя) начнут отдавать 401/403.
// Публичные карточки тайтлов, которые ходят через fetchShiki, от этого не страдают.
//
// АУДИТ (итерация 10): в журнале за 166 секунд оказался 131 запрос к Shikimori,
// пик 5 запросов в секунду при лимите 5 и 83 в минуту при лимите 90. Очередь перевода
// работала вплотную к потолку, ловила 429 и вставала на штрафные паузы по 5 секунд.
// Раньше пауза ставилась ТОЛЬКО задним числом, после отказа. Теперь запросы проходят
// через шлюз acquireSlot(), который разводит их во времени заранее.

import { SHIKI_DOMAINS } from '../core/constants'
import { Logger } from '../utils/logger'

/** Unix-время, до которого запросы к Shikimori приостановлены после 429. */
let shikiRateLimitPause = 0

/** Минимальный промежуток между стартами запросов: 5 в секунду - потолок API. */
const MIN_INTERVAL_MS = 300
/** Скользящее окно учёта: лимит Shikimori - 90 запросов в минуту. */
const RATE_WINDOW_MS = 60000
/** Держимся ниже потолка: 90 - это отказ, 60 - рабочий режим с запасом. */
const MAX_PER_WINDOW = 60

/** Время последнего отправленного запроса. */
let lastSentAt = 0
/** Отметки отправок за последнее окно. */
const recentSends: number[] = []
/**
 * Очередь ожидающих: шлюз пропускает по одному, чтобы два параллельных вызова
 * не заняли один и тот же слот. Сам запрос после выдачи слота идёт своим ходом.
 */
let gate: Promise<void> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Активна ли сейчас пауза по лимиту Shikimori.
 * Очередь перевода проверяет это перед каждой пачкой.
 */
export function isShikimoriRateLimited(): boolean {
  return Date.now() < shikiRateLimitPause
}

/** Ставит паузу вручную (например, 429 увидел поиск персон). */
export function pauseShikimori(ms: number): void {
  shikiRateLimitPause = Math.max(shikiRateLimitPause, Date.now() + ms)
}

/**
 * Ждёт своей очереди на отправку. Учитывает три ограничения сразу:
 * минимальный интервал, потолок в минуту и действующую паузу после 429.
 */
async function acquireSlot(): Promise<void> {
  const previous = gate
  let release: () => void = () => undefined
  gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous

  try {
    for (;;) {
      const now = Date.now()

      // Чистим отметки, вышедшие за окно.
      while (recentSends.length > 0 && now - (recentSends[0] ?? 0) >= RATE_WINDOW_MS) {
        recentSends.shift()
      }

      const waits: number[] = []
      const sinceLast = now - lastSentAt
      if (sinceLast < MIN_INTERVAL_MS) waits.push(MIN_INTERVAL_MS - sinceLast)
      if (now < shikiRateLimitPause) waits.push(shikiRateLimitPause - now)
      if (recentSends.length >= MAX_PER_WINDOW) {
        waits.push(RATE_WINDOW_MS - (now - (recentSends[0] ?? now)) + 50)
      }

      if (waits.length === 0) {
        lastSentAt = Date.now()
        recentSends.push(lastSentAt)
        return
      }

      await sleep(Math.max(...waits))
    }
  } finally {
    // Освобождаем шлюз сразу после выдачи слота: ответа ждать не нужно,
    // иначе один медленный запрос застопорит всю очередь.
    release()
  }
}

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

export interface ShikiResponse<T = unknown> {
  /** null означает "не найдено" либо полный сбой всех зеркал. */
  data: T | null
  /** Домен зеркала, ответившего успешно. */
  domain: string | null
}

type Attempt<T> = { data: T | null; domain: string; notFound?: boolean } | { rateLimited: true }

/**
 * GET к Shikimori REST с перебором зеркал и повтором при 429.
 * @param path Путь вида `/api/animes/123`, без домена.
 */
export async function fetchShiki<T = unknown>(path: string): Promise<ShikiResponse<T>> {
  Logger('API', `Запрос к Shikimori API: ${path}`)
  let lastNotFound: ShikiResponse<T> | null = null

  for (const domain of SHIKI_DOMAINS) {
    try {
      // Слот берём перед каждой реальной отправкой, включая перебор зеркал.
      await acquireSlot()

      const res = await new Promise<Attempt<T>>((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: mirrorUrl(domain, path),
          timeout: 5000,
          onload: (r) => {
            if (r.status === 200) resolve({ data: JSON.parse(r.responseText) as T, domain })
            else if (r.status === 429) {
              shikiRateLimitPause = Date.now() + 5000
              resolve({ rateLimited: true })
            } else if (r.status === 404) resolve({ data: null, domain, notFound: true })
            else reject(new Error(`Shikimori HTTP ${r.status}`))
          },
          onerror: reject,
          ontimeout: reject,
        })
      })

      if ('rateLimited' in res) {
        Logger('ERROR', `Shikimori Rate Limit 429 (${domain})! Пауза.`)
        // Повтор пойдёт через шлюз и сам дождётся конца паузы.
        return fetchShiki<T>(path)
      }

      // 404: возможно удалён по РКН — пробуем следующее зеркало (напр. .rip).
      if (res.notFound) {
        lastNotFound = { data: null, domain: res.domain }
        continue
      }

      return res
    } catch (e) {
      Logger('ERROR', `Ошибка запроса к зеркалу Shiki: ${domain}`, e)
    }
  }

  if (lastNotFound) return lastNotFound
  throw new Error(`Все зеркала Shikimori недоступны для ${path}`)
}
