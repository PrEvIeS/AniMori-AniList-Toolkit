// Этап 1 п.1.8: Exporter — экспорт списков и избранного Shikimori → AniList (строки 2086-2503 монолита).
// WRITE-фича: создаёт/обновляет записи в AniList через GraphQL мутации.
// Модуль работает только на страницах Shikimori (не AniList).

import { Logger } from '../../utils/logger'
import { anilistQuery } from '../../api/anilist'

type ShikiStatus =
  | 'planned'
  | 'watching'
  | 'reading'
  | 'completed'
  | 'on_hold'
  | 'dropped'
  | 'rewatching'
  | 'rereading'
type AniListStatus = 'PLANNING' | 'CURRENT' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'REPEATING'
type ScoreFormat = 'POINT_100' | 'POINT_10_DECIMAL' | 'POINT_10' | 'POINT_5' | 'POINT_3'
type MediaType = 'anime' | 'manga'
type AniListMediaType = 'ANIME' | 'MANGA'

interface FuzzyDate {
  year?: number
  month?: number
  day?: number
}

interface ShikiUserRate {
  id: number
  target_id: number
  status: ShikiStatus
  score: number
  episodes?: number
  chapters?: number
  volumes?: number
  rewatches: number
  text: string
  created_at?: string
  updated_at?: string
  target?: { id: number }
}

interface ShikiFavItem {
  id: number
  name: string
  russian?: string
}

interface ShikiFavorites {
  animes?: ShikiFavItem[]
  mangas?: ShikiFavItem[]
  characters?: ShikiFavItem[]
  people?: ShikiFavItem[]
  seyu?: ShikiFavItem[]
  mangakas?: ShikiFavItem[]
  producers?: ShikiFavItem[]
}

interface AniListUser {
  id: number
  name: string
  mediaListOptions: {
    scoreFormat: ScoreFormat
  }
}

interface AniListEntry {
  mediaId: number
  status: AniListStatus
  score: number
  progress: number
  progressVolumes?: number
  repeat: number
  notes?: string
  startedAt?: FuzzyDate
  completedAt?: FuzzyDate
}

interface ExistingFavorites {
  anime: Set<number>
  manga: Set<number>
  characters: Set<number>
  staff: Set<number>
}

interface HistoryDates {
  start: Date | null
  end: Date | null
}

let exportFailures = 0

const mapStatusShikiToAL: Record<ShikiStatus, AniListStatus> = {
  planned: 'PLANNING',
  watching: 'CURRENT',
  reading: 'CURRENT',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  dropped: 'DROPPED',
  rewatching: 'REPEATING',
  rereading: 'REPEATING',
}

function convertScoreShikiToAL(score: number, format: ScoreFormat): number {
  if (!score) return 0
  switch (format) {
    case 'POINT_100':
    case 'POINT_10_DECIMAL':
      return score * 10
    case 'POINT_10':
      return score
    case 'POINT_5':
      return Math.round(score / 2)
    case 'POINT_3':
      return score >= 8 ? 3 : score >= 5 ? 2 : 1
    default:
      return score
  }
}

function fuzzyEquals(fd1?: FuzzyDate, fd2?: FuzzyDate): boolean {
  const empty1 = !fd1 || (!fd1.year && !fd1.month && !fd1.day)
  const empty2 = !fd2 || (!fd2.year && !fd2.month && !fd2.day)
  if (empty1 && empty2) return true
  if (empty1 || empty2) return false
  return fd1.year === fd2.year && fd1.month === fd2.month && fd1.day === fd2.day
}

function makeFuzzyDate(d?: string | Date): FuzzyDate | undefined {
  if (!d) return undefined
  const date = new Date(d)
  if (isNaN(date.getTime())) return undefined
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}

async function fetchShikiUserId(username: string): Promise<number> {
  const res = await fetch(`${window.location.origin}/api/users/${encodeURIComponent(username)}`)
  if (!res.ok) throw new Error('Пользователь Shikimori не найден.')
  const data = (await res.json()) as { id: number }
  return data.id
}

