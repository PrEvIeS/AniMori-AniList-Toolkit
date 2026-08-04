// Пункт 1.6 плана: загрузка удалённой базы словаря интерфейса (DICT_URL).
//
// Запрос жил прямо в main.ts и дёргал GM_xmlhttpRequest в обход слоя api/.
// На Этапе 3 все GM_* заменяются на Bridge.http, и такие «забытые» вызовы
// снаружи src/api/ пришлось бы вычищать руками — поэтому перенесён сюда.
//
// Итерация 3.5.3: этот запрос оставался последним прямым вызовом GM_xmlhttpRequest
// вне MonkeyBridge — переведён на Bridge.http.
//
// Правка пункта 4.5 (дефект «перевод периодически пропадает целиком»). До сих пор
// словарь тянулся из сети ПРИ КАЖДОМ старте и нигде не сохранялся. Не отдался
// — приложение молча работало без него, то есть с английским интерфейсом. В браузере
// это почти не заметно: вкладка живёт часами, старт случается редко. В десктопной
// сборке старт происходит на каждой перезагрузке окна, и лотерея стала видной:
// «перевод пропал, лечится парой перезагрузок» — это ровно повторная попытка сходить
// в сеть. Корреляции с действиями человека здесь нет и быть не может.
//
// Теперь словарь кэшируется в IndexedDB и применяется сразу, а сеть остаётся только
// способом его обновить. Заодно из цепочки старта уходит самый долгий шаг: всё,
// что стоит за ним — переводчик, поиск, медиа-виджеты — больше не ждёт GitHub.
//
// Промис никогда не отклоняется: без словаря переводчик всё равно умеет даты,
// счётчики и русские названия тайтлов, поэтому сбой загрузки не должен ронять
// bootstrap(). Отсутствие данных сигнализируется через null.
//
// Итерация 5.1: исход запроса отдаётся в core/net-health. Учёт ни на что здесь
// не влияет — он только запоминает, что источник ответил или не ответил.

import { Bridge } from '@/bridge'
import { DICT_URL } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { reportError, reportStatus } from '../core/net-health'
import type { ShikiCacheRecord } from '../core/types'
import { Logger } from '../utils/logger'

/** Словарь интерфейса: оригинал — перевод. */
export type InterfaceDictionary = Record<string, string>

/**
 * Идентификатор источника в учёте состояния сети.
 *
 * Словарь лежит на raw.githubusercontent.com — том же хосте, что и ничто другое
 * в проекте, поэтому источник отдельный и его отказ ни с чем не смешивается.
 */
export const NET_SOURCE_DICT = 'dictionary'
export const NET_LABEL_DICT = 'Словарь (GitHub)'

/**
 * Ключ записи в shikiCache.
 *
 * Префикс намеренно не совпадает ни с одним из счётных (MED2_, CHR2_, STF3_,
 * THEMES2_, FULL_): иначе словарь попал бы в статистику инспектора как лишняя
 * карточка тайтла.
 */
const DICT_CACHE_KEY = 'IFACE_DICT_v1'

/**
 * Через сколько считаем кэш устаревшим и идём за обновлением в фон.
 *
 * Двенадцать часов — компромисс. Словарь пополняется редко, а каждый лишний рейс
 * за 180 КБ — это трафик и ещё один повод для сетевого сбоя.
 */
const DICT_TTL_MS = 12 * 60 * 60 * 1000

/** Что лежит в кэше. */
interface CachedDictionary {
  dict: InterfaceDictionary
  /** Когда словарь реально пришёл из сети. Свежесть считается по нему. */
  fetchedAt: number
}

/**
 * Тянет общую базу переводов интерфейса с GitHub.
 *
 * Таймаут намеренно не выставлен — так было в монолите. Словарь весит ~180 КБ,
 * и жёсткий лимит рубил бы загрузку на медленном канале. Теперь это ещё и безопасно:
 * долгий запрос больше никого не задерживает, потому что идёт в фоне.
 *
 * credentials: 'omit' — чужой домен и статика без авторизации, куки туда шлать незачем.
 *
 * @returns Объект { "Original": "Перевод" } либо null, если словарь не получен.
 */
