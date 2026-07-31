// Пункт 1.6 плана: загрузка удалённой базы словаря интерфейса (DICT_URL).
//
// Запрос жил прямо в main.ts и дёргал GM_xmlhttpRequest в обход слоя api/.
// На Этапе 3 все GM_* заменяются на Bridge.http, и такие «забытые» вызовы
// снаружи src/api/ пришлось бы вычищать руками — поэтому перенесён сюда.
//
// Итерация 3.5.3: этот запрос оставался последним прямым вызовом GM_xmlhttpRequest
// вне MonkeyBridge — переведён на Bridge.http.
//
// Промис никогда не отклоняется: без словаря переводчик вся равно умеет даты,
// счётчики и русские названия тайтлов, поэтому сбой загрузки не должен ронять
// bootstrap(). Отсутствие данных сигнализируется через null.

import { Bridge } from '@/bridge'
import { DICT_URL } from '../core/constants'
import { Logger } from '../utils/logger'

/**
 * Тянет общую базу переводов интерфейса с GitHub.
 *
 * Таймаут намеренно не выставлен — так было в монолите. Словарь весит ~180 КБ,
 * и жёсткий лимит рубил бы загрузку на медленном канале.
 *
 * credentials: 'omit' — чужой домен и статика без авторизации, куки туда шлать незачем.
 *
 * @returns Объект { "Original": "Перевод" } либо null, если словарь не получен.
 */
export async function fetchInterfaceDictionary(): Promise<Record<string, string> | null> {
  try {
    const res = await Bridge.http.request({
      method: 'GET',
      url: DICT_URL,
      credentials: 'omit',
    })
    if (!res.ok) {
      Logger('ERROR', 'Словарь интерфейса не отдался', { status: res.status, url: res.url })
      return null
    }
    return JSON.parse(res.text) as Record<string, string>
  } catch (e) {
    // Сюда попадают и сетевые сбои (BridgeHttpError), и битый JSON. Реакция одна:
    // работаем без общего словаря, а не падаем на старте.
    Logger('ERROR', 'Не удалось загрузить словарь интерфейса', e)
    return null
  }
}
