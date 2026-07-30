// Этап 1 п.1.10 (часть 2/3): плеер Kodik (строки 3528-3733 монолита).
//
// Отдельный виджет медиа-страницы: кнопка запуска, overlay с iframe, список озвучек
// и сетка эпизодов. Регистрируется в main.ts через registerMediaWidget(), чтобы не
// получить циклический импорт с ./index.
//
// Этап 2 п.2.5: кнопка запуска больше не создаётся здесь и не вставляется в панель
// через prepend. Панель отрисовывает Vue (ActionPanel.vue), и посторонний узел внутри
// её разметки был бы источником расхождений при перерисовке. Виджет только сообщает
// состояние: showPlayerButton() / hidePlayerButton().

import { anilistQuery } from '../../api/anilist'
import { amApplyAccentToDom } from '../../core/accent'
import { settings } from '../../core/settings'
import { Logger } from '../../utils/logger'
import { hidePlayerButton, showPlayerButton } from '../ui/action-panel-state'
import type { MediaContext, MediaWidget } from './types'

/** Публичный токен Kodik из монолита. */
const KODIK_TOKEN = '16f20d024a6fa20700b389c44d9ab159'

const FAV_STORAGE_KEY = 'am_fav_translations'

/** Сырой элемент ответа Kodik `/search`. */
interface KodikSearchItem {
  link?: string
  type?: string
  last_episode?: number
  episodes_count?: number
  translation?: { title?: string } | null
  seasons?: Record<string, { episodes?: Record<string, unknown> }> | null
}

interface KodikSearchResponse {
  results?: KodikSearchItem[] | null
}

/** Озвучка в нормализованном виде. */
interface Translation {
  title: string
  link: string
  episodes: number[]
  isSerial: boolean
}

interface ProgressQuery {
  Media?: { mediaListEntry?: { progress?: number | null; status?: string | null } | null } | null
}

/** Разметка overlay. Статичная, без подстановки данных — вставка безопасна. */
const OVERLAY_HTML = `<div id="ru-player-shell"><div id="ru-stage-col"><div id="ru-info-panel"><div id="ru-title-wrap"><div id="ru-title-track"><span id="info-anime-title">Загрузка...</span></div></div><span id="ru-ep-chip" style="display:none;"></span></div><div id="ru-player-container"><iframe id="ru-p-iframe" allowfullscreen allow="autoplay; fullscreen"></iframe></div></div><div id="ru-sidebar"><div id="ru-sidebar-head"><span class="ru-sb-title">Озвучка</span><div id="ru-player-close">&times;</div></div><div id="ru-translations-panel" style="display:none;"></div><div id="ru-eps-label" style="display:none;">Эпизоды</div><div id="ru-episodes-panel" style="display:none;"></div></div></div>`

/** Слушатель сообщений от iframe Kodik. В монолите жил в `window.__amKodikSync`. */
let kodikSyncListener: ((event: MessageEvent) => void) | null = null

function heartSVG(filled: boolean): string {
  const c = filled ? 'rgb(var(--color-pink, 243,139,168))' : 'rgb(var(--color-text-light))'
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="${filled ? c : 'none'}" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5 4.3 12.6a4.7 4.7 0 0 1 0-6.6 4.5 4.5 0 0 1 6.5 0l1.2 1.2 1.2-1.2a4.5 4.5 0 0 1 6.5 0 4.7 4.7 0 0 1 0 6.6z"/></svg>`
}

/** Номера эпизодов для одного результата Kodik. */
function collectEpisodes(item: KodikSearchItem): number[] {
  const seasons = item.seasons
  if (seasons) {
    const firstKey = Object.keys(seasons)[0]
    const firstSeason = firstKey === undefined ? undefined : seasons[firstKey]
    const episodes = firstSeason?.episodes
    if (episodes) {
      const numbers = Object.keys(episodes)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
      if (numbers.length > 0) return numbers
    }
  }

  const max = item.last_episode || item.episodes_count || 1
  const fallback: number[] = []
  for (let i = 1; i <= max; i++) fallback.push(i)
  return fallback
}

/** Ответ Kodik → список озвучек без дублей. */
function parseTranslations(response: KodikSearchResponse): Translation[] {
  const byTitle = new Map<string, Translation>()

  for (const item of response.results ?? []) {
    const title = item.translation?.title
    if (!title || byTitle.has(title)) continue

    let link = item.link
    if (!link) continue
    if (link.startsWith('//')) link = 'https:' + link
    // Собственные селекторы Kodik скрыты: сериями рулит наш сайдбар.
    link += (link.includes('?') ? '&' : '?') + 'hide_selectors=true'

    byTitle.set(title, {
      title,
      link,
      episodes: collectEpisodes(item),
      isSerial: item.type === 'anime-serial',
    })
  }

  return Array.from(byTitle.values())
}

