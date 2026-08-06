// Браузерная навигация в десктопной сборке: NavPanel.vue, Alt+←/→ и клавиши перезагрузки.
// Только Tauri: это замена отсутствующего тулбара, а не функция самого AniMori.
// Отдельно от actions.ts: иначе в панель действий пришли бы ветвления по платформе.

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
 * В полях ввода не перехватываем: случайный уход со страницы стоит недописанного отзыва.
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
      // Шаг по истории не бросает, но контракт асинхронный: без catch будет шум в журнале.
      const step = isBack ? Bridge.shell.back() : Bridge.shell.forward()
      void step.catch(() => {
        /* ошибку покажет кнопка блока */
      })
    },
    // capture: сайт не должен иметь возможность лишить пользователя средств навигации.
    { capture: true },
  )
}

/**
 * Создаёт блок навигации. В браузере ничего не делает: там стрелки уже есть.
 * Приложение постоянное: блок обязан переживать переходы, иначе вернуться будет нечем.
 */
export function initNavPanel(): void {
  if (Bridge.platform !== 'tauri') return

  // Всё браузероподобное включается в одном месте, а не из панели действий.
  initReloadControls()
  installHotkeys()

  mountApp(NAV_PANEL_APP_KEY, NavPanel)
}

/** Снимает блок. Нужно только при полном разборе скрипта — как destroyActionBar. */
export function destroyNavPanel(): void {
  unmountApp(NAV_PANEL_APP_KEY)
}
