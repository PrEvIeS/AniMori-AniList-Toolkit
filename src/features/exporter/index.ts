// Этап 2 п.2.7: точка монтирования модуля синхронизации списков.
//
// До рефакторинга здесь лежало 28 929 б: сетевой слой, генерация HTML строкой,
// развешивание onclick по id и весь сценарий переноса внутри обработчика кнопки «Запуск».
// Теперь та же схема, что у сканера: логика в sync-api.ts, состояние в sync-state.ts,
// разметка в SyncModal.vue.
//
// Пункт 3.7: модуль больше не живёт на Shikimori. Причина архитектурная: десктопная
// оболочка показывает только anilist.co, и точка входа на чужом домене там недостижима
// в принципе. Держать две разные точки входа для двух сборок — значит разводить сценарии
// и тестировать дважды, поэтому вход один и тот же: пилюля в панели действий AniList,
// рядом с настройками и сравнением списков. Отдельной плавающей кнопки (SyncButton.vue)
// и подбора переменных темы Shikimori (sync-theme.ts) больше нет.
//
// Приложение теперь одно — только окно. Ленивого монтирования нет намеренно: показ
// управляется флагом isSyncOpen, а внутри стоит v-if — до первого открытия в DOM попадает
// только пустой корень.

import { Logger } from '../../utils/logger'
import { mountApp, unmountApp } from '../../utils/vue-mounter'
import { ACTION_ORDER, registerActionButton } from '../ui/action-panel-state'
import SyncModal from './SyncModal.vue'
import { closeSyncModal, isSyncOpen, openSyncModal, pillProgress } from './sync-state'

export const SYNC_MODAL_APP_KEY = 'sync-modal'

/**
 * Иконка переноса: стрелка вниз в приёмный лоток. Общепринятый знак импорта, а не
 * круговые стрелки синхронизации: рядом стоит кнопка сравнения со знаком ⇄, и два
 * похожих стрелочных значка рядом читались бы как одно и то же действие. Формат — внутренности
 * SVG 24×24 без оболочки, как у иконок вкладок в настройках.
 */
const SYNC_ICON =
  '<path d="M12 3v11"/><path d="M7.5 9.5 12 14l4.5-4.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'

let mounted = false

/**
 * Монтирует окно переноса и регистрирует кнопку в панели действий.
 *
 * watchContainer: false — корнем служит document.body, пересобирать его некому (риск №3).
 *
 * Прогресс отдаётся панели ссылкой на pillProgress, а не значением: кнопка регистрируется
 * один раз при старте, а текст меняется десятки раз за перенос.
 */
export function initExporter(): void {
  if (mounted) return
  Logger('INFO', 'Инициализация модуля синхронизации')
  mountApp(SYNC_MODAL_APP_KEY, SyncModal, { container: document.body, watchContainer: false })
  registerActionButton({
    id: 'am-sync-btn',
    label: 'Перенос',
    title: 'Перенос списков Shikimori → AniList (AniMori)',
    order: ACTION_ORDER.sync,
    icon: SYNC_ICON,
    progress: pillProgress,
    onClick: () => toggleSyncModal(),
  })
  mounted = true
}

/** Снятие приложения с реестра — понадобится при SPA-связывании на п.2.9. */
export function destroyExporter(): void {
  if (!mounted) return
  closeSyncModal()
  unmountApp(SYNC_MODAL_APP_KEY)
  mounted = false
}

/**
 * Переключает окно переноса.
 *
 * Открытие асинхронное (читает запомненный логин из хранилища моста), но обработчик
 * кнопки синхронный: панель ловит только синхронные исключения, поэтому промис гасится
 * явно через void, а ошибки внутри чтения хранилища уже обработаны внутри моста.
 */
export function toggleSyncModal(): void {
  if (isSyncOpen.value) closeSyncModal()
  else void openSyncModal()
}

// Совместимость: до разделения весь перенос жил в этом модуле, поэтому его публичный
// API пробрасывается дальше — сторонние импорты из 'features/exporter' не ломаются.
export * from './sync-api'
export * from './sync-state'
