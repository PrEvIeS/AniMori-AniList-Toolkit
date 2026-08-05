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
  DEFAULT_PROXY,
  PROXY_KEYS,
  normalizeProxyKind,
  proxyBypassList,
  proxyUrl,
  type ProxyConfig,
} from '@/core/proxy'

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
// autoSave оставлен как сетка безопасности для чужих путей записи, но ПОЛАГАТЬСЯ на него
// нельзя, и это главный вывод дефекта пункта 4.5: он пишет файл С ЗАДЕРЖКОЙ после
// set(), то есть УЖЕ ПОСЛЕ того, как промис set() разрешён. Перезагрузка окна в это
// окно времени убивает отложенную запись вместе с остальным контекстом — именно так
// настройки сохранялись «через раз» без видимой корреляции: исход зависел от того,
// успел ли таймер сработать до нажатия «Применить и перезагрузить».
const store = new LazyStore('animori-settings.json', { autoSave: true })

/**
 * Снимок всего файла настроек в памяти.
 *
 * Зачем. Каждый store.get() — отдельный переход в процесс оболочки и обратно. На старте
 * их набирается больше тридцати: двадцать четыре ключа в readSettings(), токен AniList,
 * свои ссылки, пользовательский словарь. В браузере эти же чтения бесплатны (GM_getValue
 * синхронный), поэтому разница между сборками ощущается именно как «в приложении
 * запускается заметно дольше и перевод появляется рывком».
 *
 * Решение: один entries() вместо тридцати get(). Дальше чтения обслуживаются из памяти,
 * а записи обновляют снимок вместе с файлом. Снимок — единственный владелец правды на
 * время сессии: файл вне приложения никто не меняет, а все записи проходят через set()
 * ниже.
 */
let snapshot: Map<string, unknown> | null = null

/** Незавершённая загрузка снимка. Нужна, чтобы параллельные чтения не дёргали entries() повторно. */
let snapshotLoading: Promise<Map<string, unknown> | null> | null = null

async function loadSnapshot(): Promise<Map<string, unknown> | null> {
  if (snapshot) return snapshot
  if (snapshotLoading) return snapshotLoading

  snapshotLoading = (async () => {
    try {
      const entries = await store.entries()
      snapshot = new Map(entries)
      return snapshot
    } catch (e) {
      // Молчать нельзя, но и падать незачем: ниже есть путь через store.get() по одному ключу.
      console.error('[AniMori] Не удалось прочитать файл настроек целиком', e)
      return null
    } finally {
      snapshotLoading = null
    }
  })()

  return snapshotLoading
}

/**
 * Незавершённые записи.
 *
 * Нужны потому, что почти ни один вызывающий set() его не ждёт: запись идёт из
 * синхронных setter’ов реактивных моделей и из обработчиков ввода. Следить за этим
 * в прикладном коде бессмысленно: кроме core/settings.ts в хранилище пишут токен
 * AniList, свои ссылки и пользовательский словарь, и каждое такое место пришлось бы
 * помнить отдельно. Учёт живёт здесь — в единственной точке, через которую проходят
 * все записи без исключения.
 */
const pendingWrites = new Set<Promise<void>>()

/**
 * Сколько раз flush() готов дождаться новой партии записей.
 *
 * Прежний цикл while не имел предела: пока идёт непрерывный поток set(), ожидание
 * не заканчивается никогда. Для подвала настроек, где переключатель пишет два ключа
 * подряд, хватает единиц проходов, а верхняя граница превращает возможное зависание
 * кнопки перезагрузки в худшем случае в лишние миллисекунды.
 */
const FLUSH_MAX_ROUNDS = 5

// Перегрузки повторяют MonkeyBridge: объектный литерал не умеет реализовывать перегруженный
// метод, поэтому нужна именно function-декларация.
async function storageGet<T>(key: string, defaultValue: T): Promise<T>
async function storageGet<T = unknown>(key: string): Promise<T | undefined>
async function storageGet<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  const hasDefault = arguments.length >= 2

  const cache = await loadSnapshot()
  const value = cache ? (cache.get(key) as T | undefined) : await store.get<T>(key)

  // В отличие от GM_getValue, store.get возвращает undefined для отсутствующего ключа
  // и дефолт не принимает — подставляем его сами.
  if (value === undefined && hasDefault) return defaultValue as T
  return value
}

