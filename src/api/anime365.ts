// Пункт 1.4 плана: клиент anime365 / smotret-anime (строки 1726-1800 монолита).
//
// Источник нестабилен: отдаёт 403 и коды Cloudflare 520-524 под нагрузкой. Поэтому
// здесь три уровня защиты, все три перенесены 1:1:
//   1) троттлинг ANIME365_THROTTLE между запросами;
//   2) бэкофф 15 секунд на soft-block;
//   3) полное отключение источника на сессию после ANIME365_FAIL_LIMIT сбоев подряд.
//
// Счётчик и флаг были глобальными переменными IIFE. Теперь они приватные, а наружу
// отдаются только геттеры — так UI не сможет случайно сбросить бэкофф.
//
// Пункт 3.5.2: транспорт переведён с GM_xmlhttpRequest на Bridge.http. Обёртка
// new Promise + onload/onerror/ontimeout больше не нужна, вместе с ней ушёл и
// внутренний тип Attempt: коды ответа разбираются там же, где они пришли.
//
// Вся защита осталась в этом файле и НЕ переехала в мост: мост знает только про
// HTTP, а «403 — это блокировка, а не отсутствие данных» — знание прикладное.
// Важное свойство моста: код вне 2xx исключением не считается, ответ возвращается
// как обычный результат. Поэтому ветки по статусам стоят явными проверками, иначе
// soft-block молча превратился бы в «данных нет», и цепочка названий перестала бы
// уходить на фоллбэк.

import { Bridge } from '@/bridge'
import { ANIME365_DOMAINS, ANIME365_FAIL_LIMIT, ANIME365_THROTTLE } from '../core/constants'
import { Logger } from '../utils/logger'
import type { MediaType } from '../core/types'

/** Коды soft-block: источник жив, но временно не отдаёт данные. */
const BLOCKED_STATUSES = [403, 502, 503, 520, 521, 522, 523, 524]

let anime365RateLimitPause = 0
let anime365FailStreak = 0
let anime365Disabled = false

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Отключён ли источник до конца сессии (для отображения в настройках). */
export function isAnime365Disabled(): boolean {
  return anime365Disabled
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
  anime365RateLimitPause = Date.now() + 15000
  Logger(
    'ERROR',
    'anime365 отключён на эту сессию после серии сбоев — цепочка уходит на фоллбэк/оригинал.',
  )
}

/**
 * Грузит русский тайтл и описание с anime365 по MAL ID. Только аниме.
 * @returns null при отсутствии данных, soft-block или сбое всех зеркал.
 */
export async function fetchAnime365ByMal(
  malId: number | null,
  type: MediaType,
): Promise<Anime365Title | null> {
  if (!malId || type === 'MANGA') return null // только аниме
  if (anime365Disabled) return null // отключён на сессию

  if (Date.now() < anime365RateLimitPause) {
    await sleep(anime365RateLimitPause - Date.now() + Math.floor(Math.random() * 500))
  }

  Logger('API', `Запрос к anime365 API: myAnimeListId=${malId}`)

  for (const domain of ANIME365_DOMAINS) {
    try {
      const res = await Bridge.http.request({
        method: 'GET',
        url: mirrorUrl(domain, `/api/series?myAnimeListId=${malId}&limit=1`),
        timeoutMs: 5000,
      })

      // Пауза между запросами (cache-miss)
      await sleep(ANIME365_THROTTLE)

      if (res.status === 429) {
        anime365RateLimitPause = Date.now() + 5000
        Logger('WARN', `anime365 Rate Limit 429 (${domain}). Пауза 5с.`)
        await sleep(5000 + Math.floor(Math.random() * 1000))
        return fetchAnime365ByMal(malId, type) // рекурсивный повтор (429)
      }

      // 403/503 + Cloudflare (520-524) — soft-block, а не «нет данных».
      if (BLOCKED_STATUSES.includes(res.status)) {
        anime365FailStreak++
        anime365RateLimitPause = Date.now() + 15000 // бэкофф
        Logger(
          'WARN',
          `anime365 недоступен: HTTP ${res.status} (${domain}). ` +
            `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}, бэкофф 15с.`,
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
      const body = res.status === 200 ? (JSON.parse(res.text) as { data?: Anime365Series[] }) : null
      const item = body?.data?.[0]
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
      return null // 200, но пусто
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

  return null
}
