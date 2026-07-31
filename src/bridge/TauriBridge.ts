// Пункт 3.3 плана: реализация IBridge для десктопной оболочки Tauri.
//
// Модуль НЕ должен попадать в бандл юзерскрипта: импорты @tauri-apps/* в браузере
// неработоспособны. Отсечение обеспечено пунктом 3.4: resolve.alias в vite.config.ts
// разводит '@bridge-impl' по mode сборки, и при mode !== 'tauri' этот файл вообще не
// попадает в граф модулей — это надёжнее tree-shaking'а по ветвлению, потому
// что new LazyStore(...) ниже — верхнеуровневый побочный эффект, который Rollup вправе сохранить.

import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { LazyStore } from '@tauri-apps/plugin-store'

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

// LazyStore выбран вместо load(): он не требует await при создании и читает файл при первом
// обращении. Альтернатива потребовала бы верхнеуровневого await либо ручной инициализации
// из main.ts, а это разные точки входа для двух платформ — ровно того, чего этап избегает.
//
// autoSave пишет файл с небольшой задержкой после set(), что ближе всего к поведению
// GM_setValue и избавляет потребителей от знания про save().
const store = new LazyStore('animori-settings.json', { autoSave: true })

// Перегрузки повторяют MonkeyBridge: объектный литерал не умеет реализовывать перегруженный
// метод, поэтому нужна именно function-декларация.
async function storageGet<T>(key: string, defaultValue: T): Promise<T>
async function storageGet<T = unknown>(key: string): Promise<T | undefined>
async function storageGet<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  const hasDefault = arguments.length >= 2
  const value = await store.get<T>(key)

  // В отличие от GM_getValue, store.get возвращает undefined для отсутствующего ключа
  // и дефолт не принимает — подставляем его сами.
  if (value === undefined && hasDefault) return defaultValue as T
  return value
}

const tauriStorage: IStorage = {
  get: storageGet,
  async set(key: string, value: unknown): Promise<void> {
    await store.set(key, value)
  },
}

// ==== http ====

const tauriHttp: IHttp = {
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    const { url, method = 'GET', headers, body, timeoutMs, credentials = 'include' } = options

    // У fetch плагина есть connectTimeout, но он ограничивает только фазу установки соединения.
    // GM_xmlhttpRequest считает таймаут на весь запрос целиком, и именно на это опирается
    // перебор зеркал в fetchShiki (5000 мс). Поэтому таймаут делается через AbortController.
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }

    try {
      const res = await tauriFetch(url, {
        method,
        headers,
        body,
        credentials,
        signal: controller.signal,
      })

      const text = await res.text()

      // Headers уже нормализует имена к нижнему регистру и склеивает повторы через запятую —
      // ровно тот же вид, который вручную собирает parseRawHeaders в MonkeyBridge.
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value
      })

      return {
        status: res.status,
        statusText: res.statusText,
        ok: res.status >= 200 && res.status < 300,
        headers: responseHeaders,
        text,
        url: res.url || url,
      }
    } catch (e) {
      // Код вне 2xx сюда не попадает: fetch отклоняется только на транспортных сбоях.
      if (timedOut) throw new BridgeHttpError('timeout', url)

      const name = e instanceof Error ? e.name : ''
      if (name === 'AbortError') throw new BridgeHttpError('abort', url)

      throw new BridgeHttpError('network', url)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  },
}

// ==== clipboard ====

const tauriClipboard: IClipboard = {
  async writeText(text: string): Promise<void> {
    // Фоллбэка на navigator.clipboard здесь нет осознанно: в WebView2 он требует безопасного
    // контекста и жеста пользователя, а падение плагина означает невыданное разрешение
    // clipboard-manager:allow-write-text — это ошибка конфигурации Этапа 4, её надо видеть,
    // а не глушить тихим обходным путём.
    await writeText(text)
  },
}

// ==== shell ====

/**
 * Подсистема оболочки: свои команды из src-tauri/src/lib.rs.
 *
 * Пункт 4.3 (перезагрузка): location.reload() в окне, открытом на внешнем URL, не даёт
 * ничего, а в JS-API Tauri метода перезагрузки нет совсем — он есть только у окна на
 * стороне Rust (WebviewWindow::reload).
 *
 * Пункт 4.5 (внешние ссылки): в WebView2 нет новых вкладок, и запрос на открытие
 * окна отбрасывается молча, поэтому адрес отдаётся системному браузеру через свою
 * команду поверх tauri-plugin-opener. Плагинная команда opener:allow-open-url НЕ выдана
 * намеренно: она позволила бы любому скрипту страницы открывать произвольные схемы,
 * а своя команда разрешает только http и https.
 *
 * Про ACL: собственные команды тоже требуют разрешения, когда окно открыто на внешнем
 * URL — это выяснилось на живом запуске по отказу "animori_reload not allowed. Plugin
 * not found". Блок remote.urls открывает доступ к IPC, но не заменяет разрешений:
 * имена команд перечислены в src-tauri/build.rs и в capabilities/default.json.
 */
const tauriShell: IShell = {
  async reload(): Promise<void> {
    await invoke('animori_reload')
  },

  async openExternal(url: string): Promise<void> {
    // Проверка схемы живёт на стороне Rust: здешний код выполняется в контексте
    // чужого сайта и сам доверенным барьером быть не может.
    await invoke('animori_open_external', { url })
  },
}

// ==== сборка ====

export const tauriBridge: IBridge = {
  platform: 'tauri',
  storage: tauriStorage,
  http: tauriHttp,
  clipboard: tauriClipboard,
  shell: tauriShell,
}

// Пункт 3.4: общее для обеих реализаций имя экспорта — см. хвост MonkeyBridge.ts.
export { tauriBridge as platformBridge }
