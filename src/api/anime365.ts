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

import { ANIME365_DOMAINS, ANIME365_FAIL_LIMIT, ANIME365_THROTTLE } from '../core/constants'
import { Logger } from '../utils/logger'
import type { MediaType } from '../core/types'

let anime365RateLimitPause = 0
let anime365FailStreak = 0
let anime365Disabled = false

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

type Attempt =
  | { ok: true; body: { data?: Anime365Series[] } | null }
  | { rateLimited: true }
  | { blocked: true; status: number }

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
    await new Promise((r) =>
      setTimeout(r, anime365RateLimitPause - Date.now() + Math.floor(Math.random() * 500)),
    )
  }

  Logger('API', `Запрос к anime365 API: myAnimeListId=${malId}`)

  for (const domain of ANIME365_DOMAINS) {
    try {
      const res = await new Promise<Attempt>((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `https://${domain}/api/series?myAnimeListId=${malId}&limit=1`,
          timeout: 5000,
          onload: (r) => {
            if (r.status === 200)
              resolve({ ok: true, body: JSON.parse(r.responseText) as { data?: Anime365Series[] } })
            else if (r.status === 404) resolve({ ok: true, body: null })
            else if (r.status === 429) resolve({ rateLimited: true })
            // 403/503 + Cloudflare (520-524) — soft-block, а не «нет данных».
            else if ([403, 502, 503, 520, 521, 522, 523, 524].includes(r.status))
              resolve({ blocked: true, status: r.status })
            else reject(new Error(`anime365 HTTP ${r.status}`))
          },
          onerror: reject,
          ontimeout: reject,
        })
      })

      // Пауза между запросами (cache-miss)
      await new Promise((r) => setTimeout(r, ANIME365_THROTTLE))

      if ('rateLimited' in res) {
        anime365RateLimitPause = Date.now() + 5000
        Logger('WARN', `anime365 Rate Limit 429 (${domain}). Пауза 5с.`)
        await new Promise((r) => setTimeout(r, 5000 + Math.floor(Math.random() * 1000)))
        return fetchAnime365ByMal(malId, type) // рекурсивный повтор (429)
      }

      if ('blocked' in res) {
        anime365FailStreak++
        anime365RateLimitPause = Date.now() + 15000 // бэкофф
        Logger(
          'WARN',
          `anime365 недоступен: HTTP ${res.status} (${domain}). ` +
            `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}, бэкофф 15с.`,
        )
        if (anime365FailStreak >= ANIME365_FAIL_LIMIT) {
          anime365Disabled = true
          Logger(
            'ERROR',
            'anime365 отключён на эту сессию после серии сбоев — цепочка уходит на фоллбэк/оригинал.',
          )
        }
        return null // -> resolveTitle: фоллбэк
      }

      anime365FailStreak = 0 // успех или 404 — сброс

      const item = res.body?.data?.[0]
      if (item) {
        let desc = ''
        if (Array.isArray(item.descriptions)) {
          const d = item.descriptions.find((x) => x && x.value)
          if (d?.value) desc = d.value
        }
        return {
          russian: item.titles?.ru ?? '',
          description: desc,
          url: item.url || `https://${domain}/`,
          domain,
        }
      }
      return null // 200, но пусто
    } catch (e) {
      anime365FailStreak++
      Logger(
        'WARN',
        `Сбой запроса к зеркалу anime365: ${domain} (${String(e)}). ` +
          `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}.`,
      )
      if (anime365FailStreak >= ANIME365_FAIL_LIMIT) {
        anime365Disabled = true
        anime365RateLimitPause = Date.now() + 15000
        Logger(
          'ERROR',
          'anime365 отключён на эту сессию после серии сбоев — цепочка уходит на фоллбэк/оригинал.',
        )
      }
    }
  }

  return null
}
