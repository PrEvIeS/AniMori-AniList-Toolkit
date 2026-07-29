// Этап 1 п.1.7: сканер дельты Shikimori ↔ AniList (строки 667-1281 монолита).
// READ-ONLY фича: сравнение списков и избранного двух площадок, без изменения данных.
// Ключ сопоставления — MAL id (Shikimori id == MAL id, у AniList — idMal).
// Категории расхождений: A (только на одной площадке), B (связанные), C (игнор-лист), D (глубокая проверка).

import { Logger } from '../../utils/logger'
import { html, rawHTML } from '../../utils/dom'
import { anilistQuery } from '../../api/anilist'
import { fetchShiki } from '../../api/shikimori'
import type { CmpAniListEntry, CmpShikiEntry, ShikiStatus } from '../../core/types'

const CMP_STATUS_ORDER = [
  'watching',
  'rewatching',
  'planned',
  'completed',
  'on_hold',
  'dropped',
] as const
const CMP_STATUS_LABEL: Record<string, string> = {
  watching: 'Смотрю/Читаю',
  rewatching: 'Пересматриваю',
  planned: 'Запланировано',
  completed: 'Просмотрено',
  on_hold: 'Отложено',
  dropped: 'Брошено',
  null: '—',
}
const AL_STATUS_MAP: Record<string, ShikiStatus> = {
  CURRENT: 'watching',
  REPEATING: 'rewatching',
  PLANNING: 'planned',
  COMPLETED: 'completed',
  PAUSED: 'on_hold',
  DROPPED: 'dropped',
}
const CMP_SPLIT_RELATIONS = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'ALTERNATIVE', 'SPIN_OFF']

let cmpLast: CmpScanSnapshot | null = null

interface CmpScanSnapshot {
  shA: Map<number, CmpShikiEntry>
  alA: Map<number, CmpAniListEntry>
  shM: Map<number, CmpShikiEntry>
  alM: Map<number, CmpAniListEntry>
  shFav: ShikiFavourites
  alFavA: Map<number, string>
  alFavM: Map<number, string>
  alFavChar: Array<{ name: string; native: string }>
  alFavStaff: Array<{ name: string; native: string }>
  catalog: { alHas: Set<number>; shikiHas: Set<number> } | null
}
interface ShikiFavourites {
  anime: Map<number, string>
  manga: Map<number, string>
  characters: Array<{ name: string; romaji: string }>
  people: Array<{ name: string; romaji: string }>
}

function cmpGetIgnore(): Set<number> {
  try {
    const raw = GM_getValue('CMP_IGNORE', '[]')
    return new Set(JSON.parse(raw as string) as number[])
  } catch (e) {
    Logger('WARN', 'Сканер сравнения: повреждён игнор-лист CMP_IGNORE, сброшен в пустой', e)
    return new Set()
  }
}
function cmpSaveIgnore(set: Set<number>): void {
  GM_setValue('CMP_IGNORE', JSON.stringify([...set]))
}
function cmpAddIgnore(id: number | string): void {
  const s = cmpGetIgnore()
  s.add(Number(id))
  cmpSaveIgnore(s)
}
function cmpRemoveIgnore(id: number | string): void {
  const s = cmpGetIgnore()
  s.delete(Number(id))
  cmpSaveIgnore(s)
}
function cmpEsc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
function cmpStatusLabel(s: string | null): string {
  return CMP_STATUS_LABEL[s ?? 'null'] || '—'
}
function cmpFmtScore(v: number): string {
  return v > 0 ? (Math.round(v * 10) / 10).toString() : '—'
}
function cmpFmtProg(e: { progress: number; volumes: number }, type: 'anime' | 'manga'): string {
  return type === 'manga' ? `${e.progress} гл. / ${e.volumes} т.` : `${e.progress} эп.`
}

