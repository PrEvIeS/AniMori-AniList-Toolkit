// Пункт 1.3 плана: локальный словарь переводов (строки 227–261 монолита).
//
// Двухуровневая схема: удалённая база (DICT_URL с GitHub) + правки пользователя.
// Итоговый словарь = Object.assign(remoteDict, getUserDict()).
//
// Итерация 3.5.3: GM_getValue/GM_setValue заменены на Bridge.storage. Хранилище
// асинхронное, а переводчик читает словарь синхронно на каждом проходе по DOM,
// поэтому правки держим в памяти: loadUserDict() один раз наполняет кэш при старте,
// getUserDict() отдаёт копию кэша, setUserDict() сначала обновляет память и только
// потом пишет в хранилище. Тот же приём, что и в core/settings.ts.
//
// amRetranslate — коллбэк из initTranslator (features/translator/), вызывается при
// изменении словаря, чтобы перевести страницу заново. Устанавливается через сеттер.

import { Bridge } from '@/bridge'
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

const STORAGE_KEY = 'am_user_dict'

/** Кэш правок в памяти: getUserDict() обязан оставаться синхронным. */
let userDictCache: Record<string, string> = {}

/**
 * Итоговый словарь (база + правки юзера). Глобальная переменная dictionary из IIFE
 * станет приватной на Этапе 2, когда переводчик переедет в Vue. Пока оставляем здесь
 * для совместимости с остатком монолита.
 */
export let dictionary: Record<string, string> = Object.create(null)

/**
 * Нормализует ключ: схлопывает пробелы и триммит.
 *
 * Экспортируется, потому что захват выделенного текста (features/search/dict-capture.ts)
 * обязан нормализовать выделение точно так же: иначе запись ляжет в словарь с
 * другим ключом и переводчик её не поймает.
 */
export function normDictKey(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Разбирает значение из хранилища: там может лежать и строка, и готовый объект. */
function parseDict(raw: unknown): Record<string, string> {
  const obj = raw && typeof raw === 'object' ? raw : JSON.parse((raw as string) || '{}')
  return obj && typeof obj === 'object' && !Array.isArray(obj)
    ? (obj as Record<string, string>)
    : {}
}

/**
 * Наполняет кэш правок из хранилища. Вызывается один раз из bootstrap() до
 * rebuildDictionary(), иначе первый проход переводчика прошёл бы без правок юзера.
 */
export async function loadUserDict(): Promise<void> {
  try {
    const raw = await Bridge.storage.get<unknown>(STORAGE_KEY, '{}')
    userDictCache = parseDict(raw)
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения am_user_dict', e)
    userDictCache = {}
  }
}

/**
 * Отдаёт копию правок. Копия, а не сам объект: раньше каждый вызов возвращал свежий
 * результат JSON.parse, и правки в нём не влияли на сохранённые данные до setUserDict().
 */
export function getUserDict(): Record<string, string> {
  return { ...userDictCache }
}

/**
 * Сохраняет правки: сначала память, затем хранилище. Никогда не бросает исключение,
 * иначе добавление слова из выделения падало бы на ошибке записи.
 */
export function setUserDict(obj: Record<string, string>): void {
  userDictCache = obj && typeof obj === 'object' ? { ...obj } : {}
  void Bridge.storage.set(STORAGE_KEY, JSON.stringify(userDictCache)).catch((e) => {
    Logger('ERROR', 'Ошибка записи am_user_dict', e)
  })
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
