// Пункт 1.5 плана, UI-часть: просмотрщик логов (строки 286-315 и 396-665 монолита).
//
// Ядро логгера (utils/logger.ts) о этом файле не знает: вместо прямого вызова
// appendLogEntry() оно дёргает подписчика из registerLogSink(). Зависимость односторонняя:
// UI знает про ядро, ядро про UI — нет.
//
// Порт императивный, один в один с монолитом: этап 1 закрывается с нулевой регрессией.
// На этапе 2 файл целиком заменяется на LoggerModal.vue (п.2.3).
//
// РИСК №6 из AUDITION.md: здесь рендерится весь scriptLogs разом. При LOG_LIMIT = 1000
// на тип это до ~6000 узлов в DOM. В браузере сессия короткая, в Tauri вкладка живёт
// месяцами — на этапе 4 нужна виртуализация списка или ring-buffer.

import { isAniListRateLimited } from '../../api/anilist'
import { getAnime365FailStreak, isAnime365Disabled } from '../../api/anime365'
import { isShikimoriRateLimited } from '../../api/shikimori'
import { ANIME365_FAIL_LIMIT } from '../../core/constants'
import { getDbStats } from '../../core/db'
import { settings } from '../../core/settings'
import { escapeHTML, html, rawHTML } from '../../utils/dom'
import { Logger, registerLogSink, scriptLogs, type LogEntry } from '../../utils/logger'
import { getPendingQueueSizes } from '../translator'
import { ACTION_ORDER, registerActionButton } from './actions'

const OVERLAY_ID = 'am-logger-overlay'

/** Типы, которые склеиваются в группы: их много и они однообразные. */
const GROUPABLE = ['API', 'DB', 'QUEUE']

const FILTERS = ['ALL', 'INFO', 'WARN', 'API', 'DB', 'QUEUE', 'ERROR']

let activeLogFilter = 'ALL'
let activeSearchQuery = ''
let unreadLogs = 0
let isLoggerOpen = false

/**
 * Интерактивный просмотрщик JSON для details записи.
 * Сам экранирует все строки и ключи, поэтому результат считается доверенным HTML.
 */
function createJSONView(obj: unknown, isRoot = true): string {
  if (obj === null) return '<span style="color:#f38ba8">null</span>'
  if (typeof obj === 'undefined') return '<span style="color:#f38ba8">undefined</span>'
  if (typeof obj === 'boolean') return `<span style="color:#cba6f7">${String(obj)}</span>`
  if (typeof obj === 'number') return `<span style="color:#fab387">${String(obj)}</span>`
  if (typeof obj === 'string') return `<span style="color:#a6e3a1">"${escapeHTML(obj)}"</span>`

  const indent = isRoot ? 0 : 15
  const open = isRoot ? 'open' : ''

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    let out = `<details ${open} style="margin-left:${indent}px;"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none;">Array(${obj.length})[</summary><div style="margin-left:15px; border-left:1px solid rgba(255,255,255,0.1); padding-left:10px;">`
    for (let i = 0; i < obj.length; i++) {
      out += `<div style="margin-bottom:2px;"><span style="color:#cdd6f4">${i}:</span> ${createJSONView(obj[i], false)}</div>`
    }
    out += '</div><span style="color:#89b4fa;">]</span></details>'
    return out
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 0) return '{}'
    let out = `<details ${open} style="margin-left:${indent}px;"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none;">Object {</summary><div style="margin-left:15px; border-left:1px solid rgba(255,255,255,0.1); padding-left:10px;">`
    for (const key of keys) {
      out += `<div style="margin-bottom:2px;"><span style="color:#cdd6f4">"${escapeHTML(key)}":</span> ${createJSONView(record[key], false)}</div>`
    }
    out += '</div><span style="color:#89b4fa;">}</span></details>'
    return out
  }

  return escapeHTML(String(obj))
}

