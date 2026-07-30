// Этап 1 п.1.10 (часть 1/3): каркас медиа-страницы и подписка на изменения DOM
// (строки 3061-3096, 3249-3255 монолита).
//
// Задача этого файла — только жизненный цикл:
//   1) понять, что открыта страница /anime/<id> или /manga/<id>;
//   2) при смене тайтла убрать старые виджеты и обнулить состояние;
//   3) один раз загрузить данные AniList и Shikimori (сначала из кэша);
//   4) вызывать зарегистрированные виджеты каждый раз, когда AniList
//      пересобирает разметку.
//
// Сами виджеты (плеер, рейтинги, франшиза, темы, ссылки) добавляются частями 2 и 3
// через registerMediaWidget() и здесь не упоминаются.
//
// РИСК №3 из AUDITION.md: AniList на React пересобирает блоки страницы и выкидывает
// вставленные узлы. Поэтому вставка виджетов идёт не однократно, а по подписке
// registerMutationHook() из переводчика: монолит держал для этого глобальную
// window.ensureWidgets.

import { anilistQuery } from '../../api/anilist'
import { fetchShiki } from '../../api/shikimori'
import { SHIKI_DOMAINS } from '../../core/constants'
import { dbGet, dbSet } from '../../core/db'
import type { AniListMedia } from '../../core/types'
import { registerMutationHook } from '../translator'
import { Logger } from '../../utils/logger'
import type { MediaAniListData, MediaContext, MediaShikiData, MediaWidget } from './types'

export type { MediaContext, MediaWidget } from './types'

const MEDIA_QUERY = `query ($id: Int) {
  Media(id: $id) {
    id
    type
    idMal
    seasonYear
    averageScore
    title { romaji english }
  }
}`

/** Зарегистрированные виджеты в порядке добавления. */
const widgets: MediaWidget[] = []

/** ID тайтла, страница которого открыта сейчас. */
let currentMediaId: number | null = null

/** Загруженные данные текущего тайтла. null — данных ещё нет или они не нужны. */
let currentContext: MediaContext | null = null

/** Идёт ли загрузка: защита от параллельных запросов по одному тайтлу. */
let isLoading = false

let isStarted = false

/**
 * Регистрирует виджет медиа-страницы.
 * Вызывать до initMedia(); порядок регистрации определяет порядок вставки.
 */
export function registerMediaWidget(widget: MediaWidget): void {
  widgets.push(widget)
}

/** Разбирает адрес страницы. null — это не страница тайтла. */
function parseMediaPath(): { endpoint: 'animes' | 'mangas'; aniId: number } | null {
  const parts = window.location.pathname.split('/')
  const section = parts[1]
  const rawId = parts[2]
  if (!rawId) return null
  if (section !== 'anime' && section !== 'manga') return null

  const aniId = parseInt(rawId, 10)
  if (!aniId) return null

  return { endpoint: section === 'manga' ? 'mangas' : 'animes', aniId }
}

/** Снимает со страницы всё, что вставили виджеты. Вызывается при переходе на другой тайтл. */
function cleanupWidgets(): void {
  for (const widget of widgets) {
    for (const selector of widget.cleanupSelectors) {
      document.querySelectorAll(selector).forEach((el) => el.remove())
    }
  }
}

/**
 * Гасит кнопку плеера при уходе со страницы тайтла.
 *
 * Кнопка живёт в общей панели действий `#animori-actions`, а не в разметке виджета,
 * поэтому `cleanupSelectors` её не снимает: иначе кнопка осталась бы висеть на списках
 * и в профиле. Монолит решал это тем же хардкодом внутри пулинга URL (строка 4643);
 * здесь селектор упомянут в единственном месте, которое знает об уходе со страницы.
 */
function hidePlayerButton(): void {
  const btn = document.getElementById('ru-player-btn')
  if (btn) btn.style.display = 'none'
}

/**
 * Вставляет или восстанавливает все виджеты.
 *
 * Безопасно вызывать сколько угодно раз: каждый виджет сам проверяет своё наличие.
 * Ошибка одного виджета не мешает остальным — иначе один сбой убирал бы со страницы
 * сразу и плеер, и рейтинги, и франшизу.
 */
export function ensureMediaWidgets(): void {
  const ctx = currentContext
  if (!ctx) return

  const route = parseMediaPath()
  if (!route || route.aniId !== ctx.aniId) return

  ctx.sidebar = document.querySelector<HTMLElement>('.sidebar')

  for (const widget of widgets) {
    try {
      widget.mount(ctx)
    } catch (e) {
      Logger('WARN', `[Widget] Виджет ${widget.name} не удалось вставить`, e)
    }
  }
}

