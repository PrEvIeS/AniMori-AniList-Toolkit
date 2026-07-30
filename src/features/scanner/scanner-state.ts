// Этап 2 п.2.4: реактивное состояние сканера.
//
// Схема та же, что у logger-state.ts и settings-state.ts: состояние и действия живут
// в отдельном модуле, SFC остаётся тонким слоем разметки.
//
// Главное отличие от этапа 1: cmpRender() пересчитывал cmpDiff / cmpStats / cmpFavDiff /
// cmpNameDiff целиком на каждый клик по ✕ в игнор-листе. Здесь цепочка разведена:
//   snapshot -> diffA/diffM/stats/fav* (тяжёлые, пересчёт только после скана)
//   diff* + ignore -> visibleSections (дешёвая фильтрация массивов)
// Снапшот лежит в shallowRef: внутри Map на десятки тысяч записей, глубокая
// реактивность тут только вредит.

import { computed, ref, shallowRef } from 'vue'
import type { CmpAniListEntry, CmpShikiEntry } from '../../core/types'
import { Logger } from '../../utils/logger'
import {
  CMP_STATUS_ORDER,
  ScanCancelled,
  cmpDiff,
  cmpFavDiff,
  cmpGetIgnore,
  cmpNameDiff,
  cmpSaveIgnore,
  cmpStatusLabel,
  cmpStats,
  createCancelToken,
  fetchViewerName,
  getSavedShikiLogin,
  runCompareScan,
} from './compare'
import type { CancelToken, CmpDiffResult, CmpScanSnapshot } from './compare'

/** Предел вывода строк в одной секции, как в 1.9.1. Остальное сворачивается в «…ещё N». */
export const CMP_SECTION_LIMIT = 500

export interface DiffRow {
  /** malId без знака. Знак добавляется только при записи в игнор-лист. */
  id: number
  title: string
  /** Правая колонка строки: либо статус, либо «Shiki → AniList». */
  meta: string
}

export interface DiffSection {
  key: string
  label: string
  /** 1 для аниме, -1 для манги — знак идентификатора в игнор-листе. */
  sign: 1 | -1
  /** Можно ли скрывать строки крестиком. В 1.9.1 — только секции «только где-то». */
  ignorable: boolean
  rows: DiffRow[]
}

// ==== Состояние ====

export const isScannerOpen = ref(false)
export const shikiLogin = ref('')
export const alName = ref('')
/** Подсказка в поле AniList: имя из Viewer{name}, запрашивается один раз на открытие. */
export const alPlaceholder = ref('автоопределение')
export const deepCheck = ref(false)
export const isScanning = ref(false)
export const statusText = ref('')
export const progressStep = ref(0)
export const progressTotal = ref(0)

const snapshot = shallowRef<CmpScanSnapshot | null>(null)
const ignore = ref<Set<number>>(new Set())
let cancelToken: CancelToken | null = null
let placeholderLoaded = false

export const hasResult = computed(() => snapshot.value !== null)

/** Строка счётчика вида «3/7». Пуста, пока скан не запущен. */
export const progressLabel = computed(() =>
  progressTotal.value > 0 ? `${progressStep.value}/${progressTotal.value}` : '',
)

// ==== Игнор-лист ====
//
// Знак id — формат хранилища из 1.9.1: аниме +malId, манга -malId.

function signedId(id: number, sign: 1 | -1): number {
  return id * sign
}

export function addIgnore(id: number, sign: 1 | -1): void {
  const next = new Set(ignore.value)
  next.add(signedId(id, sign))
  ignore.value = next
  cmpSaveIgnore(next)
}

export function removeIgnore(signed: number): void {
  const next = new Set(ignore.value)
  next.delete(signed)
  ignore.value = next
  cmpSaveIgnore(next)
}

function isIgnored(id: number, sign: 1 | -1): boolean {
  return ignore.value.has(signedId(id, sign))
}

/** Название для строки игнор-листа: ищется в четырёх картах снапшота по знаку. */
function titleOf(signed: number): string {
  const s = snapshot.value
  const id = Math.abs(signed)
  if (!s) return 'MAL#' + id
  const maps: Array<Map<number, CmpShikiEntry | CmpAniListEntry>> =
    signed > 0 ? [s.shA, s.alA] : [s.shM, s.alM]
  for (const m of maps) {
    const hit = m.get(id)
    if (hit) return hit.title
  }
  return 'MAL#' + id
}

