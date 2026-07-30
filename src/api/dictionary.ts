// Пункт 1.6 плана: загрузка удалённой базы словаря интерфейса (DICT_URL).
//
// Запрос жил прямо в main.ts и дёргал GM_xmlhttpRequest в обход слоя api/.
// На Этапе 3 все GM_* заменяются на bridge.http, и такие «забытые» вызовы
// снаружи src/api/ пришлось бы вычищать руками — поэтому перенесён сюда.
//
// Промис никогда не отклоняется: без словаря переводчик всё равно умеет даты,
// счётчики и русские названия тайтлов, поэтому сбой загрузки не должен ронять
// bootstrap(). Отсутствие данных сигнализируется через null.

import { DICT_URL } from '../core/constants'
import { Logger } from '../utils/logger'

/**
 * Тянет общую базу переводов интерфейса с GitHub.
 *
 * Таймаут намеренно не выставлен — так было в монолите. Словарь весит ~180 КБ,
 * и жёсткий лимит рубил бы загрузку на медленном канале. Кандидат на пересмотр
 * на Этапе 3, когда запрос поедет через bridge.http.
 *
 * @returns Объект { "Original": "Перевод" } либо null, если словарь не получен.
 */
export function fetchInterfaceDictionary(): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: DICT_URL,
      onload: (res) => {
        try {
          resolve(JSON.parse(res.responseText) as Record<string, string>)
        } catch (e) {
          Logger('ERROR', 'Не удалось разобрать словарь интерфейса', e)
          resolve(null)
        }
      },
      onerror: (e) => {
        Logger('ERROR', 'Сетевая ошибка при загрузке словаря', e)
        resolve(null)
      },
    })
  })
}