/** Прогресс пользователя для подсветки просмотренных серий. */
async function loadProgress(aniId: number): Promise<{ progress: number; completed: boolean }> {
  try {
    const res = await anilistQuery<ProgressQuery>(
      `query ($id: Int) { Media(id: $id) { mediaListEntry { progress status } } }`,
      { id: aniId },
      true,
    )
    const entry = res.data?.Media?.mediaListEntry
    return { progress: entry?.progress ?? 0, completed: entry?.status === 'COMPLETED' }
  } catch (e) {
    Logger('ERROR', '[Player] Не удалось получить прогресс AniList', e)
    return { progress: 0, completed: false }
  }
}

/** Заголовок overlay с бегущей строкой при переполнении. */
function setOverlayTitle(text: string): void {
  const titleEl = document.getElementById('info-anime-title')
  if (!titleEl) return
  titleEl.textContent = text

  const wrap = document.getElementById('ru-title-wrap')
  const track = document.getElementById('ru-title-track')
  if (!wrap || !track) return

  track.classList.remove('am-marquee')
  wrap.classList.remove('am-mask')
  track.querySelectorAll('.am-title-dup').forEach((d) => d.remove())

  requestAnimationFrame(() => {
    if (titleEl.scrollWidth > wrap.clientWidth + 4) {
      const dup = titleEl.cloneNode(true) as HTMLElement
      dup.removeAttribute('id')
      dup.classList.add('am-title-dup')
      track.appendChild(dup)
      track.classList.add('am-marquee')
      wrap.classList.add('am-mask')
    }
  })
}

/** Создаёт overlay один раз и возвращает его. */
function ensureOverlay(): HTMLElement {
  const existing = document.getElementById('ru-player-overlay')
  if (existing) return existing

  const overlay = document.createElement('div')
  overlay.id = 'ru-player-overlay'
  overlay.classList.add('am-accent-scope')
  overlay.innerHTML = OVERLAY_HTML
  document.body.appendChild(overlay)

  const close = (): void => {
    overlay.style.display = 'none'
    const iframe = document.getElementById('ru-p-iframe')
    if (iframe instanceof HTMLIFrameElement) iframe.src = ''
  }

  const closeBtn = document.getElementById('ru-player-close')
  if (closeBtn) closeBtn.addEventListener('click', close)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  return overlay
}