/** Собственно запись: значение в стор плюс немедленная выгрузка файла на диск. */
async function writeValue(key: string, value: unknown): Promise<void> {
  // Снимок правится сразу, до похода в оболочку: чтение сразу после set() обязано
  // видеть новое значение, иначе панель настроек показала бы старое.
  if (snapshot) snapshot.set(key, value)

  await store.set(key, value)
  // Явный save() вместо ожидания autoSave: контракт IStorage.set требует, чтобы
  // к моменту разрешения промиса значение было долговечным, а не только поставленным
  // в очередь. Цена — запись файла на каждую настройку; для файла из пары десятков
  // ключей, меняющихся по клику человека, это ничто против потери настроек.
  await store.save()
}

const tauriStorage: IStorage = {
  get: storageGet,

  set(key: string, value: unknown): Promise<void> {
    const write = writeValue(key, value)

    // В реестр кладётся ВЕТВЬ без отклонения: flush() ждёт только окончания очереди
    // и не должен падать из-за чужой ошибки. Сама ошибка при этом не теряется:
    // возвращаемый ниже промис — исходный, и вызывающий код видит её как раньше.
    const tracked = write.catch(() => undefined)
    pendingWrites.add(tracked)
    void tracked.then(() => {
      pendingWrites.delete(tracked)
    })

    return write
  },

  async flush(): Promise<void> {
    // Несколько проходов, а не один Promise.all: пока ждём текущую партию, могли прийти
    // новые записи — именно так ведёт себя подвал настроек, где переключатель типа
    // «Скрывать рекламу» пишет два ключа подряд. Число проходов ограничено: см. FLUSH_MAX_ROUNDS.
    for (let round = 0; round < FLUSH_MAX_ROUNDS; round++) {
      if (pendingWrites.size === 0) return
      await Promise.all([...pendingWrites])
    }
  },
}

// ==== прокси ====

/**
 * Пункт 5.3, часть первая: НАШ канал через прокси.
 *
 * В десктопной сборке трафик разделён на два независимых потока, и это главное, что надо
 * понимать про прокси здесь:
 *
 *   1. Запросы самого сайта — страница, картинки, кадр плеера — идут из WebView2
 *      и настройкой отсюда не управляются вовсе: там нужен аргумент командной строки
 *      при запуске процесса (часть вторая, src-tauri/src/lib.rs).
 *   2. Наши собственные запросы к API идут мимо WebView2 — из процесса оболочки
 *      через tauri-plugin-http. Именно они настраиваются здесь.
 *
 * Следствие для живой проверки: после этой правки через прокси пойдёт перевод,
 * оценки, франшиза, музыка и словарь, а сама страница AniList — пока напрямую.
 * Так и задумано на этом шаге.
 *
 * Тип настройки выведён из самого fetch плагина, а не импортирован по имени:
 * имя экспорта менялось между версиями плагина, а форма второго аргумента — нет.
 */
type TauriFetchOptions = NonNullable<Parameters<typeof tauriFetch>[1]>
type TauriProxyOption = TauriFetchOptions['proxy']

/**
 * Разобранная настройка прокси. Читается ОДИН раз за сеанс и больше не пересматривается.
 *
 * Почему без подписки на изменения: второй канал (WebView2) всё равно требует
 * перезапуска приложения. Если бы наш канал подхватывал новый адрес сразу, а страница —
 * только после перезапуска, приложение жило бы в двух разных сетях одновременно:
 * часть данных из одной страны, часть из другой. Один адрес на весь сеанс — предсказуемо.
 */
let proxyOption: TauriProxyOption
let proxyReady = false

