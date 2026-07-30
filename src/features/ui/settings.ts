// Пункт 2.2 плана: точка входа панели настроек.
//
// Было: 40 КБ императивной сборки DOM (buildPanelMarkup, wireTabs, wireBooleanSettings,
// wireDomainSettings, wireTitleSources, renderAccentChips, renderCustomLinksEditor,
// renderDictEditor, wireDictEditor, wireAniListAuth, wireSupportTab, togglePanel).
// Стало: разметка в SettingsModal.vue, состояние в settings-state.ts, здесь — только
// монтирование компонента и регистрация кнопки ⚙ в панели действий.
//
// Контракт снаружи не изменился: main.ts по-прежнему зовёт initSettingsUI() после
// loadSettings(). Дополнительно экспортируется openSettingsModal() — по аналогии с
// openLoggerModal() из logger-ui.ts, чтобы другие модули могли открыть панель без DOM-хаков.

import { mountApp } from '../../utils/vue-mounter'
import SettingsModal from './SettingsModal.vue'
import { ACTION_ORDER, registerActionButton } from './actions'
import { openSettings, toggleSettings } from './settings-state'

export const SETTINGS_APP_KEY = 'settings-modal'

/** Открыть панель настроек извне. */
export function openSettingsModal(): void {
  openSettings()
}

/**
 * Монтирует панель настроек и регистрирует кнопку ⚙.
 * Вызывать только после loadSettings(): компонент читает settings при первом рендере.
 */
export function initSettingsUI(): void {
  // Модалка живёт в body и не зависит от разметки AniList, поэтому наблюдение за
  // контейнером не нужно — тот же режим, что у логгера.
  mountApp(SETTINGS_APP_KEY, SettingsModal, {
    container: document.body,
    watchContainer: false,
  })

  registerActionButton({
    id: 'am-set-btn',
    label: '⚙',
    title: 'Настройки AniMori',
    order: ACTION_ORDER.settings,
    onClick: toggleSettings,
  })
}