/** Запуск плеера для текущего тайтла. */
async function openPlayer(ctx: MediaContext): Promise<void> {
  Logger('INFO', '[Player] Запуск плеера Kodik')

  const overlay = ensureOverlay()
  overlay.style.display = 'flex'

  const iframe = document.getElementById('ru-p-iframe')
  const tPanel = document.getElementById('ru-translations-panel')
  const ePanel = document.getElementById('ru-episodes-panel')
  const epLabel = document.getElementById('ru-eps-label')
  const epChip = document.getElementById('ru-ep-chip')
  if (!(iframe instanceof HTMLIFrameElement) || !tPanel || !ePanel) {
    Logger('ERROR', '[Player] Разметка overlay неполная, плеер не запущен')
    return
  }

  const malId = ctx.malData.idMal
  const defaultTitle = ctx.shikiData?.russian || ctx.malData.title.romaji || 'Без названия'

  iframe.src = ''
  tPanel.style.display = 'none'
  ePanel.style.display = 'none'
  if (epLabel) epLabel.style.display = 'none'
  setOverlayTitle('Подключение к базе...')

  const fallbackPlayer = (reason = ''): void => {
    Logger('ERROR', `[Player] Сработал резервный плеер Kodik: ${reason}`)
    iframe.src =
      'https://kodikplayer.com/find-player?shikimoriID=' +
      String(malId) +
      '&types=anime-serial,anime'
    setOverlayTitle(defaultTitle + (reason ? ` (Резерв: ${reason})` : ' (Резервный плеер)'))
    if (epChip) epChip.style.display = 'none'
  }

  const { progress, completed } = await loadProgress(ctx.aniId)

  GM_xmlhttpRequest({
    method: 'GET',
    url:
      'https://kodik-api.com/search?token=' + KODIK_TOKEN + '&shikimori_id=' + String(malId ?? ''),
    onload: (res) => {
      let translations: Translation[] = []
      try {
        translations = parseTranslations(JSON.parse(res.responseText) as KodikSearchResponse)
      } catch (e) {
        Logger('ERROR', '[Player] Kodik API: сбой разбора ответа search', e)
        fallbackPlayer('Ошибка API')
        return
      }

      if (translations.length === 0) {
        fallbackPlayer()
        return
      }

      let favs = GM_getValue<string[]>(FAV_STORAGE_KEY, [])
      const preferred = favs.map((f) => translations.find((t) => t.title === f)).find(Boolean)
      let activeTranslation: Translation = preferred ?? (translations[0] as Translation)
      let activeEpisode = activeTranslation.episodes[0] ?? 1
      let loadedTranslation: Translation | null = null

      const setTitle = (): void => {
        setOverlayTitle(`${defaultTitle} — ${activeTranslation.title}`)
        if (!epChip) return
        if (activeTranslation.isSerial) {
          epChip.style.display = ''
          epChip.textContent = `Серия ${activeEpisode}`
        } else {
          epChip.style.display = 'none'
        }
      }

      // seamless=true — смена серии через API без перезагрузки iframe:
      // видео и полноэкранный режим остаются целы.
      const updatePlayer = (seamless = false): void => {
        const canSeamless =
          seamless &&
          activeTranslation.isSerial &&
          loadedTranslation === activeTranslation &&
          iframe.contentWindow !== null

        if (canSeamless) {
          try {
            iframe.contentWindow?.postMessage(
              {
                key: 'kodik_player_api',
                value: { method: 'change_episode', episode: activeEpisode },
              },
              '*',
            )
          } catch (e) {
            Logger('ERROR', '[Player] Kodik API change_episode', e)
          }
        } else {
          iframe.src = activeTranslation.isSerial
            ? activeTranslation.link + '&episode=' + String(activeEpisode)
            : activeTranslation.link
          loadedTranslation = activeTranslation
        }
        setTitle()
      }

      const renderEpisodes = (): void => {
        ePanel.innerHTML = ''
        if (!activeTranslation.isSerial || activeTranslation.episodes.length <= 1) {
          ePanel.style.display = 'none'
          if (epLabel) epLabel.style.display = 'none'
          return
        }

        ePanel.style.display = 'grid'
        if (epLabel) epLabel.style.display = ''

        for (const ep of activeTranslation.episodes) {
          const btnEp = document.createElement('div')
          btnEp.className = 'ep-btn'
          if (completed || ep <= progress) btnEp.classList.add('watched')
          if (ep === activeEpisode) btnEp.classList.add('active')
          btnEp.textContent = String(ep)
          btnEp.addEventListener('click', () => {
            activeEpisode = ep
            renderEpisodes()
            updatePlayer(true)
          })
          ePanel.appendChild(btnEp)
        }
      }

      const renderTranslations = (): void => {
        tPanel.innerHTML = ''

        for (const tr of translations) {
          const isFav = favs.includes(tr.title)
          const btnTr = document.createElement('div')
          btnTr.className = 'tr-btn'
          if (tr.title === activeTranslation.title) btnTr.classList.add('active')
          if (isFav) btnTr.classList.add('favorite')

          const nameSpan = document.createElement('span')
          nameSpan.className = 'tr-name'
          nameSpan.textContent = tr.title

          const heartSpan = document.createElement('span')
          heartSpan.className = 'tr-heart'
          heartSpan.innerHTML = heartSVG(isFav)

          btnTr.addEventListener('click', (e) => {
            const target = e.target
            if (target instanceof Element && target.closest('.tr-heart')) return
            activeTranslation = tr
            if (!tr.episodes.includes(activeEpisode)) {
              activeEpisode = tr.episodes[tr.episodes.length - 1] ?? 1
            }
            renderTranslations()
            renderEpisodes()
            updatePlayer()
          })

          heartSpan.addEventListener('click', (e) => {
            e.stopPropagation()
            const current = GM_getValue<string[]>(FAV_STORAGE_KEY, [])
            favs = current.includes(tr.title)
              ? current.filter((f) => f !== tr.title)
              : [tr.title, ...current]
            GM_setValue(FAV_STORAGE_KEY, favs)
            renderTranslations()
          })

          btnTr.append(nameSpan, heartSpan)
          tPanel.appendChild(btnTr)
        }
      }

      tPanel.style.display = 'flex'
      renderTranslations()
      renderEpisodes()
      updatePlayer()

      // Плеер сообщает текущую серию (автопереход или смена изнутри) —
      // подсвечиваем в панели. Слушатель всегда один.
      if (kodikSyncListener) window.removeEventListener('message', kodikSyncListener)
      kodikSyncListener = (event: MessageEvent) => {
        const data = event.data as
          | { key?: string; value?: { episode?: number | string } }
          | null
          | undefined
        if (!data || data.key !== 'kodik_player_current_episode' || !data.value) return

        const ep = Number(data.value.episode)
        if (!ep || ep === activeEpisode || !activeTranslation.episodes.includes(ep)) return

        activeEpisode = ep
        renderEpisodes()
        setTitle()
      }
      window.addEventListener('message', kodikSyncListener)
    },
    onerror: () => fallbackPlayer('Сетевая ошибка'),
  })
}

/** Виджет плеера. Регистрируется в main.ts через registerMediaWidget(). */
export const playerWidget: MediaWidget = {
  name: 'player',
  cleanupSelectors: ['#ru-player-overlay'],
  mount(ctx) {
    // Плеер только для аниме и только когда включён в настройках.
    if (!settings.enablePlayer || ctx.malData.type !== 'ANIME' || !ctx.malData.idMal) {
      hidePlayerButton()
      return
    }

    // mount() вызывается часто, но здесь это дешёвая переустановка обработчика:
    // showPlayerButton пишет в shallowRef, который не участвует в шаблоне, поэтому
    // перерисовки панели не происходит. Проверка dataset.amMediaId из этапа 1
    // больше не нужна — она страховала от накопления слушателей на живом узле.
    showPlayerButton(() => {
      void openPlayer(ctx)
    })

    ensureOverlay()
    amApplyAccentToDom()
  },
}
