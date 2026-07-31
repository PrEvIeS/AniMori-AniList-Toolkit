// Пункт 3.2 плана: реализация IBridge поверх API менеджера юзерскриптов.
//
// Это единственное место в проекте, где вызовы GM_* останутся после пункта 3.5.
// Никакой прикладной логики здесь быть не должно: ограничитель скорости Shikimori,
// перебор зеркал, бэкоффы и повторы остаются выше, в src/api/. Мост — только транспорт.

import {
  BridgeHttpError,
  type HttpRequestOptions,
  type HttpResponse,
  type IBridge,
  type IClipboard,
  type IHttp,
  type IShell,
  type IStorage,
} from './IBridge'

// ==== storage ====

// GM_getValue синхронен, но контракт асинхронен (РИСК №1): оборачиваем в готовый промис.
// Проверка идёт по arguments.length, а не по `defaultValue === undefined`: вызов с явно
// переданным undefined в качестве дефолта должен отличаться от вызова без дефолта.
function storageGet<T>(key: string, defaultValue: T): Promise<T>
function storageGet<T = unknown>(key: string): Promise<T | undefined>
function storageGet<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  if (arguments.length >= 2) {
    return Promise.resolve(GM_getValue<T>(key, defaultValue as T))
  }
  return Promise.resolve(GM_getValue(key) as T | undefined)
}

const monkeyStorage: IStorage = {
  get: storageGet,
  set(key: string, value: unknown): Promise<void> {
    GM_setValue(key, value)
    return Promise.resolve()
  },
}

// ==== http ====

/**
 * Разбирает сырую строку responseHeaders в объект с ключами в нижнем регистре.
 *
 * GM_xmlhttpRequest отдаёт заголовки одной строкой вида "name: value\r\n...", а Tauri —
 * объектом Headers. Контракт требует общего вида, иначе чтение retry-after в
 * anilistQuery вело бы себя по-разному на разных платформах.
 */
export function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out

  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    // Пустые строки и строка статуса без двоеточия пропускаются.
    if (separator <= 0) continue

    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (!name) continue

    // Повторяющиеся заголовки склеиваем через запятую — так же поступает Headers.
    const existing = out[name]
    out[name] = existing === undefined ? value : `${existing}, ${value}`
  }

  return out
}

/** Предупреждаем об игнорируемом анонимном режиме один раз за сессию, а не на каждый запрос. */
let anonymousWarningShown = false

/**
 * Поддерживает ли менеджер анонимные запросы.
 *
 * Поле anonymous есть в Tampermonkey и Violentmonkey, но не в Greasemonkey 4: там оно
 * просто игнорируется и куки всё равно уйдут. Молча делать вид, что режим сработал,
 * контракт запрещает.
 */
function supportsAnonymous(): boolean {
  const handler = typeof GM_info === 'object' ? (GM_info?.scriptHandler ?? '') : ''
  return handler === 'Tampermonkey' || handler === 'Violentmonkey'
}

const monkeyHttp: IHttp = {
  request(options: HttpRequestOptions): Promise<HttpResponse> {
    const { url, method = 'GET', headers, body, timeoutMs, credentials = 'include' } = options

    return new Promise<HttpResponse>((resolve, reject) => {
      const details: GMXhrDetails = {
        method,
        url,
        onload: (res) => {
          resolve({
            status: res.status,
            statusText: res.statusText,
            // Код вне 2xx — НЕ ошибка: см. комментарий к IHttp.request.
            ok: res.status >= 200 && res.status < 300,
            headers: parseRawHeaders(res.responseHeaders ?? ''),
            text: res.responseText,
            url: res.finalUrl || url,
          })
        },
        onerror: () => reject(new BridgeHttpError('network', url)),
        ontimeout: () => reject(new BridgeHttpError('timeout', url)),
        onabort: () => reject(new BridgeHttpError('abort', url)),
      }

      if (headers) details.headers = headers
      if (body !== undefined) details.data = body
      if (timeoutMs !== undefined) details.timeout = timeoutMs

      if (credentials === 'omit') {
        if (supportsAnonymous()) {
          details.anonymous = true
        } else if (!anonymousWarningShown) {
          anonymousWarningShown = true
          // Логгер здесь недоступен: utils/logger читает настройки, а настройки на пункте 3.5
          // сами начнут ходить через мост — получилась бы циклическая зависимость.
          console.warn(
            '[AniMori] Менеджер юзерскриптов не поддерживает анонимные запросы: ' +
              'credentials "omit" выполнен как "include", куки будут отправлены.',
          )
        }
      }

      GM_xmlhttpRequest(details)
    })
  },
}

// ==== clipboard ====

const monkeyClipboard: IClipboard = {
  async writeText(text: string): Promise<void> {
    // GM_setClipboard синхронен и не требует фокуса документа, поэтому он первый:
    // navigator.clipboard падает, когда вкладка неактивна или нет жеста пользователя.
    try {
      GM_setClipboard(text)
      return
    } catch (e) {
      console.warn('[AniMori] GM_setClipboard недоступен, пробуем navigator.clipboard', e)
    }

    await navigator.clipboard.writeText(text)
  },
}

// ==== shell ====

const monkeyShell: IShell = {
  reload(): Promise<void> {
    // В браузере это ровно то, что было в подвале настроек до пункта 4.3.
    // Промис возвращается разрешённым только ради единого контракта: код после
    // этой строки всё равно умрёт вместе со страницей.
    location.reload()
    return Promise.resolve()
  },

  openExternal(url: string): Promise<void> {
    // Пункт 4.5. В браузере никакого участия оболочки не требуется: новая вкладка —
    // штатное поведение. GM_openInTab намеренно НЕ используется: он потребовал бы
    // нового @grant в шапке юзерскрипта, а шапку мы не расширяем без нужды.
    //
    // noopener обязателен: иначе открытая страница получит ссылку на window.opener
    // и сможет переписать адрес нашего окна.
    window.open(url, '_blank', 'noopener')
    return Promise.resolve()
  },
}

// ==== сборка ====

export const monkeyBridge: IBridge = {
  platform: 'userscript',
  storage: monkeyStorage,
  http: monkeyHttp,
  clipboard: monkeyClipboard,
  shell: monkeyShell,
}

// Пункт 3.4: общее для обеих реализаций имя экспорта.
//
// src/bridge/index.ts импортирует platformBridge из псевдопути '@bridge-impl', который
// resolve.alias разводит на этот файл или на TauriBridge в зависимости от mode сборки.
// Одинаковое имя избавляет точку входа от любых ветвлений: вторая реализация просто
// не попадает в граф модулей, а вместе с ней и пакеты @tauri-apps/*.
export { monkeyBridge as platformBridge }