async function cmpFetchAniListList(
  userName: string,
  type: 'ANIME' | 'MANGA',
): Promise<Map<number, CmpAniListEntry>> {
  const q =
    'query($n:String,$t:MediaType){MediaListCollection(userName:$n,type:$t){lists{entries{status score(format:POINT_100) progress progressVolumes repeat notes media{idMal title{romaji english} relations{edges{relationType node{idMal}}}}}}}}'
  const res = await anilistQuery<{
    MediaListCollection?: {
      lists?: Array<{
        entries?: Array<{
          status?: string
          score?: number
          progress?: number
          progressVolumes?: number
          repeat?: number
          notes?: string
          media?: {
            idMal?: number
            title?: { romaji?: string; english?: string }
            relations?: { edges?: Array<{ relationType?: string; node?: { idMal?: number } }> }
          }
        }>
      }>
    }
  }>(q, { n: userName, t: type }, true)
  const lists = res?.data?.MediaListCollection?.lists ?? []
  const map = new Map<number, CmpAniListEntry>()
  for (const l of lists) {
    for (const e of l.entries ?? []) {
      const mal = e.media?.idMal
      if (!mal || !e.media) continue
      const mappedStatus = e.status ? AL_STATUS_MAP[e.status] : null
      map.set(mal, {
        malId: mal,
        title: e.media.title?.romaji || e.media.title?.english || 'MAL#' + mal,
        status: mappedStatus ?? null,
        score10: e.score ? e.score / 10 : 0,
        progress: e.progress || 0,
        volumes: e.progressVolumes || 0,
        rewatches: e.repeat || 0,
        notes: (e.notes || '').trim(),
        relations: (e.media.relations?.edges ?? [])
          .filter((ed) => CMP_SPLIT_RELATIONS.includes(ed.relationType ?? ''))
          .map((ed) => ed.node?.idMal)
          .filter((id): id is number => Boolean(id)),
      })
    }
  }
  return map
}

async function cmpFetchAniListFavs(
  userName: string,
  kind: 'anime' | 'manga',
): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  let page = 1
  while (true) {
    const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{idMal title{romaji english}}}}}}`
    const res = await anilistQuery<{
      User?: {
        favourites?: {
          [K in typeof kind]?: {
            pageInfo?: { hasNextPage?: boolean }
            nodes?: Array<{ idMal?: number; title?: { romaji?: string; english?: string } }>
          }
        }
      }
    }>(q, { n: userName, p: page }, true)
    const fav = res?.data?.User?.favourites?.[kind]
    if (!fav) break
    for (const n of fav.nodes ?? []) {
      if (n.idMal) map.set(n.idMal, n.title?.romaji || n.title?.english || 'MAL#' + n.idMal)
    }
    if (!fav.pageInfo?.hasNextPage) break
    page++
    await new Promise((r) => setTimeout(r, 700))
  }
  return map
}

type ShikiRateItem<T extends 'anime' | 'manga'> = {
  status?: string
  score?: number
  episodes?: number
  chapters?: number
  volumes?: number
  rewatches?: number
  text?: string
} & {
  [K in T]: { id?: number; russian?: string; name?: string }
}

async function cmpFetchShikiList(
  userId: number | string,
  type: 'anime' | 'manga',
): Promise<Map<number, CmpShikiEntry>> {
  const map = new Map<number, CmpShikiEntry>()
  let page = 1
  while (true) {
    const r = await fetchShiki<Array<ShikiRateItem<typeof type>>>(
      `/api/users/${userId}/${type}_rates?limit=5000&page=${page}`,
    )
    const data = r.data
    if (!Array.isArray(data) || data.length === 0) break
    for (const it of data) {
      const media = it[type]
      if (!media?.id) continue
      const mal = media.id
      const mappedStatus = it.status as ShikiStatus | null
      map.set(mal, {
        malId: mal,
        title: media.russian || media.name || 'MAL#' + mal,
        status: mappedStatus || null,
        score10: it.score || 0,
        progress: type === 'anime' ? it.episodes || 0 : it.chapters || 0,
        volumes: type === 'manga' ? it.volumes || 0 : 0,
        rewatches: it.rewatches || 0,
        notes: (it.text || '').trim(),
      })
    }
    if (data.length < 5000) break
    page++
    await new Promise((r) => setTimeout(r, 700))
  }
  return map
}

async function cmpFetchShikiFavs(userId: number | string): Promise<ShikiFavourites> {
  const r = await fetchShiki<{
    animes?: Array<{ id?: number; russian?: string; name?: string }>
    mangas?: Array<{ id?: number; russian?: string; name?: string }>
    characters?: Array<{ russian?: string; name?: string }>
    people?: Array<{ russian?: string; name?: string }>
    seyu?: Array<{ russian?: string; name?: string }>
    mangakas?: Array<{ russian?: string; name?: string }>
    producers?: Array<{ russian?: string; name?: string }>
  }>(`/api/users/${userId}/favourites`)
  const d = r.data ?? {}
  const toMap = (
    arr: Array<{ id?: number; russian?: string; name?: string }> | undefined,
  ): Map<number, string> => {
    const m = new Map<number, string>()
    ;(arr ?? []).forEach((x) => {
      if (x.id) m.set(x.id, x.russian || x.name || 'MAL#' + x.id)
    })
    return m
  }
  const toNames = (
    arr: Array<{ russian?: string; name?: string }> | undefined,
  ): Array<{ name: string; romaji: string }> =>
    (arr ?? [])
      .map((x) => ({ name: x.russian || x.name || '', romaji: x.name || '' }))
      .filter((x) => x.name || x.romaji)
  const staffAll = [
    ...(d.people ?? []),
    ...(d.seyu ?? []),
    ...(d.mangakas ?? []),
    ...(d.producers ?? []),
  ]
  return {
    anime: toMap(d.animes),
    manga: toMap(d.mangas),
    characters: toNames(d.characters),
    people: toNames(staffAll),
  }
}

async function cmpFetchAniListFavPeople(
  userName: string,
  kind: 'characters' | 'staff',
): Promise<Array<{ name: string; native: string }>> {
  const arr: Array<{ name: string; native: string }> = []
  let page = 1
  while (true) {
    const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{name{full native}}}}}}`
    const res = await anilistQuery<{
      User?: {
        favourites?: {
          [K in typeof kind]?: {
            pageInfo?: { hasNextPage?: boolean }
            nodes?: Array<{ name?: { full?: string; native?: string } }>
          }
        }
      }
    }>(q, { n: userName, p: page }, true)
    const fav = res?.data?.User?.favourites?.[kind]
    if (!fav) break
    for (const n of fav.nodes ?? [])
      arr.push({ name: n.name?.full || '', native: n.name?.native || '' })
    if (!fav.pageInfo?.hasNextPage) break
    page++
    await new Promise((r) => setTimeout(r, 700))
  }
  return arr
}

