// Пункт 1.4 плана: REST-клиент Shikimori (строки 1680-1723 монолита).
//
// Перебор зеркал: 404 не считается ответом, потому что тайтл может быть удалён
// по требованию РКН на основном домене и жив на .rip. Поэтому 404 запоминается
// как lastNotFound и отдаётся только если все зеркала ответили так же.
//
// РИСК №2 из AUDITION.md: на Этапе 4 запросы к Shikimori из Rust не увидят куки
// WebView, и приватные эндпоинты (списки пользователя) начнут отдавать 401/403.
// Публичные карточки тайтлов, которые ходят через fetchShiki, от этого не страдают.

import { SHIKI_DOMAINS } from '../core/constants'
import { Logger } from '../utils/logger'

/** Unix-время, до которого запросы к Shikimori приостановлены после 429. */
let shikiRateLimitPause = 0

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
  if (Date.now() < shikiRateLimitPause) {
    await new Promise((r) =>
      setTimeout(r, shikiRateLimitPause - Date.now() + Math.floor(Math.random() * 500)),
    )
  }

  Logger('API', `Запрос к Shikimori API: ${path}`)
  let lastNotFound: ShikiResponse<T> | null = null

  for (const domain of SHIKI_DOMAINS) {
    try {
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
        await new Promise((r) => setTimeout(r, 5000 + Math.floor(Math.random() * 1000)))
        return fetchShiki<T>(path) // рекурсивный повтор (429)
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