export async function fetchInterfaceDictionary(): Promise<InterfaceDictionary | null> {
  const startedAt = Date.now()
  try {
    const res = await Bridge.http.request({
      method: 'GET',
      url: DICT_URL,
      credentials: 'omit',
    })
    reportStatus(NET_SOURCE_DICT, NET_LABEL_DICT, res.status, Date.now() - startedAt)
    if (!res.ok) {
      Logger('ERROR', 'Словарь интерфейса не отдался', { status: res.status, url: res.url })
      return null
    }
    return JSON.parse(res.text) as InterfaceDictionary
  } catch (e) {
    // Сюда попадают и сетевые сбои (BridgeHttpError), и битый JSON. Реакция одна:
    // работаем без общего словаря, а не падаем на старте.
    //
    // В учёт уходит тот же случай: сетевую ошибку net-health разберёт по её типу,
    // а разбор JSON состояние источника не меняет — хост-то ответил.
    reportError(NET_SOURCE_DICT, NET_LABEL_DICT, e, Date.now() - startedAt)
    Logger('ERROR', 'Не удалось загрузить словарь интерфейса', e)
    return null
  }
}

/**
 * Кладёт словарь в кэш.
 *
 * Поле ts — это НЕ время загрузки, а время последнего обращения, и это важно:
 * фоновый сборщик мусора в core/db.ts чистит shikiCache именно по ts старше CACHE_TIME.
 * Если бы здесь лежало время загрузки, словарь у человека без сети выметало бы
 * ровно тогда, когда он нужнее всего. Свежесть самих данных живёт в data.fetchedAt.
 */
async function saveDictionary(dict: InterfaceDictionary, fetchedAt: number): Promise<void> {
  const record: ShikiCacheRecord<CachedDictionary> = {
    key: DICT_CACHE_KEY,
    data: { dict, fetchedAt },
    ts: Date.now(),
  }
  await dbSet('shikiCache', record)
}

/**
 * Главная точка входа для старта: применить словарь как можно раньше.
 *
 * Порядок действий:
 *   1) есть кэш — применяем его немедленно, без единого сетевого запроса;
 *   2) кэш устарел — обновляем в фоне и применяем повторно, когда придёт;
 *   3) кэша нет совсем — только тут старт ждёт сеть, и только один раз за установку.
 *
 * @param apply Вызывается с готовым словарём. Может быть вызван ДВАЖДЫ: сначала с кэшем,
 *   потом с обновлённой версией. Повторный вызов безопасен: setRemoteDict() пересобирает
 *   словарь и сам запускает повторный перевод страницы.
 * @returns true, если словарь был применён хоть один раз к моменту возврата.
 */
export async function loadInterfaceDictionary(
  apply: (dict: InterfaceDictionary) => void,
): Promise<boolean> {
  const cached = await dbGet<ShikiCacheRecord<CachedDictionary>>('shikiCache', DICT_CACHE_KEY)
  const cachedDict = cached?.data?.dict

  if (cachedDict) {
    const ageMin = Math.round((Date.now() - (cached?.data.fetchedAt ?? 0)) / 60000)
    Logger('API', `Словарь интерфейса взят из кэша (возраст ${ageMin} мин)`)
    apply(cachedDict)

    const fresh = Date.now() - (cached?.data.fetchedAt ?? 0) < DICT_TTL_MS
    if (fresh) {
      // Продлеваем время последнего обращения, чтобы сборщик мусора не снёс
      // активно используемую запись. Не ждём: на старт это никак не влияет.
      void saveDictionary(cachedDict, cached?.data.fetchedAt ?? Date.now())
      return true
    }

    // Фоновое обновление. Сбой здесь ничего не портит: на экране уже рабочая
    // прежняя версия, и старый перевод лучше отсутствующего.
    void (async () => {
      const freshdict = await fetchInterfaceDictionary()
      if (!freshdict) return
      apply(freshdict)
      await saveDictionary(freshdict, Date.now())
      Logger('API', 'Словарь интерфейса обновлён в фоне')
    })()

    return true
  }

  // Кэша нет: первый запуск либо только что очищенный кэш. Ждём сеть — иначе
  // человек увидит английский интерфейс и решит, что перевод сломался.
  Logger('API', 'Кэш словаря пуст, загрузка из сети...')
  const dict = await fetchInterfaceDictionary()
  if (!dict) return false

  apply(dict)
  await saveDictionary(dict, Date.now())
  return true
}
