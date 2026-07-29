// Пункт 1.3 плана: локальный словарь переводов (строки 227–261 монолита).
//
// Двухуровневая схема: удалённая база (DICT_URL с GitHub) + правки пользователя.
// Итоговый словарь = Object.assign(remoteDict, getUserDict()).
//
// РИСК №1 из AUDITION.md: getUserDict/setUserDict синхронные, потому что GM_getValue
// синхронный. На Этапе 3 это заменится на async bridge.storage.get. Пока — 1:1.
//
// amRetranslate — коллбэк из initTranslator (features/translator/), вызывается при
// изменении словаря, чтобы перевести страницу заново. Устанавливается через сеттер.

import { Logger } from '../utils/logger'

/**
 * Удалённая база с GitHub (DICT_URL). Приватная переменная, устанавливается
 * единожды при инициализации через setRemoteDict().
 */
let remoteDict: Record<string, string> = Object.create(null)

/**
 * Коллбэк для повторного перевода DOM после изменения словаря.
 * Устанавливается через registerRetranslateCallback().
 */
let amRetranslate: (() => void) | null = null

/**
 * Итоговый словарь (база + правки юзера). Глобальная переменная dictionary из IIFE
 * станет приватной на Этапе 2, когда переводчик переедет в Vue. Пока оставляем здесь
 * для совместимости с остатком монолита.
 */
export let dictionary: Record<string, string> = Object.create(null)

/** Нормализует ключ: схлопывает пробелы и триммит. */
function normDictKey(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Читает правки пользователя из GM_getValue. */
export function getUserDict(): Record<string, string> {
  try {
    const raw = GM_getValue('am_user_dict', '{}')
    const obj = raw && typeof raw === 'object' ? raw : JSON.parse((raw as string) || '{}')
    return obj && typeof obj === 'object' && !Array.isArray(obj)
      ? (obj as Record<string, string>)
      : {}
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения am_user_dict', e)
    return {}
  }
}

/** Сохраняет правки пользователя в GM_setValue. */
export function setUserDict(obj: Record<string, string>): void {
  try {
    GM_setValue('am_user_dict', JSON.stringify(obj))
  } catch (e) {
    Logger('ERROR', 'Ошибка записи am_user_dict', e)
  }
}

/** Пересобирает итоговый словарь: база + правки юзера. */
export function rebuildDictionary(): void {
  dictionary = Object.assign(Object.create(null), remoteDict, getUserDict())
}

/**
 * Добавляет/обновляет запись в пользовательском словаре и применяет вживую.
 * @returns false, если ключ или значение пустые.
 */
export function upsertUserDictEntry(source: string, translation: string): boolean {
  const k = normDictKey(source)
  const v = normDictKey(translation)
  if (!k || !v) return false

  const ud = getUserDict()
  ud[k] = v
  setUserDict(ud)
  rebuildDictionary()

  if (typeof amRetranslate === 'function') amRetranslate()
  return true
}

/** Удаляет запись из пользовательского словаря. */
export function removeUserDictEntry(source: string): void {
  const k = normDictKey(source)
  const ud = getUserDict()
  if (Object.prototype.hasOwnProperty.call(ud, k)) {
    delete ud[k]
    setUserDict(ud)
    rebuildDictionary()
  }
}

/**
 * Устанавливает удалённую базу словаря (вызывается из bootstrap() при старте).
 * @param dict Объект { "Original": "Translation" } с GitHub.
 */
export function setRemoteDict(dict: Record<string, string>): void {
  remoteDict = dict
  rebuildDictionary()
}

/**
 * Регистрирует коллбэк для ре-скана DOM (вызывается из initTranslator).
 * @param callback Функция, которая перезапускает перевод страницы.
 */
export function registerRetranslateCallback(callback: () => void): void {
  amRetranslate = callback
}