async function loadProxyOption(): Promise<TauriProxyOption> {
  if (proxyReady) return proxyOption

  try {
    const [enabled, kind, host, port, login, password, bypass] = await Promise.all([
      storageGet(PROXY_KEYS.enabled, DEFAULT_PROXY.enabled),
      storageGet(PROXY_KEYS.kind, DEFAULT_PROXY.kind),
      storageGet(PROXY_KEYS.host, DEFAULT_PROXY.host),
      storageGet(PROXY_KEYS.port, DEFAULT_PROXY.port),
      storageGet(PROXY_KEYS.login, DEFAULT_PROXY.login),
      storageGet(PROXY_KEYS.password, DEFAULT_PROXY.password),
      storageGet(PROXY_KEYS.bypass, DEFAULT_PROXY.bypass),
    ])

    const config: ProxyConfig = {
      enabled,
      kind: normalizeProxyKind(kind),
      host: String(host ?? ''),
      port,
      login: String(login ?? ''),
      password: String(password ?? ''),
      bypass: String(bypass ?? ''),
    }

    const url = proxyUrl(config)

    if (config.enabled && !url) {
      // Включён, но настроен негодно. Молчать нельзя (инвариант 4): иначе человек
      // видит включённый тумблер и думает, что идёт через прокси, а трафик идёт напрямую.
      // Логгер здесь недоступен по той же причине, что и в core/settings.ts: он сам
      // читает мост, и импорт дал бы цикл.
      console.warn(
        '[AniMori] Прокси включён, но адрес или порт заданы неверно — запросы идут напрямую',
      )
    }

    if (url) {
      const noProxy = proxyBypassList(config).join(',')
      const trimmedLogin = config.login.trim()

      proxyOption = {
        all: {
          url,
          // Учётные данные передаются отдельно, а не в составе адреса: пароль с
          // двоеточием или собакой сломал бы склейку user:pass@host.
          ...(trimmedLogin ? { basicAuth: { username: trimmedLogin, password: config.password } } : {}),
          ...(noProxy ? { noProxy } : {}),
        },
      }
    } else {
      proxyOption = undefined
    }
  } catch (e) {
    console.error('[AniMori] Не удалось прочитать настройки прокси, запросы идут напрямую', e)
    proxyOption = undefined
  } finally {
    proxyReady = true
  }

  return proxyOption
}

// ==== http ====

const tauriHttp: IHttp = {
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    const { url, method = 'GET', headers, body, timeoutMs, credentials = 'include' } = options

    // Настройка прокси берётся ДО запуска таймера: первое чтение идёт в оболочку,
    // и съедать им таймаут запроса (у зеркал Shikimori — 5000 мс) было бы неверно.
    const proxy = await loadProxyOption()

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
        // Ключ добавляется только когда прокси настроен: явный proxy: undefined
        // плагин принимает, но пустой ключ в параметрах — лишний повод для вопросов
        // при разборе сетевых сбоев.
        ...(proxy ? { proxy } : {}),
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
      //
      // Пункт 5.3: мёртвый или неверно указанный прокси приходит сюда же и выглядит
      // как обычный сетевой сбой — то есть как недоступность ВСЕГО сразу. Разделить
      // одно от другого по ответу reqwest невозможно, поэтому разбор оставлен
      // проверке сети во вкладке «Разработчик»: если лежат все источники без
      // исключения, виноват канал, а не службы.
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
 * Подсистема оболочки: свои команды из src-tauri/src/lib.rs плюс история WebView.
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
 * Пункт 4.5 (шаги по истории): здесь, наоборот, команда не нужна. History API в
 * WebView2 работает как в браузере, и — что важнее — AniList это SPA: шаг назад должен
 * отдаваться его маршрутизатору через popstate, иначе вместо мгновенного возврата
 * получилась бы полная перезагрузка документа со сбросом всего нашего состояния.
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

  back(): Promise<void> {
    // Сознательно без invoke: шаг должен пройти через историю самого WebView,
    // чтобы маршрутизатор AniList получил popstate и перерисовал страницу сам.
    history.back()
    return Promise.resolve()
  },

  forward(): Promise<void> {
    history.forward()
    return Promise.resolve()
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