/** Одна запись лога с раскрывашками details и stack trace. */
function createSingleLogEl(entry: LogEntry): HTMLElement {
  const el = document.createElement('div')
  el.className = `am-log-entry type-${String(entry.type).toLowerCase()}`

  const detailsHtml =
    entry.details !== null && typeof entry.details !== 'undefined'
      ? rawHTML(
          `<div class="am-log-details" style="display:none;">${createJSONView(entry.details)}</div>`,
        )
      : rawHTML('')

  const shortPath =
    entry.path === '/' ? '/' : entry.path.split('/').slice(1, 3).join('/') || '/'

  const stackHtml = entry.stack
    ? rawHTML(
        `<div class="am-log-stack-details" style="display:none; padding:8px 12px; background:rgba(252,129,129,0.1); border-top:1px solid rgba(255,255,255,0.05);"><pre style="margin:0; font-size:10.5px; color:#f38ba8; white-space:pre-wrap; font-family:inherit;">${escapeHTML(entry.stack)}</pre></div>`,
      )
    : rawHTML('')

  el.innerHTML = html`
    <div class="am-log-header">
      <span class="am-log-time">${entry.time}</span>
      <span class="am-log-badge">${entry.type}</span>
      <span class="am-log-path" title="${entry.path}">/${shortPath}</span>
      <span class="am-log-msg">${entry.message}</span>
      <div style="margin-left:auto; display:flex; gap:8px; align-items:center;">
        ${rawHTML(
          entry.stack
            ? '<span class="am-log-btn-stack" title="Показать Stack Trace">[Stack]</span>'
            : '',
        )}
        ${rawHTML(
          entry.details !== null && typeof entry.details !== 'undefined'
            ? '<span class="am-log-expand">▼</span>'
            : '',
        )}
      </div>
    </div>
    ${stackHtml} ${detailsHtml}
  `

  if (entry.details !== null && typeof entry.details !== 'undefined') {
    const header = el.querySelector<HTMLElement>('.am-log-header')
    if (header) {
      header.style.cursor = 'pointer'
      header.onclick = (e: MouseEvent) => {
        const target = e.target
        if (target instanceof HTMLElement && target.classList.contains('am-log-btn-stack')) return
        e.stopPropagation()
        const det = el.querySelector<HTMLElement>('.am-log-details')
        const arrow = el.querySelector<HTMLElement>('.am-log-expand')
        if (!det) return
        const isHidden = det.style.display === 'none'
        det.style.display = isHidden ? 'block' : 'none'
        if (arrow) arrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)'
      }
    }
  }

  if (entry.stack) {
    const stackBtn = el.querySelector<HTMLElement>('.am-log-btn-stack')
    if (stackBtn) {
      stackBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation()
        const stackEl = el.querySelector<HTMLElement>('.am-log-stack-details')
        if (!stackEl) return
        stackEl.style.display = stackEl.style.display === 'none' ? 'block' : 'none'
      }
    }
  }

  return el
}

function updateScrollBtn(): void {
  const btn = document.getElementById('am-log-scroll-down')
  if (!btn) return
  if (unreadLogs > 0) {
    btn.style.display = 'block'
    btn.textContent = `⬇ Новые логи (${unreadLogs})`
  } else {
    btn.style.display = 'none'
  }
}

/** Проходит ли запись активный поисковый запрос. */
function matchesSearch(entry: LogEntry): boolean {
  if (!activeSearchQuery) return true
  const q = activeSearchQuery.toLowerCase()
  let detailsStr = ''
  try {
    detailsStr = JSON.stringify(entry.details ?? {}).toLowerCase()
  } catch {
    /* циклическая структура — ищем только по тексту */
  }
  return (
    entry.message.toLowerCase().includes(q) ||
    entry.path.toLowerCase().includes(q) ||
    detailsStr.includes(q)
  )
}

