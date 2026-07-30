// Пункт 2.3: точка монтирования LoggerModal.
//
// Императивный UI (создание DOM, appendLogEntry, renderAllLogs) удалён полностью —
// всё перешло в LoggerModal.vue + logger-state.ts.
//
// РИСК №6 закрыт: реактивный кольцевой буфер 500 записей вместо
// ~6000 узлов в DOM. Скролл — v-for с виртуализацией на этапе 4 при необходимости.

import { settings } from '../../core/settings'
import { registerLogSink } from '../../utils/logger'
import { mountApp } from '../../utils/vue-mounter'
import { ACTION_ORDER, registerActionButton } from './actions'
import LoggerModal from './LoggerModal.vue'
import { isLoggerOpen, pushLogEntry } from './logger-state'

export const LOGGER_APP_KEY = 'logger-modal'

/** Открывает модалку логгера. Используется как onClick в registerActionButton. */
export function openLoggerModal(): void {
  isLoggerOpen.value = true
}

/**
 * Подключает UI логгера: подписка на новые записи, монтирование модалки, кнопка в панели.
 * Видимость модалки управляется через isLoggerOpen из logger-state.ts.
 */
export function initLoggerUI(): void {
  if (!settings.enableLogger) return

  // Новые записи всегда попадают в буфер, независимо от того,
  // открыта ли модалка — при открытии syncLogEntries() синхронизирует картину.
  registerLogSink((entry) => {
    pushLogEntry(entry)
  })

  // Монтируем один раз, видимость через v-if="isLoggerOpen" внутри компонента
  mountApp(LOGGER_APP_KEY, LoggerModal, { container: document.body, watchContainer: false })

  registerActionButton({
    id: 'am-log-btn',
    label: '</>',
    title: 'Открыть логгер (AniMori)',
    order: ACTION_ORDER.logger,
    onClick: openLoggerModal,
  })
}
