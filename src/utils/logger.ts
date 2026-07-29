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

export let scriptLogs: LogEntry[] = []

// Восстановление логов из сессии
if (settings.enableLogger) {
  try {
    const savedLogs = sessionStorage.getItem('animori_logs')
    if (savedLogs) scriptLogs = JSON.parse(savedLogs) as LogEntry[]
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

  let typeCount = 0
  for (let i = scriptLogs.length - 1; i >= 0; i--) {
    if (scriptLogs[i]?.type === type) {
      typeCount++
      if (typeCount > LOG_LIMIT) {
        scriptLogs.splice(i, 1)
        break
      }
    }
  }

  // В сессию (последние 200 — квота)
  try {
    sessionStorage.setItem('animori_logs', JSON.stringify(scriptLogs.slice(-200)))
  } catch {
    /* квота исчерпана — игнор */
  }

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
 */
export function installGlobalErrorHandlers(): void {
  if (!settings.enableLogger) return

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
