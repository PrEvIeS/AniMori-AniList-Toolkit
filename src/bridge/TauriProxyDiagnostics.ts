// Пункт 5.3.6: реализация IProxyDiagnostics для десктопной сборки.
//
// Вынесено из TauriBridge.ts отдельным файлом ради размера: тот файл уже самый
// толстый в проекте. Инвариант №1 не нарушен: файл лежит ВНУТРИ src/bridge и
// в граф юзерскрипта не попадает — его импортирует только TauriBridge, а тот отсекается
// псевдопутᑑм '@bridge-impl' в vite.config.ts. Прикладной код сюда не ходит никогда:
// ему доступен только Bridge.proxyDiagnostics из '@/bridge'.

import { invoke } from '@tauri-apps/api/core'

import type {
  IProxyDiagnostics,
  ProxyOutcome,
  ProxyProbe,
  ProxyStatus,
} from './IBridge'

/**
 * Что отдаёт Rust.
 *
 * Сериализатор на той стороне настроен на camelCase, поэтому имена совпадают
 * буква в букву. Поле reachable в ответе НЕ приходит: на стороне Rust это то же
 * самое, что outcome === 'applied', и два источника одной правды разошлись бы при
 * первой же правке. В контракте поле всё же есть: карточке настроек удобнее читать
 * прямой ответ «ответил или нет», чем каждый раз сравнивать строки.
 */
type RawProxyProbe = {
  outcome: ProxyOutcome
  server: string
  hasCredentials: boolean
  latencyMs: number
}

export const tauriProxyDiagnostics: IProxyDiagnostics = {
  /**
   * Исход применения прокси при запуске.
   *
   * Ответ берётся из памяти процесса оболочки (ProxyState), где его оставил
   * apply_to_webview() ещё до создания окна. Никакой сетевой работы здесь не ведᑑтся,
   * вызов дешᑑвый и его можно делать при каждом открытии панели.
   */
  async status(): Promise<ProxyStatus> {
    return await invoke<ProxyStatus>('animori_proxy_status')
  },

  /**
   * Живая проверка сохранённого адреса.
   *
   * Занимает до двух секунд (таймаут ручной проверки на стороне Rust), поэтому
   * вызывается только по кнопке, а не при открытии вкладки.
   */
  async probe(): Promise<ProxyProbe> {
    const raw = await invoke<RawProxyProbe>('animori_proxy_probe')

    return {
      outcome: raw.outcome,
      server: raw.server,
      reachable: raw.outcome === 'applied',
      latencyMs: raw.latencyMs,
    }
  },
}
