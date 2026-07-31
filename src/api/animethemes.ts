// Пункт 1.4 плана: клиент AnimeThemes.moe (строки 1834-1900 монолита).
//
// Единственный API в проекте без ключа и без зеркал, зато с обязательным кэшем:
// ответы кладутся в shikiCache под ключом THEMES2_<malId> и живут CACHE_TIME.
// Пустой результат тоже кэшируется — иначе тайтлы без тем дёргали бы API каждый раз.
//
// Пункт 3.5.2: транспорт переведён с GM_xmlhttpRequest на Bridge.http, вложенные
// коллбэки заменены на async/await. Прикладная логика не тронута: тот же кэш,
// тот же повтор при 429, те же записи в журнал.
//
// Контракт функции сохранён дословно: она НИКОГДА не отклоняется, а сообщает о любой
// неудаче значением null. На это опирается виджет тем (features/media/themes.ts):
// при null он оставляет свой блок скрытым и не запрашивает темы повторно.
// Отклоняйся функция — необработанный сбой сети всплыл бы в mount() виджета.

import { Bridge, type HttpResponse } from '@/bridge'
import { CACHE_TIME } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { Logger } from '../utils/logger'
import type { ShikiCacheRecord } from '../core/types'

/** Базовый адрес собран конкатенацией: литерал схемы в шаблонной строке ломался при отправке. */
const API_BASE = 'https://api.animethemes.moe/anime'

/** Пауза перед повтором после 429. Джиттер разводит одновременные повторы. */
const RETRY_DELAY_MS = 1500

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Разбирает ответ API в списки опенингов и эндингов. */
function formatThemes(themes: AnimeThemesEntry[]): MalThemes {
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

  return formattedData
}

/** Грузит опенинги и эндинги по MAL ID. Кэш — shikiCache, ключ THEMES2_<malId>. */
export async function fetchMalThemes(malId: number | null): Promise<MalThemes | null> {
  if (!malId) return null

  const cacheKey = `THEMES2_${malId}`
  const cached = await dbGet<ShikiCacheRecord<MalThemes>>('shikiCache', cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TIME) return cached.data

  Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`)

  let res: HttpResponse
  try {
    res = await Bridge.http.request({
      method: 'GET',
      url:
        API_BASE +
        '?filter[has]=resources&filter[site]=MyAnimeList' +
        `&filter[external_id]=${malId}&include=animethemes.song.artists`,
    })
  } catch (e) {
    // Сюда приходит только транспортный сбой, таймаут или отмена (BridgeHttpError).
    // Раньше эту ветку закрывал коллбэк onerror.
    Logger('ERROR', 'AnimeThemes Network Error', e)
    return null
  }

  // Код вне 2xx мост исключением не считает, поэтому статусы разбираем сами —
  // ровно теми же тремя ветками, что были в onload.
  if (res.status === 429) {
    Logger('ERROR', 'AnimeThemes Rate Limit 429! Повторная попытка...')
    await sleep(RETRY_DELAY_MS + Math.floor(Math.random() * 500))
    return fetchMalThemes(malId)
  }

  if (res.status !== 200) {
    Logger('ERROR', `AnimeThemes Error HTTP ${res.status}`)
    return null
  }

  try {
    const data = JSON.parse(res.text) as AnimeThemesResponse
    const animeList = data.anime ?? []

    // Не найдено — кэшируем пустой результат.
    if (animeList.length === 0) {
      const emptyData: MalThemes = { openings: [], endings: [] }
      void dbSet('shikiCache', { key: cacheKey, data: emptyData, ts: Date.now() })
      return emptyData
    }

    const formattedData = formatThemes(animeList[0]?.animethemes ?? [])
    void dbSet('shikiCache', { key: cacheKey, data: formattedData, ts: Date.now() })
    return formattedData
  } catch (e) {
    Logger('ERROR', 'Ошибка парсинга AnimeThemes', e)
    return null
  }
}
