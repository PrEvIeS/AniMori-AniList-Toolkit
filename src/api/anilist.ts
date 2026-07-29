// Пункт 1.4 плана: клиент AniList GraphQL (строки 1607-1677 монолита).
//
// alRateLimitPause был глобальной переменной IIFE — теперь это приватное состояние
// модуля. Пауза общая на все запросы AniList, что и требуется: лимит серверный.
//
// Этап 3: GM_xmlhttpRequest здесь заменится на bridge.http.request(). Форма ответа
// (status / responseText / responseHeaders) уже совпадает с планируемым HttpResponse.

import { IS_ANILIST } from '../core/constants'
import { Logger } from '../utils/logger'

/** Unix-время, до которого запросы к AniList приостановлены после 429. */
let alRateLimitPause = 0

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
    await new Promise((r) =>
      setTimeout(r, alRateLimitPause - Date.now() + Math.floor(Math.random() * 500)),
    )
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

  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://graphql.anilist.co',
      headers,
      data: JSON.stringify({ query, variables }),
      onload: (res) => {
        if (res.status === 200) {
          const timeTaken = Math.round(performance.now() - startTime)
          Logger('API', `[DONE] GraphQL запрос (AniList) выполнен за ${timeTaken}ms`)
          const payload = JSON.parse(res.responseText) as GraphQLResponse<T>
          if (payload.errors) {
            const message = JSON.stringify(payload.errors)
            Logger('ERROR', 'AniList GraphQL Error', payload.errors)
            reject(new Error(`AniList GraphQL Error: ${message}`))
            return
          }
          resolve(payload)
        } else if (res.status === 429) {
          const match = res.responseHeaders?.match(/retry-after:\s*(\d+)/i)
          const waitTime = match?.[1] ? parseInt(match[1]) * 1000 : 5000
          alRateLimitPause = Date.now() + waitTime + 500
          Logger('ERROR', `AniList Rate Limit 429! Ожидание ${waitTime}ms`, res)
          // Повтор после паузы (429)
          setTimeout(
            () => resolve(anilistQuery<T>(query, variables, useAuth)),
            waitTime + 500 + Math.floor(Math.random() * 500),
          )
        } else {
          Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.responseText)
          reject(new Error(`Error ${res.status}`))
        }
      },
      onerror: (e) => {
        Logger('ERROR', 'AniList Network Error', e)
        reject(new Error('AniList Network Error'))
      },
    })
  })
}