function cmpNormName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter(Boolean)
    .sort()
    .join(' ')
}
interface CmpNameDiffResult {
  onlyShiki: Array<{ title: string }>
  onlyAl: Array<{ title: string }>
  shikiCount: number
  alCount: number
}
function cmpNameDiff(
  shikiArr: Array<{ name: string; romaji: string }>,
  alArr: Array<{ name: string; native: string }>,
): CmpNameDiffResult {
  const alKeys = new Set(alArr.map((x) => cmpNormName(x.name)).filter(Boolean))
  const shKeys = new Set(shikiArr.map((x) => cmpNormName(x.romaji || x.name)).filter(Boolean))
  const onlyShiki = shikiArr
    .filter((x) => {
      const k = cmpNormName(x.romaji || x.name)
      return k && !alKeys.has(k)
    })
    .map((x) => ({ title: x.name }))
  const onlyAl = alArr
    .filter((x) => {
      const k = cmpNormName(x.name)
      return k && !shKeys.has(k)
    })
    .map((x) => ({ title: x.name || x.native }))
  return { onlyShiki, onlyAl, shikiCount: shikiArr.length, alCount: alArr.length }
}

async function cmpDeepCheck(
  onlyShiki: { anime: number[]; manga: number[] },
  onlyAl: { anime: number[]; manga: number[] },
  setStatus?: (text: string) => void,
): Promise<{ alHas: Set<number>; shikiHas: Set<number> }> {
  const alHas = new Set<number>()
  const shikiHas = new Set<number>()
  if (setStatus) setStatus('Глубокая проверка: каталог AniList...')
  for (const [type, ids] of [
    ['ANIME', onlyShiki.anime],
    ['MANGA', onlyShiki.manga],
  ] as const) {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50)
      const res = await anilistQuery<{ Page?: { media?: Array<{ idMal?: number }> } }>(
        'query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){idMal}}}',
        { m: chunk, t: type },
      )
      const media = res?.data?.Page?.media ?? []
      media.forEach((m) => {
        if (m.idMal) alHas.add(m.idMal)
      })
      await new Promise((r) => setTimeout(r, 700))
    }
  }
  if (setStatus) setStatus('Глубокая проверка: каталог Shikimori...')
  for (const [ep, ids] of [
    ['animes', onlyAl.anime],
    ['mangas', onlyAl.manga],
  ] as const) {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50)
      const r = await fetchShiki<Array<{ id?: number }>>(
        `/api/${ep}?ids=${chunk.join(',')}&limit=50`,
      )
      const data = r.data ?? []
      if (Array.isArray(data))
        data.forEach((m) => {
          if (m.id) shikiHas.add(m.id)
        })
      await new Promise((r) => setTimeout(r, 700))
    }
  }
  return { alHas, shikiHas }
}

interface CmpStats {
  total: number
  byStatus: Record<string, number>
  mean: number
}
function cmpStats(map: Map<number, { status: string | null; score10: number }>): CmpStats {
  const st: Record<string, number> = {}
  CMP_STATUS_ORDER.forEach((s) => (st[s] = 0))
  let scored = 0,
    sum = 0
  for (const e of map.values()) {
    if (e.status && st[e.status] !== undefined) {
      const count = st[e.status]
      if (count !== undefined) st[e.status] = count + 1
    }
    if (e.score10 > 0) {
      scored++
      sum += e.score10
    }
  }
  return { total: map.size, byStatus: st, mean: scored ? sum / scored : 0 }
}