function appendLogEntry(entry: LogEntry): void {
  const container = document.getElementById('am-log-container')
  if (!container) return
  if (activeLogFilter !== 'ALL' && activeLogFilter !== entry.type) return
  if (!matchesSearch(entry)) return

  const isAtBottom =
    container.scrollHeight - container.scrollTop <= container.clientHeight + 30

  // При активном фильтре или поиске группировка отключена.
  const canGroup =
    activeLogFilter === 'ALL' && !activeSearchQuery && GROUPABLE.includes(String(entry.type))
  const lastChild = container.lastElementChild

  if (canGroup && lastChild instanceof HTMLElement) {
    if (
      lastChild.classList.contains('am-log-group') &&
      lastChild.dataset.groupType === entry.type
    ) {
      lastChild.querySelector('.am-log-group-items')?.appendChild(createSingleLogEl(entry))
      const count = parseInt(lastChild.dataset.groupCount ?? '1', 10) + 1
      lastChild.dataset.groupCount = String(count)
      const counter = lastChild.querySelector<HTMLElement>('.am-log-group-count')
      if (counter) counter.textContent = `Сгруппировано (${count})`
      finishAppend(container, isAtBottom)
      return
    }

    if (
      lastChild.classList.contains('am-log-entry') &&
      lastChild.classList.contains(`type-${String(entry.type).toLowerCase()}`)
    ) {
      const prevNode = lastChild
      container.removeChild(prevNode)

      const groupEl = document.createElement('div')
      groupEl.className = `am-log-group type-${String(entry.type).toLowerCase()}`
      groupEl.dataset.groupType = String(entry.type)
      groupEl.dataset.groupCount = '2'
      groupEl.innerHTML = html`
        <div class="am-log-header am-log-group-header">
          <span class="am-log-time">${entry.time}</span>
          <span class="am-log-badge">${entry.type}</span>
          <span class="am-log-msg am-log-group-count" style="font-style: italic; color: #8b949e;"
            >Сгруппировано (2)</span
          >
          <span class="am-log-expand">▼</span>
        </div>
        <div class="am-log-group-items" style="display:none;"></div>
      `

      const itemsContainer = groupEl.querySelector<HTMLElement>('.am-log-group-items')
      if (itemsContainer) {
        itemsContainer.appendChild(prevNode)
        itemsContainer.appendChild(createSingleLogEl(entry))

        const header = groupEl.querySelector<HTMLElement>('.am-log-group-header')
        if (header) {
          header.style.cursor = 'pointer'
          header.onclick = () => {
            const isHidden = itemsContainer.style.display === 'none'
            itemsContainer.style.display = isHidden ? 'block' : 'none'
            const arrow = groupEl.querySelector<HTMLElement>('.am-log-expand')
            if (arrow) arrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)'
          }
        }
      }

      container.appendChild(groupEl)
      finishAppend(container, isAtBottom)
      return
    }
  }

  container.appendChild(createSingleLogEl(entry))
  finishAppend(container, isAtBottom)
}

/** Автоскролл только если пользователь и так внизу списка. */
function finishAppend(container: HTMLElement, isAtBottom: boolean): void {
  if (isAtBottom) {
    container.scrollTop = container.scrollHeight
    unreadLogs = 0
  } else {
    unreadLogs++
  }
  updateScrollBtn()
}

function renderAllLogs(): void {
  const container = document.getElementById('am-log-container')
  if (!container) return
  container.textContent = ''
  scriptLogs.forEach(appendLogEntry)
  container.scrollTop = container.scrollHeight
  unreadLogs = 0
  updateScrollBtn()
}

/** Слепок работы скрипта для кнопки «Состояние». */
async function dumpState(): Promise<void> {
  const dbStats = await getDbStats()

  const state = {
    url: window.location.href,
    settings,
    queueSizes: getPendingQueueSizes(),
    databaseCache: dbStats,
    rateLimits: {
      anilist: isAniListRateLimited() ? 'Пауза' : 'OK',
      shikimori: isShikimoriRateLimited() ? 'Пауза' : 'OK',
      anime365: {
        failStreak: `${getAnime365FailStreak()}/${ANIME365_FAIL_LIMIT}`,
        disabled: isAnime365Disabled(),
      },
    },
    translationSources: {
      titlePrimary: settings.titlePrimary,
      titleFallback: settings.titleFallback,
    },
  }

  Logger('INFO', 'DUMP: Текущее состояние скрипта', state)
  renderAllLogs()
}

/** Собирает текстовый дамп логов для буфера и файла. */
function logsToText(withStack: boolean): string {
  return scriptLogs
    .map((l) => {
      const details = l.details ? JSON.stringify(l.details, null, 2) : withStack ? 'null' : ''
      if (!withStack) {
        return `[${l.time}][${l.type}][PATH: ${l.path}] ${l.message} \n${details}`
      }
      return (
        `[${l.time}] [${l.type}][PATH: ${l.path}]\nMSG: ${l.message}\n` +
        `DETAILS: ${details}\nSTACK:\n${l.stack}\n` +
        '---------------------------------------------------'
      )
    })
    .join('\n\n')
}