export const ignoreList = computed(() =>
  [...ignore.value].map((signed) => ({
    signed,
    kind: signed > 0 ? 'аниме' : 'манга',
    title: titleOf(signed),
  })),
)

// ==== Производные от снапшота (тяжёлые) ====

const diffAnime = computed<CmpDiffResult | null>(() => {
  const s = snapshot.value
  return s ? cmpDiff(s.shA, s.alA, 'anime') : null
})

const diffManga = computed<CmpDiffResult | null>(() => {
  const s = snapshot.value
  return s ? cmpDiff(s.shM, s.alM, 'manga') : null
})

export const statsAnime = computed(() => {
  const s = snapshot.value
  return s ? { shiki: cmpStats(s.shA), al: cmpStats(s.alA) } : null
})

export const statsManga = computed(() => {
  const s = snapshot.value
  return s ? { shiki: cmpStats(s.shM), al: cmpStats(s.alM) } : null
})

export const statusRows = computed(() =>
  CMP_STATUS_ORDER.map((key) => ({ key, label: cmpStatusLabel(key) })),
)

export const favAnime = computed(() => {
  const s = snapshot.value
  return s ? cmpFavDiff(s.shFav.anime, s.alFavA) : null
})

export const favManga = computed(() => {
  const s = snapshot.value
  return s ? cmpFavDiff(s.shFav.manga, s.alFavM) : null
})

export const favCharacters = computed(() => {
  const s = snapshot.value
  return s ? cmpNameDiff(s.shFav.characters, s.alFavChar) : null
})

export const favStaff = computed(() => {
  const s = snapshot.value
  return s ? cmpNameDiff(s.shFav.people, s.alFavStaff) : null
})

// ==== Секции расхождений ====

/**
 * Пометка глубокой проверки. Если тайтла нет в каталоге второго сервиса, расхождение
 * неустранимо и строка помечается — ровно как в cmpRenderDiff.
 */
function catalogNote(id: number, side: 'shiki' | 'al'): string {
  const cat = snapshot.value?.catalog
  if (!cat) return ''
  if (side === 'shiki') return cat.alHas.has(id) ? '' : ' · нет в каталоге AniList'
  return cat.shikiHas.has(id) ? '' : ' · нет в каталоге Shikimori'
}

function buildSections(diff: CmpDiffResult, sign: 1 | -1, type: 'anime' | 'manga'): DiffSection[] {
  const p = type === 'anime' ? 'аниме' : 'манга'
  const pair = (rows: Array<{ id: number; title: string; shiki: unknown; al: unknown }>) =>
    rows.map((r) => ({ id: r.id, title: r.title, meta: `${r.shiki} → ${r.al}` }))
  return [
    {
      key: `${type}-only-shiki`,
      label: `Только на Shikimori (${p})`,
      sign,
      ignorable: true,
      rows: diff.onlyShiki.map((r) => ({
        id: r.id,
        title: r.title,
        meta: r.info + catalogNote(r.id, 'shiki'),
      })),
    },
    {
      key: `${type}-only-shiki-rel`,
      label: `Только на Shikimori — связанные тайтлы (${p})`,
      sign,
      ignorable: true,
      rows: diff.onlyShikiRel.map((r) => ({ id: r.id, title: r.title, meta: r.info })),
    },
    {
      key: `${type}-only-al`,
      label: `Только на AniList (${p})`,
      sign,
      ignorable: true,
      rows: diff.onlyAl.map((r) => ({
        id: r.id,
        title: r.title,
        meta: r.info + catalogNote(r.id, 'al'),
      })),
    },
    {
      key: `${type}-only-al-rel`,
      label: `Только на AniList — связанные тайтлы (${p})`,
      sign,
      ignorable: true,
      rows: diff.onlyAlRel.map((r) => ({ id: r.id, title: r.title, meta: r.info })),
    },
    {
      key: `${type}-status`,
      label: `Разный статус (${p})`,
      sign,
      ignorable: false,
      rows: pair(diff.status),
    },
    {
      key: `${type}-score`,
      label: `Разная оценка (${p})`,
      sign,
      ignorable: false,
      rows: pair(diff.score),
    },
    {
      key: `${type}-progress`,
      label: `Разный прогресс (${p})`,
      sign,
      ignorable: false,
      rows: pair(diff.progress),
    },
    {
      key: `${type}-rewatch`,
      label: `Разное число пересмотров (${p})`,
      sign,
      ignorable: false,
      rows: pair(diff.rewatch),
    },
    {
      key: `${type}-notes`,
      label: `Заметки (${p})`,
      sign,
      ignorable: false,
      rows: pair(diff.notes),
    },
  ]
}