/** Данные AniList: сначала из кэша, при промахе или неполной записи — из GraphQL. */
async function loadAniListData(aniId: number): Promise<MediaAniListData | null> {
  const cached = (await dbGet<{ id: number; data: AniListMedia }>('malCache', aniId))?.data as
    MediaAniListData | undefined

  if (cached && typeof cached.averageScore === 'number') return cached

  const res = await anilistQuery<{ Media?: MediaAniListData | null }>(MEDIA_QUERY, { id: aniId })
  const media = res.data?.Media ?? null
  if (media) await dbSet('malCache', { id: aniId, data: media as unknown as AniListMedia })

  return media ?? cached ?? null
}

/**
 * Готовит контекст страницы: адрес, данные AniList, данные Shikimori.
 *
 * После каждого await проверяется, что пользователь всё ещё на том же тайтле:
 * без этой проверки при быстрых переходах данные одного аниме вставлялись бы
 * на страницу другого.
 */
async function loadMediaPage(): Promise<void> {
  const route = parseMediaPath()

  // Ушли со страницы тайтла — сбрасываем состояние, чтобы виджеты не всплыли позже.
  if (!route) {
    if (currentMediaId !== null) {
      cleanupWidgets()
      hidePlayerButton()
      currentMediaId = null
      currentContext = null
    }
    return
  }

  const { aniId, endpoint } = route

  // Тот же тайтл: данные уже есть, надо лишь восстановить разметку.
  if (currentMediaId === aniId) {
    if (currentContext) ensureMediaWidgets()
    return
  }

  if (isLoading) return
  isLoading = true

  try {
    cleanupWidgets()
    currentMediaId = aniId
    currentContext = null

    Logger('INFO', `[Widget] Открыта страница медиа ID: ${aniId}`)

    const malData = await loadAniListData(aniId)
    if (currentMediaId !== aniId) return

    if (!malData || !malData.idMal) {
      Logger('INFO', '[Widget] MAL ID отсутствует, виджеты отключены')
      return
    }

    const cacheKey = `FULL_${aniId}`
    let shikiData =
      (await dbGet<{ key: string; data: MediaShikiData; ts: number }>('shikiCache', cacheKey))
        ?.data ?? null
    if (currentMediaId !== aniId) return

    let shikiDomain = SHIKI_DOMAINS[0] ?? 'shikimori.io'

    if (!shikiData) {
      const res = await fetchShiki<MediaShikiData>(`/api/${endpoint}/${malData.idMal}`)
      if (currentMediaId !== aniId) return

      shikiData = res.data ?? null
      shikiDomain = res.domain ?? shikiDomain
      if (shikiData) {
        await dbSet('shikiCache', { key: cacheKey, data: shikiData, ts: Date.now() })
      }
    } else if (shikiData.domain) {
      shikiDomain = shikiData.domain
    }

    currentContext = {
      aniId,
      malData,
      shikiData,
      shikiDomain,
      endpoint,
      sidebar: document.querySelector<HTMLElement>('.sidebar'),
    }

    ensureMediaWidgets()
  } catch (e) {
    Logger('ERROR', `[Widget] Не удалось подготовить страницу медиа ID: ${aniId}`, e)
  } finally {
    isLoading = false
  }
}

/**
 * Полный проход по текущему адресу: загрузка данных при смене тайтла, восстановление
 * разметки на том же тайтле, очистка при уходе со страницы.
 *
 * Это аналог `injectMediaExtensions()` монолита. Нужен снаружи, чтобы SPA-обвязка из
 * `core/lifecycle.ts` могла реагировать на смену роута: наблюдателя мутаций для этого
 * недостаточно, потому что переход между страницами не всегда меняет разметку сайдбара.
 */
export function refreshMediaPage(): void {
  void loadMediaPage()
}

/**
 * Запускает медиа-модуль: одна подписка на изменения страницы плюс первый проход.
 * Вызывать после loadSettings(), openDB() и initTranslator().
 */
export function initMedia(): void {
  if (isStarted) return
  isStarted = true

  registerMutationHook(() => {
    void loadMediaPage()
  })

  Logger('INFO', `[Widget] Медиа-модуль запущен, виджетов зарегистрировано: ${widgets.length}`)
  void loadMediaPage()
}