/** Открывает модалку логгера. Повторный вызов при открытой модалке игнорируется. */
export function openLoggerModal(): void {
  if (document.getElementById(OVERLAY_ID)) return
  isLoggerOpen = true
  unreadLogs = 0

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID

  const filterButtons = FILTERS.map(
    (f) =>
      `<button class="am-log-filter ${activeLogFilter === f ? 'active' : ''}" data-filter="${f}">${f}</button>`,
  ).join('')

  overlay.innerHTML = html`
    <div class="am-logger-modal" style="position:relative;">
      <div class="am-logger-header">
        <h2>
          AniMori Logger
          <span style="font-size:12px;opacity:0.6;font-weight:normal;">(Session Memory)</span>
        </h2>
        <input
          type="text"
          id="am-log-search"
          placeholder="Поиск по логам..."
          style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:200px;transition:0.2s;"
        />
        <div class="am-logger-filters">${rawHTML(filterButtons)}</div>
        <div class="am-logger-actions">
          <button id="am-log-state">Состояние</button>
          <button id="am-log-download">Скачать</button>
          <button id="am-log-copy">Копировать</button>
          <button id="am-log-clear">Очистить</button>
          <button id="am-log-close">✖</button>
        </div>
      </div>
      <div id="am-log-container"></div>
      <button
        id="am-log-scroll-down"
        style="display:none; position:absolute; bottom:25px; right:30px; background:#3dbbee; color:#fff; border:none; border-radius:20px; padding:8px 16px; cursor:pointer; box-shadow:0 4px 15px rgba(0,0,0,0.5); font-weight:bold; z-index:10; transition:0.2s;"
      ></button>
    </div>
  `
  document.body.appendChild(overlay)

  const closeModal = (): void => {
    overlay.remove()
    isLoggerOpen = false
  }

  const container = document.getElementById('am-log-container')
  if (container) {
    container.onscroll = () => {
      if (container.scrollHeight - container.scrollTop <= container.clientHeight + 30) {
        unreadLogs = 0
        updateScrollBtn()
      }
    }
  }

  const searchInput = document.getElementById('am-log-search')
  if (searchInput instanceof HTMLInputElement) {
    searchInput.value = activeSearchQuery
    searchInput.oninput = () => {
      activeSearchQuery = searchInput.value.trim()
      renderAllLogs()
    }
  }

  const scrollBtn = document.getElementById('am-log-scroll-down')
  if (scrollBtn && container) {
    scrollBtn.onclick = () => {
      container.scrollTop = container.scrollHeight
      unreadLogs = 0
      updateScrollBtn()
    }
  }

  const closeBtn = document.getElementById('am-log-close')
  if (closeBtn) closeBtn.onclick = closeModal

  const clearBtn = document.getElementById('am-log-clear')
  if (clearBtn) {
    clearBtn.onclick = () => {
      // scriptLogs — импортированное связывание, перезаписать его извне нельзя,
      // поэтому вместо scriptLogs = [] чистим массив на месте.
      scriptLogs.length = 0
      sessionStorage.removeItem('animori_logs')
      renderAllLogs()
      Logger('INFO', 'Логгер очищен вручную')
    }
  }

  const copyBtn = document.getElementById('am-log-copy')
  if (copyBtn) {
    copyBtn.onclick = () => {
      void navigator.clipboard.writeText(logsToText(false))
      copyBtn.textContent = '✔ Скопировано'
      setTimeout(() => {
        copyBtn.textContent = 'Копировать'
      }, 2000)
    }
  }

  const downloadBtn = document.getElementById('am-log-download')
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      const blob = new Blob([logsToText(true)], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `animori_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  const stateBtn = document.getElementById('am-log-state')
  if (stateBtn) {
    stateBtn.onclick = () => {
      stateBtn.textContent = 'Загрузка...'
      void dumpState().finally(() => {
        if (container) container.scrollTop = container.scrollHeight
        stateBtn.textContent = 'Состояние'
      })
    }
  }

  overlay.querySelectorAll<HTMLElement>('.am-log-filter').forEach((btn) => {
    btn.onclick = () => {
      overlay.querySelectorAll('.am-log-filter').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      activeLogFilter = btn.dataset.filter ?? 'ALL'
      renderAllLogs()
    }
  })

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal()
  })

  renderAllLogs()
}

/**
 * Подключает UI логгера: подписка на новые записи и кнопка </> в панели.
 * Как и в монолите, кнопка появляется только при включённом логгере.
 */
export function initLoggerUI(): void {
  if (!settings.enableLogger) return

  // В монолите было `if (isLoggerOpen) appendLogEntry(entry)` внутри Logger().
  registerLogSink((entry) => {
    if (isLoggerOpen) appendLogEntry(entry)
  })

  registerActionButton({
    id: 'am-log-btn',
    label: '</>',
    title: 'Открыть логгер (AniMori)',
    order: ACTION_ORDER.logger,
    onClick: openLoggerModal,
  })
}
