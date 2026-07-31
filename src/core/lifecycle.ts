// Этап 1: SPA-жизненный цикл (строки 4615-4650 монолита).
// Этап 2 п.2.9: LifecycleManager — реестр задач вместо одного колбэка.
//
// AniList — SPA на React: переход между страницами не перезагружает документ, адрес
// меняется через History API. Наблюдателя мутаций переводчика для реакции недостаточно:
// он срабатывает только при изменении разметки, а при переходе между однотипными
// страницами React переиспользует узлы и мутаций может не быть вовсе.
//
// Что добавил пункт 2.9:
//   1) реестр задач: раньше на смену роута можно было повесить ровно один колбэк
//      (медиа-виджеты), и всё остальное — уборку фантомов, гашение кнопок — приходилось
//      тащить внутрь медиа-модуля, которому это не принадлежит;
//   2) дедупликацию: три источника событий на один переход давали до трёх прогонов
//      подряд. Задачи обязаны быть идемпотентными, но гонять их втрое дороже без пользы;
//   3) общий разбор (shutdownLifecycle): на Этапе 3 окно Tauri закрывается без выгрузки
//      документа, и снимать наблюдатели придётся руками.
//
// Модуль сознательно не знает ничего о виджетах, Vue и селекторах: он только сообщает
// «адрес поменялся» и вызывает то, что в нём зарегистрировали. Вся привязка к конкретным
// подсистемам живёт в main.ts. Поэтому здесь нет ни одного импорта из features/.

import { Logger } from '../utils/logger'

/**
 * Задержка перед реакцией на смену адреса.
 * Взята из монолита: к моменту вызова pushState новой разметки ещё нет.
 */
const ROUTE_DELAY_MS = 50

/** Период страховочного пулинга адреса. */
const POLL_INTERVAL_MS = 800

/** Одна зарегистрированная задача. */
interface LifecycleTask {
  name: string
  run: () => void
}

/** Задачи на смену роута, в порядке регистрации. */
const routeTasks: LifecycleTask[] = []

/** Задачи на полный разбор скрипта. */
const shutdownTasks: LifecycleTask[] = []

let isStarted = false

/** Адрес, для которого задачи уже отработали. Основа дедупликации. */
let lastHandledUrl = ''

let routeTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * Регистрирует задачу, которая выполняется при каждой смене адреса.
 *
 * Задача обязана быть идемпотентной и дешёвой: дедупликация снимает повторы внутри
 * одного перехода, но не защищает от быстрых переходов подряд.
 *
 * @param name Имя для журнала: по нему видно, какая задача упала.
 */
export function registerRouteTask(name: string, run: () => void): void {
  routeTasks.push({ name, run })
}

/**
 * Регистрирует задачу разбора: снятие наблюдателей, размонтирование Vue, стили.
 * Вызывается только из shutdownLifecycle().
 */
export function registerShutdownTask(name: string, run: () => void): void {
  shutdownTasks.push({ name, run })
}

/** Имена зарегистрированных задач — для дампа состояния в логгере. */
export function listLifecycleTasks(): { route: string[]; shutdown: string[] } {
  return {
    route: routeTasks.map((task) => task.name),
    shutdown: shutdownTasks.map((task) => task.name),
  }
}

/**
 * Прогоняет все задачи роута.
 *
 * Каждая задача в своём try/catch: сбой одной не должен отменять остальные, иначе
 * упавшая уборка фантомов оставила бы страницу без медиа-виджетов.
 */
function runRouteTasks(): void {
  for (const task of routeTasks) {
    try {
      task.run()
    } catch (e) {
      Logger('WARN', `[Router] Задача «${task.name}» завершилась ошибкой`, e)
    }
  }
}

/**
 * Планирует прогон задач и гасит дубли.
 *
 * Три источника событий на один переход — норма: сработали и обёртка pushState,
 * и пулинг. Поэтому таймер один на всех (повторный вызов сдвигает его), а перед
 * запуском адрес сверяется с уже обработанным.
 */
function scheduleRouteTasks(): void {
  if (routeTimer) clearTimeout(routeTimer)
  routeTimer = setTimeout(() => {
    routeTimer = null
    const href = location.href
    if (href === lastHandledUrl) return
    lastHandledUrl = href
    runRouteTasks()
  }, ROUTE_DELAY_MS)
}

/**
 * Запускает отслеживание SPA-навигации.
 *
 * Три независимых источника событий, все три были в монолите:
 *   1) обёртки над history.pushState и history.replaceState — переходы по ссылкам;
 *   2) popstate — кнопки Назад и Вперёд;
 *   3) пулинг location.href — страховка на случай, если адрес сменился в обход
 *      обёрток: сайт может переприсвоить History API после нас.
 *
 * @param onRouteChange Необязательный колбэк. Оставлен ради совместимости со старым
 *   вызовом initLifecycle(refreshMediaPage); внутри это обычная задача с именем «legacy».
 */
export function initLifecycle(onRouteChange?: () => void): void {
  if (isStarted) return
  isStarted = true

  if (onRouteChange) registerRouteTask('legacy', onRouteChange)

  // Стартовый адрес считаем уже обработанным: первый проход по странице делают сами
  // подсистемы при инициализации, и дублировать его здесь незачем.
  lastHandledUrl = location.href

  const notifyDeferred = (reason: string): void => {
    Logger('INFO', `[Router] ${reason}`)
    scheduleRouteTasks()
  }

  // Ошибка обработчика не должна ломать навигацию сайта: мы подменили его History API,
  // и неперехваченное исключение вышло бы наружу из вызова pushState. Прогон задач
  // отложен таймером, поэтому сюда исключение и не долетит — но обёртки всё равно
  // держим тонкими, без логики.
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

  // Пулинг не логируется: иначе журнал засорялся бы дублями к каждому переходу,
  // потому что обёртки выше уже сообщили о нём. Сама дедупликация теперь общая
  // и живёт в scheduleRouteTasks(), а не в отдельной переменной пулинга.
  pollTimer = setInterval(() => {
    if (location.href === lastHandledUrl) return
    scheduleRouteTasks()
  }, POLL_INTERVAL_MS)

  Logger('INFO', `[Router] Отслеживание SPA-навигации запущено, задач: ${routeTasks.length}`)
}

/**
 * Полный разбор: гасит пулинг и прогоняет задачи разбора в обратном порядке
 * регистрации (как стек — снимаем сверху вниз).
 *
 * В браузере вызывать неоткуда: вкладку закрывают вместе с документом. Нужен на
 * Этапе 3, где WebView живёт дольше страницы, и на случай ручной перезагрузки модулей.
 * Обёртки над History API сознательно не снимаются: вернуть оригиналы безопасно
 * можно только если после нас их никто не переприсвоил, а гарантии этого нет.
 */
export function shutdownLifecycle(): void {
  if (!isStarted) return

  if (routeTimer) {
    clearTimeout(routeTimer)
    routeTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }

  for (const task of [...shutdownTasks].reverse()) {
    try {
      task.run()
    } catch (e) {
      Logger('WARN', `[Router] Разбор «${task.name}» завершился ошибкой`, e)
    }
  }

  isStarted = false
  Logger('INFO', '[Router] Отслеживание SPA-навигации остановлено')
}