type CmpDiffItem = { id: number; title: string; info: string }
type CmpDiffItemPair = { id: number; title: string; shiki: string; al: string }
type CmpDiffItemRewatch = { id: number; title: string; shiki: number; al: number }

interface CmpDiffResult {
  onlyShiki: CmpDiffItem[]
  onlyShikiRel: CmpDiffItem[]
  onlyAl: CmpDiffItem[]
  onlyAlRel: CmpDiffItem[]
  status: CmpDiffItemPair[]
  score: CmpDiffItemPair[]
  progress: CmpDiffItemPair[]
  rewatch: CmpDiffItemRewatch[]
  notes: CmpDiffItemPair[]
}
function cmpDiff(
  shiki: Map<number, CmpShikiEntry>,
  al: Map<number, CmpAniListEntry>,
  type: 'anime' | 'manga',
): CmpDiffResult {
  const alRelated = new Set<number>()
  for (const a of al.values()) for (const rid of a.relations || []) alRelated.add(rid)
  const ids = new Set([...shiki.keys(), ...al.keys()])
  const out: CmpDiffResult = {
    onlyShiki: [],
    onlyShikiRel: [],
    onlyAl: [],
    onlyAlRel: [],
    status: [],
    score: [],
    progress: [],
    rewatch: [],
    notes: [],
  }
  for (const id of ids) {
    const s = shiki.get(id),
      a = al.get(id)
    if (s && !a) {
      ;(alRelated.has(id) ? out.onlyShikiRel : out.onlyShiki).push({
        id,
        title: s.title,
        info: cmpStatusLabel(s.status),
      })
      continue
    }
    if (a && !s) {
      const rel = (a.relations || []).some((rid) => shiki.has(rid))
      ;(rel ? out.onlyAlRel : out.onlyAl).push({
        id,
        title: a.title,
        info: cmpStatusLabel(a.status),
      })
      continue
    }
    if (!s || !a) continue
    const title = a.title || s.title
    if (s.status !== a.status)
      out.status.push({ id, title, shiki: cmpStatusLabel(s.status), al: cmpStatusLabel(a.status) })
    if (Math.round(s.score10) !== Math.round(a.score10))
      out.score.push({ id, title, shiki: cmpFmtScore(s.score10), al: cmpFmtScore(a.score10) })
    const pDiff = s.progress !== a.progress || (type === 'manga' && s.volumes !== a.volumes)
    if (pDiff) out.progress.push({ id, title, shiki: cmpFmtProg(s, type), al: cmpFmtProg(a, type) })
    if (s.rewatches !== a.rewatches)
      out.rewatch.push({ id, title, shiki: s.rewatches, al: a.rewatches })
    if (s.notes !== a.notes && (s.notes || a.notes))
      out.notes.push({ id, title, shiki: s.notes ? 'есть' : '—', al: a.notes ? 'есть' : '—' })
  }
  return out
}

interface CmpFavDiffResult {
  onlyShiki: Array<{ id: number; title: string }>
  onlyAl: Array<{ id: number; title: string }>
  shikiCount: number
  alCount: number
}
function cmpFavDiff(shikiFav: Map<number, string>, alFav: Map<number, string>): CmpFavDiffResult {
  const ids = new Set([...shikiFav.keys(), ...alFav.keys()])
  const onlyShiki: Array<{ id: number; title: string }> = []
  const onlyAl: Array<{ id: number; title: string }> = []
  for (const id of ids) {
    const shTitle = shikiFav.get(id)
    const alTitle = alFav.get(id)
    if (shTitle && !alTitle) onlyShiki.push({ id, title: shTitle })
    else if (alTitle && !shTitle) onlyAl.push({ id, title: alTitle })
  }
  return { onlyShiki, onlyAl, shikiCount: shikiFav.size, alCount: alFav.size }
}

async function cmpResolveShikiUser(login: string): Promise<number> {
  const isNum = /^\d+$/.test(login)
  const path = isNum
    ? `/api/users/${login}`
    : `/api/users/${encodeURIComponent(login)}?is_nickname=1`
  const r = await fetchShiki<{ id?: number }>(path)
  if (r.data?.id) return r.data.id
  throw new Error('Пользователь Shikimori не найден: ' + login)
}

