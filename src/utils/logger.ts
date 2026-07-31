// Пункт 1.5 плана (ядро): Logger, scriptLogs, safeCall, isOwnScriptSource
// и глобальные перехватчики ошибок (строки 267-393 монолита).
//
// UI-часть (createSingleLogEl / renderAllLogs / openLoggerModal, строки 396-665) СОЗНАТЕЛЬНО
// НЕ перенесена: на этапе 2 она станет LoggerModal.vue. Чтобы ядро не знало о UI,
// прямой вызов appendLogEntry() заменён подпиской registerLogSink().
//
// РИСК №6 из AUDITION.md: LOG_LIMIT = 1000 на каждый тип (до ~6000 объектов в памяти).
// В Tauri вкладка не закрывается месяцами -> на этапе 4 заменить на ring-buffer 300-500
// записей + потоковую запись в .log через plugin-fs.
//
// Пункт 3.5: настройки читаются асинхронно, поэтому на верхнем уровне модуля
// settings.enableLogger больше не спрашивается: импорты выполняются до bootstrap(),
// и там всегда лежал бы дефолт true — логи сессии восстанавливались бы даже
// при выключенном логгере. Восстановление переехало в installGlobalErrorHandlers(),
// который bootstrap() зовёт сразу после await loadSettings().
//
// Пункт 3.8: сам Logger() больше не тормозит то, что логирует.
//
//   1. Сериализация в sessionStorage стала пакетной. Раньше КАЖДАЯ запись синхронно
//      гнала JSON.stringify по двумстам объектам со стеками. При переводе большого
//      списка это десятки сериализаций в секунду в главном потоке — и чем больше
//      событий, тем сильнее тормозит. Теперь запись идёт не чаще раза в FLUSH_DELAY_MS,
//      плюс принудительно перед уходом со страницы, чтобы ничего не потерять.
//
//   2. Обрезка по LOG_LIMIT считается по счётчикам типов, а не обходом всего массива
//      на каждую запись. Поиск старейшей записи типа теперь случается только в момент
//      реального переполнения.

import { settings } from '@/core/settings'

export type LogType = 'INFO' | 'WARN' | 'ERROR' | 'DB' | 'API' | 'QUEUE'

export interface LogEntry {
  id: number
  time: string
  /** URL-контекст (window.location.pathname на момент записи). */
  path: string
  type: LogType | string
  message: string
  details: unknown
  stack: string
}

export const LOG_LIMIT = 1000

/** Сколько последних записей переживает переход между страницами (квота sessionStorage). */
const SESSION_KEEP = 200

/** Пауза между записями в sessionStorage. */
const FLUSH_DELAY_MS = 1000

export let scriptLogs: LogEntry[] = []

/** Сколько записей каждого типа лежит в scriptLogs прямо сейчас. */
const typeCounts = new Map<string, number>()

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushHooksInstalled = false

/** Пересчитывает счётчики типов по всему массиву. Нужен после восстановления из сессии. */
function recountTypes(): void {
  typeCounts.clear()
  for (const entry of scriptLogs) {
    typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1)
  }
}

/** Сбрасывает хвост логов в sessionStorage прямо сейчас. */
function flushSessionLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    sessionStorage.setItem('animori_logs', JSON.stringify(scriptLogs.slice(-SESSION_KEEP)))
  } catch {
    /* квота исчерпана — игнор */
  }
}

/**
 * Планирует запись. Повторные вызовы в пределах окна ничего не стоят.
 * При уходе со страницы хвост дописывается принудительно: без этого последние
 * секунды лога — ровно те, где обычно и лежит причина сбоя — терялись бы.
 */
function scheduleSessionFlush(): void {
  if (!flushHooksInstalled) {
    flushHooksInstalled = true
    window.addEventListener('pagehide', flushSessionLogs)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSessionLogs()
    })
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSessionLogs()
  }, FLUSH_DELAY_MS)
}

/**
 * Восстановление логов из sessionStorage.
 *
 * Вызывается только после загрузки настроек и только при включённом логгере —
 * точно так же, как работал верхнеуровневый блок до перехода на асинхронное хранилище.
 * sessionStorage через мост НЕ идёт: это память вкладки, а не настройки приложения,
 * и в WebView Tauri она работает штатно.
 */
