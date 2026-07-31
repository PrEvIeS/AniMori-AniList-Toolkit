// Пункт 4.5: ссылки в десктопной сборке.
//
// Задача модуля — вернуть привычное поведение ссылок внутри окна Tauri:
// • внешние адреса открываются в браузере пользователя;
// • адреса anilist.co остаются в окне приложения.
//
// ПОЧЕМУ ЭТО НУЖНО. В WebView2 нет вкладок. Любой target="_blank" и любой
// window.open() превращаются в запрос создать новое окно, и если оболочка его не
// обрабатывает, запрос отбрасывается МОЛЧА: ни нового окна, ни ошибки,
// ни события в JS. Именно так себя вели ссылка «здесь» и ссылка авторизации во
// вкладке «Аккаунт»: клик не давал ничего и не оставлял даже записи в логгере.
//
// Почему перехват, а не правка каждой ссылки в разметке: ссылки есть в настройках,
// в виджетах внешних ресурсов, в словаре, в карточках музыки — и ещё их рисует
// сам AniList, чей код мы не контролируем вовсе. Один делегированный обработчик закрывает
// все случаи сразу, включая те, что появятся позже.
//
// Страховка на стороне Rust (on_navigation в src-tauri/src/lib.rs) ловит навигацию
// без клика: редиректы, location.assign из кода сайта, мета-обновления.

import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

/** Хосты, которые живут внутри окна. Совпадает с is_internal_host в lib.rs и с remote.urls в capability. */
function isInternalHost(host: string): boolean {
  return host === 'anilist.co' || host.endsWith('.anilist.co')
}

/** Адреса, которые вообще имеет смысл отдавать браузеру. Схема также проверяется в Rust. */
function isWebUrl(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:'
}

/**
 * Разбирает адрес относительно текущей страницы.
 *
 * Возвращает null вместо исключения: в разметке встречаются и «href="#"», и пустые
 * значения, и выражения шаблонизаторов — для нас это просто «не наш случай».
 */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw, location.href)
  } catch {
    return null
  }
}

/** Уводит адрес в системный браузер. Ошибка — в журнал: молчаливый отказ и был исходным багом. */
function openExternal(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('ERROR', `Не удалось открыть ссылку в браузере: ${url}`, e)
  })
}

/**
 * Обработчик кликов по ссылкам.
 *
 * Вешается на фазе перехвата (capture), чтобы оказаться раньше роутера AniList,
 * но без stopPropagation: если мы решили не вмешиваться, сайт должен обработать
 * событие как обычно.
 */
function onClick(e: MouseEvent): void {
  // Уже обработано чьим-то обработчиком — не лезем.
  if (e.defaultPrevented) return

  // Только обычный левый клик. Среднюю кнопку и Ctrl/Shift в окне без вкладок
  // оставляем WebView: он сам ничего не сделает, и это честнее, чем тихо менять
  // смысл жеста пользователя.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

  const target = e.target
  if (!(target instanceof Element)) return

  const anchor = target.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return

  // getAttribute, а не anchor.href: сырое значение позволяет отличить якорь «#» и
  // javascript:-заглушки от настоящих адресов.
  const raw = anchor.getAttribute('href')
  if (!raw || raw.startsWith('#')) return

  const url = parseUrl(raw)
  if (!url || !isWebUrl(url)) return

  if (isInternalHost(url.host)) {
    // Внутренний адрес без target — работа роутера AniList, не мешаем.
    if (!anchor.target || anchor.target === '_self') return

    // Внутренний адрес с target="_blank" в браузере открыл бы вкладку, а здесь — ничего.
    // Переводим его в обычный переход в том же окне: в приложении без вкладок это
    // единственное осмысленное прочтение «открыть рядом».
    e.preventDefault()
    location.assign(url.href)
    return
  }

  e.preventDefault()
  openExternal(url.href)
}

/** Оригинальный window.open — на случай адресов, которые мы не берём на себя. */
let nativeOpen: typeof window.open | null = null

/**
 * Подменяет window.open на версию, уводящую веб-адреса в браузер.
 *
 * Патч глобала — осознанный компромисс. В проекте есть вызовы window.open вне ссылок
 * (кнопки во вкладке «Поддержать»), и есть чужой код AniList, который тоже им
 * пользуется. Переписывать ради трёх вызовов файл настроек на 37 КБ смысла мало,
 * а чужой код мы не перепишем никогда.
 *
 * Переходная задача: перевести свой прикладной код на Bridge.shell.openExternal —
 * тогда патч останется только для кода сайта.
 */
function patchWindowOpen(): void {
  if (nativeOpen) return
  nativeOpen = window.open.bind(window)

  window.open = ((
    url?: string | URL,
    windowTarget?: string,
    features?: string,
  ): Window | null => {
    if (url !== undefined && url !== '') {
      const parsed = parseUrl(String(url))

      if (parsed && isWebUrl(parsed)) {
        if (isInternalHost(parsed.host)) {
          location.assign(parsed.href)
        } else {
          openExternal(parsed.href)
        }

        // Возвращаем null: ссылки на новое окно не существует, и это штатное
        // значение для заблокированного попапа — вызывающий код к этому готов.
        return null
      }
    }

    // about:blank и прочие служебные вызовы отдаём как было.
    return nativeOpen ? nativeOpen(url, windowTarget, features) : null
  }) as typeof window.open
}

let installed = false

/**
 * Включает обработку ссылок. В браузере ничего не делает.
 *
 * В юзерскриптной сборке любое вмешательство было бы вредом: там ссылки и без
 * нас работают правильно, а подмена window.open ломала бы поведение вкладок.
 */
export function initLinks(): void {
  if (Bridge.platform !== 'tauri') return
  if (installed) return
  installed = true

  document.addEventListener('click', onClick, { capture: true })
  patchWindowOpen()
}
