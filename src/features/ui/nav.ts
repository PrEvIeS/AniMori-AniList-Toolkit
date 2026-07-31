// Пункт 4.5: точка включения браузерной навигации в десктопной сборке.
//
// Модуль делает три вещи и только в Tauri: монтирует NavPanel.vue, вешает Alt+←/→
// и включает клавиатурную часть перезагрузки из reload.ts. Разделение такое: здесь —
// «где и когда появляется навигация», в NavPanel.vue — «как она выглядит», в мосте —
// «что такое шаг назад на этой платформе».
//
// Почему не часть actions.ts. Панель действий — это функции AniMori, общие для двух
// платформ. Блок навигации — замена отсутствующего тулбара, то есть часть оболочки.
// Смешивать их в одном модуле значило бы прокладывать по actions.ts ветвления по платформе,
// а этого этап 3 ровно и избегал.

import { Bridge } from '@/bridge'
import { mountApp, unmountApp } from '@/utils/vue-mounter'

import NavPanel from './NavPanel.vue'
import { initReloadControls } from './reload'

/** Ключ реестра vue-mounter. Рядом с 'action-panel' из actions.ts. */
export const NAV_PANEL_APP_KEY = 'nav-panel'

/** Повторный вызов не должен вешать второй обработчик клавиатуры. */
let hotkeysInstalled = false

/**
 * Вешает Alt+← и Alt+→ — те же сочетания, что в любом браузере.
 *
 * В полях ввода сочетания перехватывать нельзя: в WebView2 Alt+← в текстовом поле
 * ничего не значит, зато уход со страницы из-за случайного нажатия стоит пользователю
 * недописанного отзыва — тот же довод, что для Ctrl+R в reload.ts.
 */
function installHotkeys(): void {
  if (hotkeysInstalled) return
  hotkeysInstalled = true

  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return

      const isBack = e.key === 'ArrowLeft'
      const isForward = e.key === 'ArrowRight'
      if (!isBack && !isForward) return

      const el = document.activeElement as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) {
        return
      }

      e.preventDefault()
      // Ошибка шага по истории невозможна на обеих платформах (history.back ничего
      // не бросает), но контракт асинхронный — отклонённый промис без catch всё равно
      // ушёл бы в unhandledrejection и зашумел бы журнал.
      const step = isBack ? Bridge.shell.back() : Bridge.shell.forward()
      void step.catch(() => {
        /* ошибку уже покажет кнопка блока: сюда она прийти не может */
      })
    },
    // capture по той же причине, что и у перезагрузки: сайт не должен иметь возможности
    // лишить пользователя средств навигации.
    { capture: true },
  )
}

/**
 * Создаёт блок навигации и всё, что к нему относится.
 *
 * В браузере вызов ничего не делает: там всё это уже есть у самого браузера,
 * а второй комплект стрелок поверх сайта был бы чистым шумом. Тумблера в настройках
 * поэтому тоже нет: видимость определяет платформа, а не вкус.
 *
 * Приложение постоянное (без pageScoped): блок висит в body и обязан переживать
 * переходы между страницами — иначе после первого же шага кнопки исчезли бы
 * и вернуться было бы нечем. За сохранность корня следит vue-mounter (РИСК №3):
 * watchContainer здесь не нужен, потому что в body React не лазит — ровно та же
 * логика, что у панели действий и модалок.
 */
export function initNavPanel(): void {
  if (Bridge.platform !== 'tauri') return

  // Клавиши перезагрузки живут в reload.ts с пункта 4.3 и теперь включаются отсюда:
  // всё браузероподобное включается в одном месте, а не из панели действий.
  initReloadControls()
  installHotkeys()

  mountApp(NAV_PANEL_APP_KEY, NavPanel)
}

/** Снимает блок. Нужно только при полном разборе скрипта — как destroyActionBar. */
export function destroyNavPanel(): void {
  unmountApp(NAV_PANEL_APP_KEY)
}