async function fetchShikimoriListV2(userId: number, type: MediaType): Promise<ShikiUserRate[]> {
  let page = 1
  const all: ShikiUserRate[] = []
  const seen = new Set<number>()
  const targetType = type === 'anime' ? 'Anime' : 'Manga'
  Logger('INFO', `Скачивание списка ${type} с Shikimori v2...`)

  while (true) {
    const url = `${window.location.origin}/api/v2/user_rates?user_id=${userId}&target_type=${targetType}&limit=1000&page=${page}`
    const res = await fetch(url)
    if (!res.ok) {
      if (res.status === 404) break
      if (res.status === 403) throw new Error('Профиль скрыт.')
      break
    }
    const data = (await res.json()) as ShikiUserRate[]
    if (!data || data.length === 0) break

    let added = 0
    for (const item of data) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        all.push(item)
        added++
      }
    }
    if (added === 0) break
    page++
    await new Promise((r) => setTimeout(r, 500))
  }
  return all
}

async function fetchShikiHistoryDates(
  userId: number,
  btn?: HTMLButtonElement,
): Promise<Record<string, HistoryDates>> {
  let page = 1
  const datesMap: Record<string, { starts: number[]; ends: number[] }> = {}
  while (true) {
    if (btn) btn.textContent = `Анализ таймингов (стр. ${page})...`
    try {
      const res = await fetch(
        `${window.location.origin}/api/users/${userId}/history?limit=100&page=${page}`,
      )
      if (!res.ok) {
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        break
      }
      const data = (await res.json()) as Array<{
        target?: { id: number }
        target_type?: string
        created_at: string
        description?: string
      }>
      if (!data || data.length === 0) break

      data.forEach((item) => {
        if (!item.target) return
        const targetType = item.target_type?.toLowerCase()
        if (targetType !== 'anime' && targetType !== 'manga') return
        const id = `${targetType}:${item.target.id}`
        const dateObj = new Date(item.created_at)
        const desc = (item.description || '').toLowerCase()

        if (!datesMap[id]) datesMap[id] = { starts: [], ends: [] }
        if (
          desc === 'просмотрено' ||
          desc === 'прочитано' ||
          desc === 'пересмотрено' ||
          desc === 'перечитано'
        ) {
          datesMap[id].ends.push(dateObj.getTime())
        } else if (
          desc.includes('смотрю') ||
          desc.includes('читаю') ||
          desc.includes('просмотрен') ||
          desc.includes('прочитан') ||
          desc.includes('эпизод') ||
          desc.includes('глав') ||
          desc.includes('пересматр') ||
          desc.includes('перечитыв')
        ) {
          datesMap[id].starts.push(dateObj.getTime())
        }
      })

      if (data.length < 100) break
      page++
      await new Promise((r) => setTimeout(r, 350))
    } catch (e) {
      Logger('ERROR', `fetchShikiHistoryDates: сбой на странице ${page}, обработка прервана`, e)
      break
    }
  }

  const finalMap: Record<string, HistoryDates> = {}
  for (const id in datesMap) {
    const entry = datesMap[id]
    if (!entry) continue
    const starts = entry.starts
    const ends = entry.ends
    const start = starts.length > 0 ? new Date(Math.min(...starts)) : null
    const end = ends.length > 0 ? new Date(Math.max(...ends)) : null
    finalMap[id] = { start, end }
  }
  return finalMap
}

async function fetchShikimoriFavorites(
  usernameOrId: string | number,
): Promise<ShikiFavorites | null> {
  const endpoints = [
    `/api/users/${usernameOrId}/favorites`,
    `/api/users/${usernameOrId}/favourites`,
  ]
  for (const ep of endpoints) {
    try {
      const res = await fetch(window.location.origin + ep)
      if (res.ok) return (await res.json()) as ShikiFavorites
    } catch (e) {
      Logger('WARN', `fetchShikimoriFavorites: сбой запроса ${ep}`, e)
    }
  }
  return null
}

