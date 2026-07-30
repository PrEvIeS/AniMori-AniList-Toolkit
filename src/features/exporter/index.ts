// Этап 2 п.2.7: точка монтирования модуля синхронизации списков.
//
// До рефакторинга здесь лежало 28 929 б: сетевой слой, генерация HTML строкой,
// развешивание onclick по id и весь сценарий переноса внутри обработчика кнопки «Запуск».
// Теперь та же схема, что у сканера: логика в sync-api.ts, состояние в sync-state.ts,
// разметка в SyncModal.vue и SyncButton.vue.
//
// Почему два приложения, а не одно: кнопка и модалка живут в разных местах страницы и
// имеют разный срок жизни. Ленивого монтирования модалки здесь нет намеренно: её показ
// управляется флагом isSyncOpen из состояния, а внутри стоит v-if — до первого открытия
// в DOM не попадает ничего, кроме пустого корня.
//
// Модуль вызывается только на Shikimori (ветка IS_SHIKI в bootstrap). В десктопной сборке
// тот же компонент будет работать импортом на AniList — см. syncMode в sync-state.ts.

import { Logger } from '../../utils/logger'
import { mountApp, unmountApp } from '../../utils/vue-mounter'
import SyncButton from './SyncButton.vue'
import SyncModal from './SyncModal.vue'
import { closeSyncModal, isSyncOpen, openSyncModal } from './sync-state'

export const SYNC_BUTTON_APP_KEY = 'sync-button'
export const SYNC_MODAL_APP_KEY = 'sync-modal'

let mounted = false

/**
 * Монтирует кнопку и окно переноса.
 *
 * watchContainer: false — корнем служит document.body, пересобирать его некому (риск №3).
 */
export function initExporter(): void {
  if (mounted) return
  Logger('INFO', 'Инициализация модуля синхронизации')
  mountApp(SYNC_BUTTON_APP_KEY, SyncButton, { container: document.body, watchContainer: false })
  mountApp(SYNC_MODAL_APP_KEY, SyncModal, { container: document.body, watchContainer: false })
  mounted = true
}

/** Снятие приложений с реестра — понадобится при SPA-связывании на п.2.9. */
export function destroyExporter(): void {
  if (!mounted) return
  closeSyncModal()
  unmountApp(SYNC_MODAL_APP_KEY)
  unmountApp(SYNC_BUTTON_APP_KEY)
  mounted = false
}

export function toggleSyncModal(): void {
  if (isSyncOpen.value) closeSyncModal()
  else openSyncModal()
}

// Совместимость: до разделения весь перенос жил в этом модуле, поэтому его публичный
// API пробрасывается дальше — сторонние импорты из 'features/exporter' не ломаются.
export * from './sync-api'
export * from './sync-state'
