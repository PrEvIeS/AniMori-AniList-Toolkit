// Пункт 2.5: от императивной панели осталась только точка запуска.
//
// Разметка теперь в ActionPanel.vue, состояние — в action-panel-state.ts. Файл сохранён
// ради пути импорта: main.ts берёт отсюда ACTION_ORDER, registerActionButton и
// initActionBar, и менять bootstrap() в этом пункте не требуется.
//
// Реестр кнопок и реактивное состояние сознательно лежат в отдельном модуле:
// иначе возник бы цикл actions.ts -> ActionPanel.vue -> actions.ts.

import { mountApp, unmountApp } from '../../utils/vue-mounter'
import ActionPanel from './ActionPanel.vue'

export {
  ACTION_ORDER,
  hidePlayerButton,
  registerActionButton,
  showPlayerButton,
  type ActionButton,
} from './action-panel-state'

/** Ключ в реестре vue-mounter'а. */
export const ACTION_PANEL_APP_KEY = 'action-panel'

const CONTAINER_ID = 'animori-actions'

let isStarted = false

/**
 * Монтирует панель действий.
 *
 * Контейнер создаёт сам компонент, поэтому монтируемся в body, а не в #animori-actions:
 * селектор .am-premium-btn + .am-premium-btn из style.scss работает только пока кнопки —
 * прямые соседи внутри flex-контейнера.
 */
export function initActionBar(): void {
  if (isStarted) return
  isStarted = true

  // На этапе 1 контейнер мог создать виджет плеера раньше панели. Сейчас такого пути
  // нет, но узел может остаться от предыдущей версии скрипта после горячего
  // обновления в Tampermonkey — тогда пилюль отрисовалась бы дважды.
  document.getElementById(CONTAINER_ID)?.remove()

  // watchContainer: false — наблюдатель на childList у body был бы пустой тратой:
  // AniList дёргает детей body постоянно (модалки, тултипы), а панель за весь этап 1
  // ни разу не пропала: она fixed и лежит вне дерева React.
  mountApp(ACTION_PANEL_APP_KEY, ActionPanel, {
    container: document.body,
    watchContainer: false,
  })
}

/** Снимает панель. Нужно для LifecycleManager из п.2.9. */
export function destroyActionBar(): void {
  unmountApp(ACTION_PANEL_APP_KEY)
  isStarted = false
}
