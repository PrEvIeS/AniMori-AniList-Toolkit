// Пункт 1.4 плана: клиент AnimeThemes.moe (строки 1834-1900 монолита).
//
// Единственный API в проекте без ключа и без зеркал, зато с обязательным кэшем:
// ответы кладутся в shikiCache под ключом THEMES2_<malId> и живут CACHE_TIME.
// Пустой результат тоже кэшируется — иначе тайтлы без тем дёргали бы API каждый раз.

import { CACHE_TIME } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { Logger } from '../utils/logger'
import type { ShikiCacheRecord } from '../core/types'

export interface ThemeItem {
  seq: string
  title: string
  artist: string
}

export interface MalThemes {
  openings: ThemeItem[]
  endings: ThemeItem[]
}

interface AnimeThemesSong {
  title?: string
  artists?: Array<{ name?: string }>
}

interface AnimeThemesEntry {
  type?: string
  slug?: string
  song?: AnimeThemesSong
}

interface AnimeThemesResponse {
  anime?: Array<{ animethemes?: AnimeThemesEntry[] }>
}

/** Грузит опенинги и эндинги по MAL ID. Кэш — shikiCache, ключ THEMES2_<malId>. */
export async function fetchMalThemes(malId: number | null): Promise<MalThemes | null> {
  if (!malId) return null

  const cacheKey = `THEMES2_${malId}`
  const cached = await dbGet<ShikiCacheRecord<MalThemes>>('shikiCache', cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TIME) return cached.data

  Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`)

  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url:
        'https://api.animethemes.moe/anime?filter[has]=resources&filter[site]=MyAnimeList' +
        `&filter[external_id]=${malId}&include=animethemes.song.artists`,
      onload: (res) => {
        if (res.status === 200) {
          try {
            const data = JSON.parse(res.responseText) as AnimeThemesResponse
            const animeList = data.anime ?? []

            // Не найдено — кэшируем пустой результат.
            if (animeList.length === 0) {
              const emptyData: MalThemes = { openings: [], endings: [] }
              void dbSet('shikiCache', { key: cacheKey, data: emptyData, ts: Date.now() })
              resolve(emptyData)
              return
            }

            const themes = animeList[0]?.animethemes ?? []
            const formattedData: MalThemes = { openings: [], endings: [] }

            themes.forEach((t) => {
              const song = t.song ?? {}
              const slug = t.slug ?? ''
              const title = song.title || slug
              const artist = (song.artists ?? [])
                .map((a) => a.name)
                .filter(Boolean)
                .join(', ')
              const seq = slug.replace(/[^0-9]/g, '') || '1'
              const item: ThemeItem = { seq, title, artist }

              if (t.type === 'OP') formattedData.openings.push(item)
              else if (t.type === 'ED') formattedData.endings.push(item)
            })

            void dbSet('shikiCache', { key: cacheKey, data: formattedData, ts: Date.now() })
            resolve(formattedData)
          } catch (e) {
            Logger('ERROR', 'Ошибка парсинга AnimeThemes', e)
            resolve(null)
          }
        } else if (res.status === 429) {
          Logger('ERROR', 'AnimeThemes Rate Limit 429! Повторная попытка...')
          setTimeout(() => resolve(fetchMalThemes(malId)), 1500 + Math.floor(Math.random() * 500))
        } else {
          Logger('ERROR', `AnimeThemes Error HTTP ${res.status}`)
          resolve(null)
        }
      },
      onerror: (e) => {
        Logger('ERROR', 'AnimeThemes Network Error', e)
        resolve(null)
      },
    })
  })
}