const allSections = computed<DiffSection[]>(() => {
  const a = diffAnime.value
  const m = diffManga.value
  if (!a || !m) return []
  return [...buildSections(a, 1, 'anime'), ...buildSections(m, -1, 'manga')]
})

/** Секции без игнорируемых строк и без пустых блоков. Зависит от ignore, но не от сети. */
export const visibleSections = computed<DiffSection[]>(() =>
  allSections.value
    .map((s) =>
      s.ignorable ? { ...s, rows: s.rows.filter((r) => !isIgnored(r.id, s.sign)) } : s,
    )
    .filter((s) => s.rows.length > 0),
)

export const totalDiffCount = computed(() =>
  visibleSections.value.reduce((acc, s) => acc + s.rows.length, 0),
)

export const favIsEqual = computed(() => {
  const a = favAnime.value
  const m = favManga.value
  const c = favCharacters.value
  const st = favStaff.value
  if (!a || !m || !c || !st) return false
  return (
    a.onlyShiki.length + a.onlyAl.length === 0 &&
    m.onlyShiki.length + m.onlyAl.length === 0 &&
    c.onlyShiki.length + c.onlyAl.length === 0 &&
    st.onlyShiki.length + st.onlyAl.length === 0
  )
})

// ==== Действия ====

export async function openScanner(): Promise<void> {
  isScannerOpen.value = true
  if (!shikiLogin.value) shikiLogin.value = getSavedShikiLogin()
  ignore.value = cmpGetIgnore()
  if (placeholderLoaded) return
  placeholderLoaded = true
  try {
    const name = await fetchViewerName()
    if (name) alPlaceholder.value = name
  } catch (e) {
    // Подсказка необязательна: без токена просто остаётся «автоопределение».
    Logger('WARN', 'Сканер сравнения: не удалось получить имя AniList для подсказки', e)
  }
}

export function closeScanner(): void {
  isScannerOpen.value = false
}

/** Мягкая отмена: запросы не рвём, процесс встанет на ближайшей границе шага/чанка. */
export function cancelScan(): void {
  if (!cancelToken || !isScanning.value) return
  cancelToken.cancelled = true
  statusText.value = 'Отмена... ждём завершения текущего запроса.'
}

export async function startScan(): Promise<void> {
  if (isScanning.value) return
  const login = shikiLogin.value.trim()
  if (!login) {
    statusText.value = 'Укажите логин Shikimori.'
    return
  }
  const token = createCancelToken()
  cancelToken = token
  isScanning.value = true
  progressStep.value = 0
  progressTotal.value = deepCheck.value ? 7 : 6
  statusText.value = 'Начинаю...'
  try {
    const { snapshot: snap, summary } = await runCompareScan({
      shikiLogin: login,
      alName: alName.value.trim(),
      deepCheck: deepCheck.value,
      token,
      onProgress: (p) => {
        progressStep.value = p.step
        progressTotal.value = p.total
        statusText.value = p.text
      },
    })
    snapshot.value = snap
    statusText.value = summary
  } catch (e) {
    if (e instanceof ScanCancelled) {
      statusText.value = 'Сканирование отменено.'
      Logger('INFO', 'Сканер сравнения: скан отменён пользователем')
    } else {
      const msg = e instanceof Error ? e.message : String(e)
      statusText.value = 'Ошибка: ' + msg
      Logger('ERROR', 'Сканер сравнения: скан завершился ошибкой', e)
    }
  } finally {
    isScanning.value = false
    cancelToken = null
  }
}