function cmpRenderSummary(label: string, sh: CmpStats, al: CmpStats): string {
  const rows = CMP_STATUS_ORDER.map((s) => {
    const shCount = sh.byStatus[s] ?? 0
    const alCount = al.byStatus[s] ?? 0
    const delta = alCount - shCount
    const deltaStr = delta > 0 ? '+' + delta : delta < 0 ? String(delta) : ''
    return `<tr><td>${CMP_STATUS_LABEL[s]}</td><td>${shCount}</td><td>${alCount}</td><td style="color:rgb(var(--color-text-light));">${deltaStr}</td></tr>`
  }).join('')
  const totalDelta = al.total - sh.total
  const totalDeltaStr = totalDelta !== 0 ? String(totalDelta) : ''
  return `<table class="amk-table" style="margin-bottom:12px;"><thead><tr><th>${cmpEsc(label)}</th><th style="width:70px;color:rgb(var(--color-pink));">Shiki</th><th style="width:70px;color:rgb(var(--color-blue));">AniList</th><th style="width:50px;">Δ</th></tr></thead><tbody>${rows}<tr style="font-weight:700;"><td>Всего</td><td>${sh.total}</td><td>${al.total}</td><td>${totalDeltaStr}</td></tr><tr><td>Средняя оценка</td><td>${sh.mean ? sh.mean.toFixed(2) : '—'}</td><td>${al.mean ? al.mean.toFixed(2) : '—'}</td><td></td></tr></tbody></table>`
}

function cmpRenderDiff(
  diff: CmpDiffResult,
  ignore: Set<number>,
  catalog: { alHas: Set<number>; shikiHas: Set<number> } | null,
): string {
  const notIgn = <T extends { id: number }>(arr: T[]): T[] =>
    arr.filter((x) => !ignore.has(Number(x.id)))
  const ignBtn = (id: number) =>
    `<span class="amk-x cmp-ignore" data-id="${id}" title="Скрыть (в игнор)">✕</span>`
  const row = (x: { id: number; title: string }, right?: string) =>
    `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span><span class="amk-meta">${right || ''}</span>${ignBtn(x.id)}</div>`
  const sec = (
    label: string,
    arr: Array<{ id: number; title: string }>,
    fmt: (x: { id: number; title: string }) => string,
  ): string => {
    const a = notIgn(arr)
    if (!a.length) return ''
    const items = a.slice(0, 500).map(fmt).join('')
    const more =
      a.length > 500 ? `<div style="opacity:.6;padding:6px;">…ещё ${a.length - 500}</div>` : ''
    return `<details class="amk-collapse"><summary>${cmpEsc(label)} <span class="amk-count">(${a.length})</span></summary><div class="amk-collapse-body">${items}${more}</div></details>`
  }
  let h = ''
  if (catalog) {
    h += sec(
      'Только на Shikimori — ЕСТЬ в каталоге AniList (можно добавить)',
      diff.onlyShiki.filter((x) => catalog.alHas.has(Number(x.id))),
      (x) => row(x, cmpEsc((x as CmpDiffItem).info)),
    )
    h += sec(
      'Только на Shikimori — НЕТ в каталоге AniList',
      diff.onlyShiki.filter((x) => !catalog.alHas.has(Number(x.id))),
      (x) => row(x, cmpEsc((x as CmpDiffItem).info)),
    )
    h += sec(
      'Только на AniList — ЕСТЬ в каталоге Shikimori (можно добавить)',
      diff.onlyAl.filter((x) => catalog.shikiHas.has(Number(x.id))),
      (x) => row(x, cmpEsc((x as CmpDiffItem).info)),
    )
    h += sec(
      'Только на AniList — НЕТ в каталоге Shikimori',
      diff.onlyAl.filter((x) => !catalog.shikiHas.has(Number(x.id))),
      (x) => row(x, cmpEsc((x as CmpDiffItem).info)),
    )
  } else {
    h += sec('В списке только на Shikimori', diff.onlyShiki, (x) => row(x, cmpEsc((x as CmpDiffItem).info)))
    h += sec('В списке только на AniList', diff.onlyAl, (x) => row(x, cmpEsc((x as CmpDiffItem).info)))
  }
  const rel = [...diff.onlyShikiRel, ...diff.onlyAlRel]
  h += sec('Связано с уже отслеживаемым (деление на сезоны / сиквелы)', rel, (x) =>
    row(x, cmpEsc((x as CmpDiffItem).info)),
  )
  h += sec('Разный статус', diff.status, (x) =>
    row(x, `S: ${cmpEsc((x as CmpDiffItemPair).shiki)} | A: ${cmpEsc((x as CmpDiffItemPair).al)}`),
  )
  h += sec('Разная оценка', diff.score, (x) => row(x, `S: ${cmpEsc((x as CmpDiffItemPair).shiki)} | A: ${cmpEsc((x as CmpDiffItemPair).al)}`))
  h += sec('Разный прогресс', diff.progress, (x) =>
    row(x, `S: ${cmpEsc((x as CmpDiffItemPair).shiki)} | A: ${cmpEsc((x as CmpDiffItemPair).al)}`),
  )
  h += sec('Разные пересмотры', diff.rewatch, (x) =>
    row(x, `S: ${cmpEsc((x as CmpDiffItemRewatch).shiki)} | A: ${cmpEsc((x as CmpDiffItemRewatch).al)}`),
  )
  h += sec('Разные заметки', diff.notes, (x) =>
    row(x, `S: ${cmpEsc((x as CmpDiffItemPair).shiki)} | A: ${cmpEsc((x as CmpDiffItemPair).al)}`),
  )
  const total =
    notIgn(diff.onlyShiki).length +
    notIgn(diff.onlyAl).length +
    notIgn(diff.onlyShikiRel).length +
    notIgn(diff.onlyAlRel).length +
    notIgn(diff.status).length +
    notIgn(diff.score).length +
    notIgn(diff.progress).length +
    notIgn(diff.rewatch).length +
    notIgn(diff.notes).length
  if (!total) h += `<div style="opacity:.6;padding:8px;">Расхождений нет.</div>`
  return h
}

