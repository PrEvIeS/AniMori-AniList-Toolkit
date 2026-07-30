// Этап 1: SPA-жизненный цикл (строки 4615-4650 монолита).
//
// AniList — SPA на React: переход между страницами не перезагружает документ, адрес
// меняется через History API. Наблюдателя мутаций переводчика для реакции недостаточно:
// он срабатывает только при изменении разметки, а при переходе между однотипными
// страницами React переиспользует узлы и мутаций может не быть вовсе.
//
// Модуль сознательно не знает ничего о виджетах и селекторах: он только сообщает
// «адрес поменялся». В монолите та же логика была вмешана в init() и сама чистила
// блоки страницы по списку классов; здесь уборка остаётся в медиа-модуле.
//
// Этап 3: на Tauri адрес меняется тем же History API внутри WebView, поэтому модуль
// переезжает без изменений и становится основой LifecycleManager из RM2.

import { Logger } from '../utils/logger'

/**
 * Задержка перед реакцией на смену адреса.
 * Взята из монолита: к моменту вызова pushState новой разметки ещё нет.
 */
const ROUTE_DELAY_MS = 50

/** Период страховочного пулинга адреса. */
const POLL_INTERVAL_MS = 800

let isStarted = false

/**
 * Запускает отслеживание SPA-навигации.
 *
 * Три независимых источника событий, все три были в монолите:
 *   1) обёртки над history.pushState и history.replaceState — переходы по ссылкам;
 *   2) popstate — кнопки Назад и Вперёд;
 *   3) пулинг location.href — страховка на случай, если адрес сменился в обход
 *      обёрток: сайт может переприсвоить History API после нас.
 *
 * @param onRouteChange Вызывается при каждой смене адреса. Обязан быть идемпотентным:
 *   на один переход может прийти несколько вызовов из разных источников.
 */
export function initLifecycle(onRouteChange: () => void): void {
  if (isStarted) return
  isStarted = true

  // Ошибка обработчика не должна ломать навигацию сайта: мы подменили его History API,
  // и неперехваченное исключение вышло бы наружу из вызова pushState.
  const safeNotify = (): void => {
    try {
      onRouteChange()
    } catch (e) {
      Logger('WARN', '[Router] Обработчик смены роута завершился ошибкой', e)
    }
  }

  const notifyDeferred = (reason: string): void => {
    Logger('INFO', `[Router] ${reason}`)
    window.setTimeout(safeNotify, ROUTE_DELAY_MS)
  }

  const originalPushState = history.pushState.bind(history)
  history.pushState = (...args: Parameters<History['pushState']>): void => {
    originalPushState(...args)
    notifyDeferred(`Переход по ссылке на ${location.pathname}`)
  }

  const originalReplaceState = history.replaceState.bind(history)
  history.replaceState = (...args: Parameters<History['replaceState']>): void => {
    originalReplaceState(...args)
    notifyDeferred(`Обновление роута ${location.pathname}`)
  }

  window.addEventListener('popstate', () => {
    notifyDeferred(`Кнопка Назад/Вперед ➜ ${location.pathname}`)
  })

  // Пулинг не логируется и работает без задержки: если он заметил смену адреса,
  // значит событие уже произошло и ждать нечего. Иначе журнал засорялся бы дублями
  // к каждому переходу, потому что обёртки выше уже сообщили о нём.
  let lastUrl = location.href
  window.setInterval(() => {
    if (location.href === lastUrl) return
    lastUrl = location.href
    safeNotify()
  }, POLL_INTERVAL_MS)

  Logger('INFO', '[Router] Отслеживание SPA-навигации запущено')
}
