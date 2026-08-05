// Пункт 5.3.6: реализация IProxyDiagnostics для десктопной сборки.
//
// Вынесено из TauriBridge.ts отдельным файлом ради размера: тот файл уже самый
// толстый в проекте. Инвариант №1 не нарушен: файл лежит ВНУТРИ src/bridge и
// в граф юзерскрипта не попадает — его импортирует только TauriBridge, а тот отсекается
// псевдопутём '@bridge-impl' в vite.config.ts. Прикладной код сюда не ходит никогда:
// ему доступен только Bridge.proxyDiagnostics из '@/bridge'.

import { invoke } from '@tauri-apps/api/core'

import type { IProxyDiagnostics, ProxyOutcome, ProxyProbe, ProxyStatus } from './IBridge'

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
   * apply_to_webview() ещё до создания окна. Никакой сетевой работы здесь не ведётся,
   * вызов дешёвый и его можно делать при каждом открытии панели.
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

  /**
   * Пункт 5.3.7: сообщает оболочке, что страница ожила.
   *
   * Команда ничего не возвращает: на той стороне она лишь поднимает флаг, по которому
   * сторож прокси решает, вмешиваться ему или нет.
   */
  async markPageReady(): Promise<void> {
    try {
      await invoke('animori_page_ready')
    } catch (e) {
      // Контракт запрещает отклонение, и это не перестраховка: отметка — страховка от
      // редкого отказа, а не работа, ради которой страница существует. Уронить из-за
      // неё старт было бы обменом частой беды на редкую.
      //
      // Логгер здесь недоступен по той же причине, что и в остальном мосте: он сам
      // читает мост, и импорт замкнул бы цикл. След остаётся в консоли.
      console.warn('[AniMori] Не удалось отметить готовность страницы', e)
    }
  },
}