function cmpRenderFavs(
  favA: CmpFavDiffResult,
  favM: CmpFavDiffResult,
  ignore: Set<number>,
): string {
  const notIgn = <T extends { id: number }>(arr: T[]): T[] =>
    arr.filter((x) => !ignore.has(Number(x.id)))
  const ignBtn = (id: number) =>
    `<span class="amk-x cmp-ignore" data-id="${id}" title="Скрыть (в игнор)">✕</span>`
  const sec = (label: string, arr: Array<{ id: number; title: string }>): string => {
    const a = notIgn(arr)
    if (!a.length) return ''
    const items = a
      .slice(0, 500)
      .map(
        (x) =>
          `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span>${ignBtn(x.id)}</div>`,
      )
      .join('')
    return `<details class="amk-collapse"><summary>${cmpEsc(label)} <span class="amk-count">(${a.length})</span></summary><div class="amk-collapse-body">${items}</div></details>`
  }
  let h = `<div style="font-size:13px;margin-bottom:6px;">Избранное — Аниме: <b style="color:rgb(var(--color-pink));">${favA.shikiCount}</b> Shiki / <b style="color:rgb(var(--color-blue));">${favA.alCount}</b> AniList · Манга: <b style="color:rgb(var(--color-pink));">${favM.shikiCount}</b> / <b style="color:rgb(var(--color-blue));">${favM.alCount}</b></div>`
  h += sec('Избранное аниме: только в Shikimori', favA.onlyShiki)
  h += sec('Избранное аниме: только в AniList', favA.onlyAl)
  h += sec('Избранное манга: только в Shikimori', favM.onlyShiki)
  h += sec('Избранное манга: только в AniList', favM.onlyAl)
  if (
    !notIgn(favA.onlyShiki).length &&
    !notIgn(favA.onlyAl).length &&
    !notIgn(favM.onlyShiki).length &&
    !notIgn(favM.onlyAl).length
  )
    h += `<div style="opacity:.6;padding:8px;">Избранное совпадает.</div>`
  return h
}

