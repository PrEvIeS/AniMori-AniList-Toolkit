// Пункт 1.3 плана: настройки пользовательских внешних ссылок (строки 213–222 монолита).
//
// JSON-массив в GM_getValue('am_custom_links'): [{ name, url, color }], где:
//   url — шаблон с {ru}/{romaji}/{query}
//   color — триплет "r,g,b"
//
// РИСК №1 из AUDITION.md: GM_getValue синхронный. На Этапе 3 это заменится на async
// bridge.storage.get. Пока переносим 1:1 без изменений.

import { Logger } from '../utils/logger'

export interface CustomLink {
  name: string
  url: string
  /** Триплет "r,g,b" для --c в CSS. */
  color: string
}

/** Палитра по умолчанию: 6 триплетов для новых ссылок. */
export const CL_COLORS = [
  '61,180,242',
  '243,139,168',
  '183,148,244',
  '166,227,161',
  '246,193,119',
  '224,82,100',
]

/** Читает массив кастомных ссылок из GM_getValue. */
export function getCustomLinks(): CustomLink[] {
  try {
    const raw = GM_getValue('am_custom_links', '[]')
    const arr = Array.isArray(raw) ? raw : JSON.parse((raw as string) || '[]')
    return Array.isArray(arr) ? (arr as CustomLink[]) : []
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения am_custom_links', e)
    return []
  }
}

/** Сохраняет массив кастомных ссылок в GM_setValue. */
export function setCustomLinks(arr: CustomLink[]): void {
  try {
    GM_setValue('am_custom_links', JSON.stringify(arr))
  } catch (e) {
    Logger('ERROR', 'Ошибка записи am_custom_links', e)
  }
}
