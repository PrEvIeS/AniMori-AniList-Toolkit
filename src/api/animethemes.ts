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
// Этап 4, два изменения по части темпа:
//
//   1. Запрос берёт слот у animeThemesLimiter. До этого модуль был последним сетевым
//      клиентом, ходившим в сеть мимо учёта вообще, вопреки правилу «любой новый
//      сетевой запрос берёт слот у api/rate-limit.ts». При быстром переборе карточек
//      это давало всплеск запросов без какого-либо интервала между ними.
//
//   2. Повтор после 429 ограничен MAX_RATE_RETRIES. Раньше было `return fetchMalThemes(malId)`
//      без счётчика: при устойчивом лимите вечный цикл по полторы секунды на виток,
//      причём молчаливый: виджет просто никогда не показывал темы.
//
// Контракт функции сохранён дословно: она НИКОГДА не отклоняется, а сообщает о любой
// неудаче значением null. На это опирается виджет тем (features/media/themes.ts):
// при null он оставляет свой блок скрытым и не запрашивает темы повторно.
// Отклоняйся функция — необработанный сбой сети всплыл бы в mount() виджета.
// Поэтому исчерпание повторов здесь тоже даёт null, а не RateLimitError, в отличие
// от shikimori.ts: там вызывающая сторона — очередь перевода, которой отказ нужен
// для учёта попыток, а здесь — виджет, которому достаточно остаться скрытым.
// Неудача по лимиту не кэшируется: через минуту данные будут доступны,
// и записывать пустоту на 90 дней из-за временной блокировки нельзя.

import { Bridge, type HttpResponse } from '@/bridge'
import { CACHE_TIME } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { Logger } from '../utils/logger'
import type { ShikiCacheRecord } from '../core/types'
import { MAX_RATE_RETRIES, animeThemesLimiter } from './rate-limit'

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

/**
 * Грузит опенинги и эндинги по MAL ID. Кэш — shikiCache, ключ THEMES2_<malId>.
 * @param malId Идентификатор MyAnimeList или null, если его не удалось разрешить.
 * @param attempt Номер попытки после 429, считая с нуля. Служебный параметр рекурсии.
 */
export async function fetchMalThemes(
  malId: number | null,
  attempt = 0,
): Promise<MalThemes | null> {
  if (!malId) return null

  const cacheKey = `THEMES2_${malId}`
  const cached = await dbGet<ShikiCacheRecord<MalThemes>>('shikiCache', cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TIME) return cached.data

  Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`)

  let res: HttpResponse
  try {
    // Слот берём перед каждой реальной отправкой, включая повторы после 429:
    // повтор — такой же запрос для счётчика окна, как и первая попытка.
    await animeThemesLimiter.acquireSlot()

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
    // Пауза на ограничителе, а не просто sleep: она притормозит и соседние
    // карточки, которые в этот момент уже стоят в очереди за своим слотом.
    const waitMs = RETRY_DELAY_MS + Math.floor(Math.random() * 500)
    animeThemesLimiter.pause(waitMs)

    if (attempt + 1 >= MAX_RATE_RETRIES) {
      Logger('ERROR', `AnimeThemes: лимит 429 не отпустил, темы не загружены (MAL ${malId})`, {
        attempts: attempt + 1,
      })
      // Не кэшируем: это временный отказ, а не отсутствие тем.
      return null
    }

    Logger(
      'WARN',
      `AnimeThemes 429: пауза ${waitMs}мс, повтор ${attempt + 2}/${MAX_RATE_RETRIES} — MAL ${malId}`,
    )
    // Повтор пойдёт через шлюз и сам дождётся конца паузы.
    return fetchMalThemes(malId, attempt + 1)
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