function restoreSessionLogs(): void {
  try {
    const savedLogs = sessionStorage.getItem('animori_logs')
    if (savedLogs) scriptLogs = JSON.parse(savedLogs) as LogEntry[]
    recountTypes()
  } catch (e) {
    // Logger может быть не готов — прямой console.warn.
    console.warn('[AniMori] Не удалось восстановить логи сессии', e)
  }
}

/** Подписчик UI: раньше было `if (isLoggerOpen) appendLogEntry(entry)`. */
let logSink: ((entry: LogEntry) => void) | null = null

export function registerLogSink(sink: ((entry: LogEntry) => void) | null): void {
  logSink = sink
}

export function Logger(type: LogType | string, message: string, details: unknown = null): void {
  if (!settings.enableLogger) return

  let parsedDetails = details
  if (details instanceof Error) {
    parsedDetails = { name: details.name, message: details.message, stack: details.stack }
  }

  const d = new Date()
  const time = `${d.toLocaleTimeString('ru-RU', { hour12: false })}.${String(
    d.getMilliseconds(),
  ).padStart(3, '0')}`
  const path = window.location.pathname
  const stackLines = (new Error().stack ?? '').split('\n')
  const stack = stackLines.length > 2 ? stackLines.slice(2).join('\n') : ''

  const entry: LogEntry = {
    id: Date.now() + Math.random(),
    time,
    path,
    type,
    message,
    details: parsedDetails,
    stack,
  }
  scriptLogs.push(entry)

  // Обрезка по типу: обход массива только когда лимит действительно превышен.
  const count = (typeCounts.get(type) ?? 0) + 1
  typeCounts.set(type, count)
  if (count > LOG_LIMIT) {
    const oldest = scriptLogs.findIndex((x) => x.type === type)
    if (oldest >= 0) {
      scriptLogs.splice(oldest, 1)
      typeCounts.set(type, count - 1)
    }
  }

  scheduleSessionFlush()

  if (logSink) logSink(entry)
  if (type === 'ERROR') console.error(`[AniMori ERROR] ${message}`, details || '')
  else if (type === 'WARN') console.warn(`[AniMori WARN] ${message}`, details || '')
}

/** Наша ли ошибка (по маркерам filename/stack). */
export function isOwnScriptSource(str: unknown): boolean {
  if (!str) return false
  const s = String(str).toLowerCase()
  return (
    s.includes('userscript') ||
    s.includes('tampermonkey') ||
    s.includes('animori') ||
    s.includes('.user.js')
  )
}

/**
 * Глобальные перехватчики ошибок. В монолите вешались на верхнем уровне IIFE;
 * теперь вызываются явно из bootstrap() — импорт модуля не должен иметь сайд-эффектов.
 *
 * Здесь же восстанавливаются логи предыдущей страницы сессии: оба действия зависят
 * от одного флага и оба требуют уже загруженных настроек.
 */
export function installGlobalErrorHandlers(): void {
  if (!settings.enableLogger) return

  restoreSessionLogs()

  window.addEventListener('error', (e: ErrorEvent) => {
    // Только свои, не баги AniList/Shikimori
    if (isOwnScriptSource(e.filename) || isOwnScriptSource(e.error?.stack)) {
      Logger('ERROR', `Uncaught Error: ${e.message}`, {
        file: e.filename,
        line: e.lineno,
        col: e.colno,
        stack: e.error?.stack,
      })
    }
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    if (isOwnScriptSource(e.reason && e.reason.stack)) {
      Logger(
        'ERROR',
        `Unhandled Promise Rejection: ${e.reason}`,
        typeof e.reason === 'object' ? e.reason : { reason: e.reason },
      )
    }
  })
}

/**
 * Вызывает fn (async ок), логируя ошибки в Logger('ERROR').
 * Пример: await safeCall(() => anilistQuery(query, vars, true), 'anilistQuery/Viewer')
 */
export async function safeCall<T>(
  fn: () => T | Promise<T>,
  context: string,
  { silent = false }: { silent?: boolean } = {},
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e)
    Logger('ERROR', `Ошибка в ${context}: ${msg}`, e)
    if (!silent) throw e
    return undefined
  }
}