async function getAnilistIds(
  malIds: number[],
  type: AniListMediaType,
): Promise<Record<number, number>> {
  if (!malIds || malIds.length === 0) return {}
  const map: Record<number, number> = {}
  for (let i = 0; i < malIds.length; i += 50) {
    const chunk = malIds.slice(i, i + 50)
    const query =
      'query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){id idMal}}}'
    const res = await anilistQuery<{
      Page?: { media?: Array<{ id: number; idMal: number }> }
    }>(query, { m: chunk, t: type })
    if (res?.data?.Page?.media) {
      res.data.Page.media.forEach((m) => (map[m.idMal] = m.id))
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  return map
}

async function getExistingAnilistList(
  alUserId: number,
  type: AniListMediaType,
  btn?: HTMLButtonElement,
): Promise<Record<number, AniListEntry>> {
  const map: Record<number, AniListEntry> = {}
  if (btn) btn.textContent = `Загрузка AL списка (${type})...`
  const query =
    'query($u:Int!,$t:MediaType){MediaListCollection(userId:$u,type:$t){lists{entries{mediaId status score progress progressVolumes repeat notes startedAt { year month day } completedAt { year month day }}}}}'
  const res = await anilistQuery<{
    MediaListCollection?: {
      lists?: Array<{
        entries: Array<{
          mediaId: number
          status: AniListStatus
          score: number
          progress: number
          progressVolumes?: number
          repeat: number
          notes?: string
          startedAt?: FuzzyDate
          completedAt?: FuzzyDate
        }>
      }>
    }
  }>(query, { u: alUserId, t: type })
  const lists = res?.data?.MediaListCollection?.lists || []
  lists.forEach((list) =>
    list.entries.forEach((m) => {
      map[m.mediaId] = m as AniListEntry
    }),
  )
  await new Promise((r) => setTimeout(r, 600))
  return map
}

async function getExistingAnilistFavorites(
  alUserId: number,
  btn?: HTMLButtonElement,
): Promise<ExistingFavorites> {
  const existing: ExistingFavorites = {
    anime: new Set(),
    manga: new Set(),
    characters: new Set(),
    staff: new Set(),
  }
  const fetchFav = async (type: string, targetSet: Set<number>) => {
    let page = 1
    let hasNextPage = true
    if (btn) btn.textContent = `Загрузка Fav AL (${type})...`
    while (hasNextPage) {
      const query = `query($u:Int!,$p:Int!){User(id:$u){favourites{${type}(page:$p){pageInfo{hasNextPage}nodes{id}}}}}`
      const res = await anilistQuery<{
        User?: {
          favourites?: {
            [key: string]: {
              pageInfo: { hasNextPage: boolean }
              nodes: Array<{ id: number }>
            }
          }
        }
      }>(query, { u: alUserId, p: page })
      const data = res?.data?.User?.favourites?.[type]
      if (!data) break
      data.nodes.forEach((n) => targetSet.add(n.id))
      hasNextPage = data.pageInfo.hasNextPage
      page++
      await new Promise((r) => setTimeout(r, 600))
    }
  }
  await fetchFav('anime', existing.anime)
  await fetchFav('manga', existing.manga)
  await fetchFav('characters', existing.characters)
  await fetchFav('staff', existing.staff)
  return existing
}

async function getAnilistIdByName(
  name: string,
  type: 'CHARACTER' | 'STAFF',
): Promise<number | null> {
  const field = type === 'CHARACTER' ? 'characters' : 'staff'
  const query = `query($s:String){Page(page:1,perPage:1){${field}(search:$s){id}}}`
  try {
    const res = await anilistQuery<{
      Page?: { [key: string]: Array<{ id: number }> }
    }>(query, { s: name })
    const arr = res?.data?.Page?.[field]
    const firstItem = arr?.[0]
    if (firstItem) return firstItem.id
  } catch (e) {
    Logger('WARN', `getAnilistIdByName: сбой поиска "${name}" (${type})`, e)
  }
  return null
}

async function syncShikiToAlList(
  shikiItems: ShikiUserRate[],
  type: MediaType,
  alUser: AniListUser,
  historyDates: Record<string, HistoryDates> | null,
  btn?: HTMLButtonElement,
): Promise<void> {
  if (!shikiItems || shikiItems.length === 0) return
  const alType: AniListMediaType = type === 'anime' ? 'ANIME' : 'MANGA'
  const valids = shikiItems.filter((i) => i && i.target_id)
  if (valids.length === 0) return

  if (btn) btn.textContent = `Сверка ID (${type})...`
  const idMap = await getAnilistIds(
    valids.map((i) => i.target_id),
    alType,
  )
  const exList = await getExistingAnilistList(alUser.id, alType, btn)

  let count = 0
  for (const item of valids) {
    count++
    if (btn) btn.textContent = `Shiki ➜ AL (${type}): ${count}/${valids.length}`

    const alId = idMap[item.target_id]
    if (!alId) {
      if (count % 50 === 0) await new Promise((r) => setTimeout(r, 10))
      continue
    }

    const status = mapStatusShikiToAL[item.status] || 'PLANNING'
    const scoreRaw = convertScoreShikiToAL(item.score, alUser.mediaListOptions.scoreFormat)
    const progress = (type === 'anime' ? item.episodes : item.chapters) || 0
    const progressVolumes = (type === 'manga' ? item.volumes : 0) || 0
    const repeat = item.rewatches || 0

    let notes = item.text && item.text.trim().length > 0 ? item.text.trim() : undefined
    if (notes) {
      notes = notes
        .replace(/\[b\](.*?)\[\/b\]/gi, '**$1**')
        .replace(/\[i\](.*?)\[\/i\]/gi, '*$1*')
        .replace(/\[s\](.*?)\[\/s\]/gi, '~~$1~~')
        .replace(/\[spoiler(?:=[^\]]+)?\]([\s\S]*?)\[\/spoiler\]/gi, '~!$1!~')
        .replace(/\[url=(.+?)\](.*?)\[\/url\]/gi, '[$2]($1)')
    }

    let startedAt: FuzzyDate | undefined
    let completedAt: FuzzyDate | undefined
    const historyKey = `${type}:${item.target_id}`
    if (historyDates && historyDates[historyKey]) {
      const dates = historyDates[historyKey]
      if (dates?.start) startedAt = makeFuzzyDate(dates.start || undefined)
      if (dates?.end) completedAt = makeFuzzyDate(dates.end || undefined)
    }
    if (!startedAt && item.status !== 'planned' && item.created_at)
      startedAt = makeFuzzyDate(item.created_at)
    if (!completedAt && item.status === 'completed' && item.updated_at)
      completedAt = makeFuzzyDate(item.updated_at)

    const ex = exList[alId]
    if (ex) {
      let alRawScore = Math.round(ex.score || 0)
      if (alUser.mediaListOptions.scoreFormat === 'POINT_10_DECIMAL')
        alRawScore = Math.round((ex.score || 0) * 10)
      let isSame =
        ex.status === status &&
        alRawScore === scoreRaw &&
        (ex.progress || 0) === progress &&
        (ex.repeat || 0) === repeat &&
        fuzzyEquals(ex.startedAt, startedAt) &&
        fuzzyEquals(ex.completedAt, completedAt)
      if (type === 'manga') isSame = isSame && (ex.progressVolumes || 0) === progressVolumes
      if (notes !== undefined) isSame = isSame && (ex.notes ? ex.notes.trim() : undefined) === notes

      if (isSame) {
        if (count % 50 === 0) await new Promise((r) => setTimeout(r, 10))
        continue
      }
    }

    const variables: Record<string, unknown> = { mediaId: alId, status, scoreRaw, progress, repeat }
    if (type === 'manga') variables.progressVolumes = progressVolumes
    if (notes !== undefined) variables.notes = notes
    if (startedAt) variables.startedAt = startedAt
    if (completedAt) variables.completedAt = completedAt

    const mutationVars: string[] = []
    const mutationArgs: string[] = []
    for (const key of Object.keys(variables)) {
      const typeStr =
        key === 'status'
          ? 'MediaListStatus'
          : key === 'notes'
            ? 'String'
            : key === 'startedAt' || key === 'completedAt'
              ? 'FuzzyDateInput'
              : 'Int'
      mutationVars.push(`$${key}:${typeStr}`)
      mutationArgs.push(`${key}:$${key}`)
    }
    const mutation = `mutation(${mutationVars.join(',')}){SaveMediaListEntry(${mutationArgs.join(',')}){id}}`

    try {
      await anilistQuery(mutation, variables, true)
    } catch (e) {
      exportFailures++
      Logger('ERROR', `syncShikiToAlList: сбой SaveMediaListEntry (mediaId=${alId}, ${type})`, e)
    }
    await new Promise((r) => setTimeout(r, 700))
  }
}

async function syncShikiToAlFavorites(
  shikiFavs: ShikiFavorites | null,
  exAlFavs: ExistingFavorites,
  btn?: HTMLButtonElement,
): Promise<void> {
  if (!shikiFavs) return
  const processFavorites = async (
    arr: ShikiFavItem[] | undefined,
    alType: 'ANIME' | 'MANGA' | 'CHARACTER' | 'STAFF',
    exSet: Set<number>,
    varName: string,
  ) => {
    if (!arr || arr.length === 0) return
    let processedCount = 0
    const field =
      alType === 'ANIME'
        ? 'anime'
        : alType === 'MANGA'
          ? 'manga'
          : alType === 'CHARACTER'
            ? 'characters'
            : 'staff'
    const mutation = `mutation($id:Int!){ToggleFavourite(${varName}:$id){${field}{pageInfo{total}}}}`

    if (['ANIME', 'MANGA'].includes(alType)) {
      if (btn) btn.textContent = `Сверка ID (Fav ${alType})...`
      const idMap = await getAnilistIds(
        arr.map((x) => x.id),
        alType as AniListMediaType,
      )
      for (const item of arr) {
        processedCount++
        if (btn) btn.textContent = `Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`
        const alId = idMap[item.id]
        if (!alId || exSet.has(alId)) {
          if (processedCount % 50 === 0) await new Promise((r) => setTimeout(r, 10))
          continue
        }
        try {
          await anilistQuery(mutation, { id: alId }, true)
        } catch (e) {
          exportFailures++
          Logger('ERROR', `syncShikiToAlFavorites: сбой ToggleFavourite (id=${alId}, ${alType})`, e)
        }
        await new Promise((r) => setTimeout(r, 700))
      }
    } else {
      for (const item of arr) {
        processedCount++
        if (btn) btn.textContent = `Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`
        if (alType !== 'CHARACTER' && alType !== 'STAFF') continue
        const alId = await getAnilistIdByName(item.name, alType)
        if (!alId || exSet.has(alId)) {
          await new Promise((r) => setTimeout(r, 600))
          continue
        }
        try {
          await anilistQuery(mutation, { id: alId }, true)
        } catch (e) {
          exportFailures++
          Logger(
            'ERROR',
            `syncShikiToAlFavorites: сбой ToggleFavourite по имени (id=${alId}, ${alType})`,
            e,
          )
        }
        await new Promise((r) => setTimeout(r, 700))
      }
    }
  }
  const shikiStaff = [
    ...(shikiFavs.people || []),
    ...(shikiFavs.seyu || []),
    ...(shikiFavs.mangakas || []),
  ]
  const uniqStaff = Array.from(new Map(shikiStaff.map((i) => [i.id, i])).values())
  await processFavorites(shikiFavs.animes, 'ANIME', exAlFavs.anime, 'animeId')
  await processFavorites(shikiFavs.mangas, 'MANGA', exAlFavs.manga, 'mangaId')
  await processFavorites(shikiFavs.characters, 'CHARACTER', exAlFavs.characters, 'characterId')
  await processFavorites(uniqStaff, 'STAFF', exAlFavs.staff, 'staffId')
}

function amkShikiTokens(el: HTMLElement): void {
  const triple = (c: string, fb: string): string => {
    const m = (c || '').match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    return m ? `${m[1]} ${m[2]} ${m[3]}` : fb
  }
  let bg = getComputedStyle(document.body).backgroundColor
  if (!bg || bg === 'transparent' || bg.replace(/\s/g, '').includes('rgba(0,0,0,0)'))
    bg = getComputedStyle(document.documentElement).backgroundColor
  const bgT = triple(bg, '18 18 28')
  const txT = triple(getComputedStyle(document.body).color, '226 232 240')
  const vars: Record<string, string> = {
    '--color-foreground': bgT,
    '--color-background': bgT,
    '--color-background-100': bgT,
    '--color-background-200': bgT,
    '--color-background-300': bgT,
    '--color-text': txT,
    '--color-text-light': txT,
    '--color-blue': '61 187 238',
    '--color-pink': '243 139 168',
    '--color-red': '252 129 129',
    '--color-green': '166 227 161',
    '--color-orange': '246 193 119',
    '--color-purple': '183 148 244',
  }
  for (const k in vars) {
    const val = vars[k]
    if (val !== undefined) el.style.setProperty(k, val)
  }
}

async function openExportModal(btn: HTMLButtonElement): Promise<void> {
  if (document.getElementById('shiki-export-overlay')) return
  const urlPath = window.location.pathname.split('/')
  const dUser =
    urlPath.length > 1 && urlPath[1] && !['animes', 'mangas', 'forum'].includes(urlPath[1])
      ? urlPath[1]
      : ''
  const tok = GM_getValue('AL_TOKEN', '') as string

  const sw = (id: string, on = true) =>
    `<label class="amk-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="amk-track"></span><span class="amk-thumb"></span></label>`
  const overlayTemplate = `
    <div id="shiki-export-overlay" class="amk-overlay" style="display:flex;">
      <div class="amk-modal" style="width:500px;background:rgba(255,255,255,0.85);">
        <div class="amk-head">
          <h2 class="amk-title" style="color:#000;"><span class="amk-dot"></span><span style="color:#e05264;">Shikimori</span>&nbsp;➜&nbsp;<span style="color:#3dbbee;">AniList</span> <span class="amk-sub">экспорт</span></h2>
          <button class="amk-close" id="se-close" title="Закрыть">✕</button>
        </div>
        <div class="amk-body">
          <div style="display:flex;gap:10px;">
            <input class="amk-input" id="se-user" placeholder="Логин Shikimori" style="flex:1;width:auto;background:rgba(0,0,0,0.08);color:#000;border:1px solid rgba(0,0,0,0.2);" />
            <input class="amk-input amk-mono" type="password" id="se-token" placeholder="Токен AniList" style="flex:1;width:auto;background:rgba(0,0,0,0.08);color:#000;border:1px solid rgba(0,0,0,0.2);" />
          </div>
          <div class="amk-card">
            <div class="amk-card-title">Что переносить</div>
            <div class="amk-row"><span class="amk-row-label"><b>Аниме</b></span>${sw('se-anime')}</div>
            <div class="amk-row"><span class="amk-row-label"><b>Манга</b></span>${sw('se-manga')}</div>
            <div class="amk-row"><span class="amk-row-label"><b>Избранное</b></span>${sw('se-favs')}</div>
            <div class="amk-row"><span class="amk-row-label"><b>Точные даты просмотров</b><span class="amk-row-hint">из истории Shikimori (медленнее)</span></span>${sw('se-dates')}</div>
          </div>
          <div class="amk-card">
            <div class="amk-card-title">Токен AniList</div>
            <div class="amk-row-hint" style="padding:8px 2px 6px;">Создайте Client <a href="https://anilist.co/settings/developer" target="_blank" style="color:#3dbbee;text-decoration:none;">здесь</a>, redirect URL: <code style="background:rgba(0,0,0,0.1);padding:1px 5px;border-radius:4px;">https://anilist.co/api/v2/oauth/pin</code></div>
            <div style="display:flex;gap:8px;">
              <input class="amk-input amk-mono" id="se-gen-client" placeholder="Client ID" style="flex:1;width:auto;background:rgba(0,0,0,0.08);color:#000;border:1px solid rgba(0,0,0,0.2);">
              <button class="amk-btn amk-btn-ghost" id="se-gen-btn">Создать URL</button>
            </div>
            <div id="se-gen-url" style="margin-top:10px;text-align:center;font-size:12px;"></div>
          </div>
        </div>
        <div class="amk-foot">
          <button class="amk-btn amk-btn-primary amk-btn-block" id="se-start" style="border:1px solid rgba(0,0,0,0.3);">Запуск</button>
        </div>
      </div>
    </div>
  `
  document.body.insertAdjacentHTML('beforeend', overlayTemplate)
  const userInput = document.getElementById('se-user') as HTMLInputElement
  const tokenInput = document.getElementById('se-token') as HTMLInputElement
  if (dUser) userInput.value = dUser
  tokenInput.value = tok

  const overlay = document.getElementById('shiki-export-overlay') as HTMLElement
  amkShikiTokens(overlay)
  document.getElementById('se-close')!.onclick = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  document.getElementById('se-gen-btn')!.onclick = () => {
    const cid = (document.getElementById('se-gen-client') as HTMLInputElement).value.trim()
    if (!cid) return alert('Введите Client ID')
    const authUrl =
      'https://anilist.co/api/v2/oauth/authorize?client_id=' + cid + '&response_type=token'
    const authLink = document.createElement('a')
    authLink.href = authUrl
    authLink.target = '_blank'
    authLink.style.cssText =
      'color:rgb(var(--color-blue));text-decoration:none;font-weight:700;display:inline-block;padding:6px 12px;border:1px solid rgb(var(--color-blue));border-radius:6px;'
    authLink.textContent = '👉 Клик для авторизации'
    const genUrlDiv = document.getElementById('se-gen-url')!
    genUrlDiv.innerHTML = ''
    genUrlDiv.appendChild(authLink)
  }

  document.getElementById('se-start')!.onclick = async () => {
    const user = userInput.value.trim()
    const token = tokenInput.value.trim()
    const exportAnime = (document.getElementById('se-anime') as HTMLInputElement).checked
    const exportManga = (document.getElementById('se-manga') as HTMLInputElement).checked
    const exportFavs = (document.getElementById('se-favs') as HTMLInputElement).checked
    const exportDates = (document.getElementById('se-dates') as HTMLInputElement).checked

    if (!user || !token) return alert('Заполните логин и токен!')
    if (!exportAnime && !exportManga && !exportFavs) return alert('Выберите опции для экспорта!')

    GM_setValue('AL_TOKEN', token)
    tokenInput.value = ''
    document.getElementById('shiki-export-overlay')!.remove()
    btn.disabled = true

    try {
      exportFailures = 0
      btn.textContent = 'Соединение с AniList...'
      const res = await anilistQuery<{ Viewer: AniListUser }>(
        'query{Viewer{id name mediaListOptions{scoreFormat}}}',
        {},
        true,
      )
      const alUser = res.data!.Viewer

      btn.textContent = 'Поиск профиля Shiki...'
      const shikiId = await fetchShikiUserId(user)

      if (
        !confirm(
          `Начать перенос Shikimori ➜ AniList для профиля '${alUser.name}'?\n\nВнимание: Экспорт может занять некоторое время.`,
        )
      )
        return

      let historyDates: Record<string, HistoryDates> | null = null
      if (exportDates && (exportAnime || exportManga))
        historyDates = await fetchShikiHistoryDates(shikiId, btn)
      if (exportAnime) {
        const animeList = await fetchShikimoriListV2(shikiId, 'anime')
        await syncShikiToAlList(animeList, 'anime', alUser, historyDates, btn)
      }
      if (exportManga) {
        const mangaList = await fetchShikimoriListV2(shikiId, 'manga')
        await syncShikiToAlList(mangaList, 'manga', alUser, historyDates, btn)
      }
      if (exportFavs) {
        const exFavs = await getExistingAnilistFavorites(alUser.id, btn)
        const shikiFavs = await fetchShikimoriFavorites(user)
        await syncShikiToAlFavorites(shikiFavs, exFavs, btn)
      }
      if (exportFailures > 0) {
        alert(
          `Экспорт завершён частично: ${exportFailures} операций не выполнено. Подробности в логгере.`,
        )
      } else {
        alert('Экспорт успешно завершен!')
      }
    } catch (e) {
      Logger('ERROR', 'Экспорт Shikimori → AniList: ошибка выполнения', e)
      alert('Ошибка: ' + ((e as Error).message || e))
    } finally {
      btn.disabled = false
      setTimeout(() => (btn.textContent = 'Экспорт'), 2000)
    }
  }
}

export function initExporter(): void {
  if (document.getElementById('animori-export-button')) return
  Logger('INFO', 'Инициализация модуля Экспортера')
  const btn = document.createElement('button')
  btn.id = 'animori-export-button'
  btn.textContent = 'Экспорт'
  btn.style.cssText =
    'position:fixed;bottom:20px;left:20px;z-index:9999;padding:11px 20px;background:rgba(var(--color-foreground),0.8);backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%);border:1px solid rgba(var(--color-text-light),0.2);color:rgb(var(--color-text));border-radius:12px;cursor:pointer;font-weight:600;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,0.18);transition:border-color .2s, color .2s;letter-spacing:0.3px;'
  amkShikiTokens(btn)
  btn.onmouseover = () => {
    btn.style.borderColor = 'rgb(var(--color-blue))'
    btn.style.color = 'rgb(var(--color-blue))'
  }
  btn.onmouseout = () => {
    btn.style.borderColor = 'rgba(var(--color-text-light),0.2)'
    btn.style.color = 'rgb(var(--color-text))'
  }
  btn.onclick = () => openExportModal(btn)
  document.body.appendChild(btn)
}
