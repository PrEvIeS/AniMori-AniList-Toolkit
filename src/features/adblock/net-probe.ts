// Разведка к пункту 4.7: кто и куда ходит внутри кадра плеера.
//
// ВРЕМЕННЫЙ МОДУЛЬ. Сносится вместе с NET_PROBE_SCRIPT из src-tauri/src/lib.rs сразу
// после того, как список рекламных адресов собран и превращён в правила блокировки.
//
// Зачем. Оверлейная реклама появляется внутри чужого iframe, в который наш код не
// имеет права заглянуть. Чтобы блокировать точечно (а не резать наугад и ломать плеер),
// нужен список реальных адресов. Скрипт-разведчик из оболочки стоит во всех фреймах
// и шлёт сюда сводку; этот модуль её копит, показывает в логгере и отдаёт текстом
// в буфер обмена по Ctrl+Shift+A.
//
// Почему postMessage, а не вызов команды Tauri из самого кадра: разрешения в
// capabilities/default.json выданы только контексту anilist.co. Чужой фрейм к IPC не допущен
// и допущен быть не должен — это была бы дыра в безопасности ради отладки.
//
// В браузерной сборке модуль тоже собирается, но молчит: сообщения слать некому,
// вешать скрипты на чужие фреймы юзерскрипт не может. Цена — один слушатель message.

import { Bridge } from '@/bridge'
import { Logger } from '../../utils/logger'

/** Ключ сообщения. Сознательно не пересекается с kodik_player_api из media/player.ts. */
const PROBE_KEY = '__animoriNetProbe'

/**
 * Потолок собираемых источников. Реально их десятки; потолок нужен только на
 * случай сетки, которая генерит поддомен на каждый запрос — иначе за час просмотра
 * отчёт раздулся бы до нечитаемого размера.
 */
const MAX_ENTRIES = 300

/** Горячая клавиша выгрузки отчёта в буфер обмена. */
const HOTKEY_CODE = 'KeyA'

interface ProbeItem {
  origin: string
  kind: string
  count: number
  sample: string
}

interface ProbeEntry extends ProbeItem {
  /** Адрес фрейма, из которого ушёл запрос. Главный кадр или кадр плеера — разница критичная. */
  frame: string
  /** Когда источник увидели впервые — помогает сопоставить список с моментом показа рекламы. */
  firstSeen: string
}

const entries = new Map<string, ProbeEntry>()
let installed = false

/** Адрес фрейма без параметров: в них ездят токены и одноразовые ключи. */
function shortFrame(raw: string): string {
  try {
    const u = new URL(raw)
    return u.origin + u.pathname
  } catch {
    return raw
  }
}

function isProbeMessage(data: unknown): data is { frame?: unknown; items?: unknown } {
  return typeof data === 'object' && data !== null && PROBE_KEY in (data as object)
}

function takeItem(frame: string, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return

  const item = raw as Partial<ProbeItem>
  if (typeof item.origin !== 'string' || typeof item.sample !== 'string') return

  const kind = item.kind === 'open' ? 'open' : 'res'
  const key = `${frame}|${kind}|${item.origin}`
  const known = entries.get(key)

  if (known) {
    known.count = typeof item.count === 'number' ? item.count : known.count
    return
  }

  if (entries.size >= MAX_ENTRIES) return

  entries.set(key, {
    origin: item.origin,
    kind,
    count: typeof item.count === 'number' ? item.count : 1,
    sample: item.sample.slice(0, 300),
    frame,
    firstSeen: new Date().toLocaleTimeString('ru-RU', { hour12: false }),
  })

  // Пишем только первое появление источника. Писать каждый запрос нельзя: видео
  // едет сотнями сегментов в минуту и вытеснит из журнала всё остальное.
  Logger('NET', `Разведка: новый источник ${item.origin}`, {
    кадр: frame,
    вид: kind === 'open' ? 'попытка открыть окно' : 'запрос',
    пример: item.sample.slice(0, 300),
  })
}

function onMessage(event: MessageEvent): void {
  if (!isProbeMessage(event.data)) return

  const data = event.data
  const frame = shortFrame(typeof data.frame === 'string' ? data.frame : String(event.origin))
  if (!Array.isArray(data.items)) return

  for (const item of data.items) takeItem(frame, item)
}

/**
 * Готовый к отправке текст отчёта. Группировка по кадрам: строки из кадра
 * плеера и строки с самого сайта нельзя путать: блокировать мы будем только первые.
 */
export function buildNetProbeReport(): string {
  if (entries.size === 0) return 'Разведка: ни одного запроса не зафиксировано.'

  const byFrame = new Map<string, ProbeEntry[]>()
  for (const entry of entries.values()) {
    const list = byFrame.get(entry.frame)
    if (list) list.push(entry)
    else byFrame.set(entry.frame, [entry])
  }

  const lines: string[] = [
    `AniMori: разведка сетевых источников, ${new Date().toLocaleString('ru-RU')}`,
    `Всего источников: ${entries.size}`,
    '',
  ]

  for (const [frame, list] of byFrame) {
    lines.push(`Кадр: ${frame}`)
    list.sort((a, b) => b.count - a.count)
    for (const entry of list) {
      const mark = entry.kind === 'open' ? ' [окно]' : ''
      lines.push(`  ${entry.origin}${mark} — ${entry.count} шт., с ${entry.firstSeen}`)
      lines.push(`    пример: ${entry.sample}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Сколько источников уже поймано (для отладки и будущего UI). */
export function getNetProbeCount(): number {
  return entries.size
}

/** Выгрузка отчёта в буфер обмена. */
export async function copyNetProbeReport(): Promise<void> {
  const report = buildNetProbeReport()
  try {
    await Bridge.clipboard.writeText(report)
    Logger('INFO', `Разведка: отчёт скопирован в буфер обмена (источников: ${entries.size})`)
  } catch (e) {
    // Буфер мог быть недоступен — отчёт всё равно остаётся в журнале целиком,
    // откуда его можно скопировать руками.
    Logger('ERROR', 'Разведка: не удалось записать в буфер обмена', e)
  }
  Logger('NET', 'Разведка: полный отчёт', { отчёт: report })
}

function onKeyDown(e: KeyboardEvent): void {
  if (!e.ctrlKey || !e.shiftKey || e.altKey) return
  if (e.code !== HOTKEY_CODE) return
  e.preventDefault()
  void copyNetProbeReport()
}

/**
 * Запуск. Ставится рано и безусловно: сообщения из кадра плеера начнут приходить
 * сразу после его открытия, а пропущенную пачку никто не повторит.
 *
 * Настройкой модуль сознательно НЕ управляется: это временная разведка на одну-две
 * итерации, а не функция продукта; тумблер пришлось бы вводить и сразу убирать.
 * Стоимость простоя — два слушателя и пустая Map.
 */
export function initNetProbe(): void {
  if (installed) return
  installed = true

  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKeyDown)

  Logger('INFO', 'Разведка сетевых источников включена (Ctrl+Shift+A — отчёт в буфер обмена)')
}

/** Остановка — для полного разбора приложения. */
export function destroyNetProbe(): void {
  if (!installed) return
  installed = false
  window.removeEventListener('message', onMessage)
  window.removeEventListener('keydown', onKeyDown)
}