function cmpRenderNameFavs(label: string, diff: CmpNameDiffResult): string {
  const sec = (l: string, arr: Array<{ title: string }>): string => {
    if (!arr.length) return ''
    const items = arr
      .slice(0, 500)
      .map((x) => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span></div>`)
      .join('')
    const more =
      arr.length > 500 ? `<div style="opacity:.6;padding:6px;">…ещё ${arr.length - 500}</div>` : ''
    return `<details class="amk-collapse"><summary>${cmpEsc(l)} <span class="amk-count">(${arr.length})</span></summary><div class="amk-collapse-body">${items}${more}</div></details>`
  }
  let h = `<div style="font-size:13px;margin:8px 0 4px;"><b>${cmpEsc(label)}</b> — <b style="color:rgb(var(--color-pink));">${diff.shikiCount}</b> Shiki / <b style="color:rgb(var(--color-blue));">${diff.alCount}</b> AniList <span style="opacity:.5;">(матч по имени, приблизительно)</span></div>`
  h += sec(label + ': только в Shikimori', diff.onlyShiki)
  h += sec(label + ': только в AniList', diff.onlyAl)
  return h
}

function cmpRender(resultEl: HTMLElement): void {
  if (!cmpLast) return
  const ignore = cmpGetIgnore()
  const { shA, alA, shM, alM, shFav, alFavA, alFavM, alFavChar, alFavStaff, catalog } = cmpLast
  const stA = { sh: cmpStats(shA), al: cmpStats(alA) }
  const stM = { sh: cmpStats(shM), al: cmpStats(alM) }
  const dA = cmpDiff(shA, alA, 'anime')
  const dM = cmpDiff(shM, alM, 'manga')
  const favA = cmpFavDiff(shFav.anime, alFavA)
  const favM = cmpFavDiff(shFav.manga, alFavM)
  const favChar = cmpNameDiff(shFav.characters || [], alFavChar || [])
  const favStaff = cmpNameDiff(shFav.people || [], alFavStaff || [])
  const titleOf = (id: number | string): string => {
    const numId = Number(id)
    for (const m of [shA, alA, shM, alM]) {
      const e = m.get(numId)
      if (e) return e.title
    }
    for (const fm of [shFav.anime, alFavA, shFav.manga, alFavM]) {
      if (fm.has(numId)) return fm.get(numId) ?? ''
    }
    return 'MAL#' + numId
  }
  const ignArr = [...ignore]
  const ignHtml = ignArr.length
    ? `<details class="amk-collapse"><summary>Игнорируемые <span class="amk-count">(${ignArr.length})</span></summary><div class="amk-collapse-body">${ignArr.map((id) => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(titleOf(id))}</span><span class="cmp-unignore amk-x" data-id="${id}" title="Вернуть" style="color:rgb(var(--color-blue));opacity:.85;">↩</span></div>`).join('')}</div></details>`
    : ''
  resultEl.innerHTML = html`<div style="display:flex;gap:20px;flex-wrap:wrap;">
      <div style="flex:1;min-width:280px;">
        ${rawHTML(cmpRenderSummary('Аниме', stA.sh, stA.al))}
      </div>
      <div style="flex:1;min-width:280px;">
        ${rawHTML(cmpRenderSummary('Манга', stM.sh, stM.al))}
      </div>
    </div>
    <div style="margin-top:6px;">${rawHTML(cmpRenderFavs(favA, favM, ignore))}</div>
    ${rawHTML(cmpRenderNameFavs('Избранные персонажи', favChar))}${rawHTML(cmpRenderNameFavs('Избранный стафф', favStaff))}
    <h3 style="margin:16px 0 4px;color:rgb(var(--color-text));">Аниме</h3>
    ${rawHTML(cmpRenderDiff(dA, ignore, catalog))}
    <h3 style="margin:16px 0 4px;color:rgb(var(--color-text));">Манга</h3>
    ${rawHTML(cmpRenderDiff(dM, ignore, catalog))} ${rawHTML(ignHtml)}
    <div style="opacity:.5;font-size:11px;margin-top:14px;line-height:1.5;">
      «В списке только на одной площадке» — различие каталогов/списков, не ошибка синка. «Связано с
      уже отслеживаемым» — вероятно деление на сезоны или сиквелы (по связям AniList). Крестик ✕ —
      скрыть строку (игнор, запоминается). Даты не сравниваются. Оценки нормализованы к 10-балльной.
      Сопоставление по MAL id.
    </div>`
  resultEl.querySelectorAll('.cmp-ignore').forEach((el) => {
    ;(el as HTMLElement).onclick = () => {
      cmpAddIgnore((el as HTMLElement).dataset.id ?? '')
      cmpRender(resultEl)
    }
  })
  resultEl.querySelectorAll('.cmp-unignore').forEach((el) => {
    ;(el as HTMLElement).onclick = () => {
      cmpRemoveIgnore((el as HTMLElement).dataset.id ?? '')
      cmpRender(resultEl)
    }
  })
}

async function cmpRunScan(
  shikiLogin: string,
  alName: string,
  statusEl: HTMLElement | null,
  resultEl: HTMLElement,
  deepCheck: boolean,
): Promise<void> {
  const setStatus = (t: string) => {
    if (statusEl) statusEl.textContent = t
  }
  try {
    GM_setValue('SHIKI_LOGIN', shikiLogin)
    if (!alName) {
      setStatus('Определяю пользователя AniList...')
      const v = await anilistQuery<{ Viewer?: { name?: string } }>('query{Viewer{name}}', {}, true)
      const n = v && v.data && v.data.Viewer && v.data.Viewer.name
      alName = n ?? ''
      if (!alName)
        throw new Error(
          'Не удалось определить AniList-пользователя. Укажите имя вручную или задайте токен в настройках.',
        )
    }
    setStatus('Ищу пользователя Shikimori...')
    const shikiId = await cmpResolveShikiUser(shikiLogin)
    setStatus('Загружаю списки (аниме)...')
    const [shA, alA] = await Promise.all([
      cmpFetchShikiList(shikiId, 'anime'),
      cmpFetchAniListList(alName, 'ANIME'),
    ])
    setStatus('Загружаю списки (манга)...')
    const [shM, alM] = await Promise.all([
      cmpFetchShikiList(shikiId, 'manga'),
      cmpFetchAniListList(alName, 'MANGA'),
    ])
    setStatus('Загружаю избранное...')
    const shFav = await cmpFetchShikiFavs(shikiId)
    const alFavA = await cmpFetchAniListFavs(alName, 'anime')
    const alFavM = await cmpFetchAniListFavs(alName, 'manga')
    const alFavChar = await cmpFetchAniListFavPeople(alName, 'characters')
    const alFavStaff = await cmpFetchAniListFavPeople(alName, 'staff')
    let catalog: { alHas: Set<number>; shikiHas: Set<number> } | null = null
    if (deepCheck) {
      const dA0 = cmpDiff(shA, alA, 'anime')
      const dM0 = cmpDiff(shM, alM, 'manga')
      catalog = await cmpDeepCheck(
        { anime: dA0.onlyShiki.map((x) => x.id), manga: dM0.onlyShiki.map((x) => x.id) },
        { anime: dA0.onlyAl.map((x) => x.id), manga: dM0.onlyAl.map((x) => x.id) },
        setStatus,
      )
    }
    setStatus('Сравниваю...')
    cmpLast = { shA, alA, shM, alM, shFav, alFavA, alFavM, alFavChar, alFavStaff, catalog }
    cmpRender(resultEl)
    setStatus(`Готово: Shiki ${shA.size + shM.size} / AniList ${alA.size + alM.size} тайтлов.`)
  } catch (e) {
    Logger('ERROR', 'Сканер сравнения: ошибка', e)
    setStatus('Ошибка: ' + (e instanceof Error ? e.message : String(e)))
  }
}

export async function openCompareModal(): Promise<void> {
  if (document.getElementById('am-cmp-overlay')) return
  const overlay = document.createElement('div')
  overlay.id = 'am-cmp-overlay'
  overlay.className = 'amk-overlay'
  overlay.style.display = 'flex'
  overlay.innerHTML = html`<div class="amk-modal amk-wide">
    <div class="amk-head">
      <h2 class="amk-title">
        <span class="amk-dot"></span
        ><span style="color:rgb(var(--color-pink));">Shikimori</span>&nbsp;⇄&nbsp;<span
          style="color:rgb(var(--color-blue));"
          >AniList</span
        >
        <span class="amk-sub">сравнение списков</span>
      </h2>
      <button class="amk-close" id="am-cmp-close" title="Закрыть">✕</button>
    </div>
    <div class="amk-head" style="border-bottom:1px solid rgba(var(--color-text-light),0.06);">
      <input
        class="amk-input"
        id="am-cmp-shiki"
        placeholder="Логин Shikimori"
        style="flex:1;min-width:150px;width:auto;"
      /><input
        class="amk-input"
        id="am-cmp-al"
        placeholder="Имя AniList (авто по токену)"
        style="flex:1;min-width:150px;width:auto;"
      /><label
        style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;white-space:nowrap;"
        title="Проверяет по каталогам обеих площадок наличие недостающих тайтлов. Медленнее (доп. запросы)."
        ><input type="checkbox" id="am-cmp-deep" /> Глубокая проверка</label
      ><button class="amk-btn amk-btn-primary" id="am-cmp-run">Сканировать</button>
    </div>
    <div
      id="am-cmp-status"
      style="padding:8px 18px;font-size:12px;color:rgb(var(--color-text-light));min-height:18px;flex-shrink:0;"
    ></div>
    <div class="amk-body" id="am-cmp-result" style="padding-top:6px;"></div>
  </div>`
  document.body.appendChild(overlay)
  const closeEl = () => overlay.remove()
  document.getElementById('am-cmp-close')!.onclick = closeEl
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEl()
  })
  const shikiInput = document.getElementById('am-cmp-shiki') as HTMLInputElement
  const alInput = document.getElementById('am-cmp-al') as HTMLInputElement
  shikiInput.value = GM_getValue('SHIKI_LOGIN', '') as string
  anilistQuery<{ Viewer?: { name?: string } }>('query{Viewer{name}}', {}, true)
    .then((v) => {
      const n = v?.data?.Viewer?.name
      if (n && !alInput.value) alInput.placeholder = n + ' (по токену)'
    })
    .catch(() => {})
  const statusEl = document.getElementById('am-cmp-status')
  const resultEl = document.getElementById('am-cmp-result') as HTMLElement
  const run = () => {
    const login = shikiInput.value.trim()
    if (!login) {
      statusEl!.textContent = 'Укажите логин Shikimori.'
      return
    }
    const deep = (document.getElementById('am-cmp-deep') as HTMLInputElement).checked
    document.getElementById('am-cmp-run')!.setAttribute('disabled', 'true')
    cmpRunScan(login, alInput.value.trim(), statusEl, resultEl, deep).finally(() => {
      const b = document.getElementById('am-cmp-run')
      if (b) b.removeAttribute('disabled')
    })
  }
  document.getElementById('am-cmp-run')!.onclick = run
  shikiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run()
  })
  alInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run()
  })
}
