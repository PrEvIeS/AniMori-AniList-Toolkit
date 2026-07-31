// Этап 2 п.2.4: точка монтирования сканера.
// Этап 2 п.2.6: сюда же переехала регистрация кнопки ⇄ из main.ts.
//
// До рефакторинга здесь лежали 34 857 б: загрузка, сверка, четыре функции рендера
// и ручная сборка DOM. Сейчас логика в compare.ts, состояние в scanner-state.ts,
// разметка в ScannerModal.vue — та же схема, что у logger-ui.ts и settings.ts.
//
// Теперь модуль сам заявляет о себе в панели действий через initScannerUI(), как это
// делают initSettingsUI() и initLoggerUI(). main.ts больше не знает ни про id кнопки,
// ни про её порядок, ни про обработчик: фича самодостаточна и снимается одной строкой.
//
// Этап 3 п.3.7.2: видимость кнопки привязана к настройке. Зависимость от ui/settings-state
// односторонняя и безопасная: панель настроек про сканер не знает и ничего отсюда
// не импортирует.

import { mountApp, unmountApp } from '../../utils/vue-mounter'
import { ACTION_ORDER, registerActionButton } from '../ui/actions'
import { showCompareButton } from '../ui/settings-state'
import ScannerModal from './ScannerModal.vue'
import { closeScanner, isScannerOpen, openScanner } from './scanner-state'

export const SCANNER_APP_KEY = 'scanner-modal'

let mounted = false

/**
 * Монтирует модалку лениво, при первом открытии: сканер открывают редко, держать
 * его в DOM с загрузки незачем. Сама видимость — через v-if по isScannerOpen.
 *
 * watchContainer: false — корнем служит document.body, React его не пересобирает (риск №3).
 */
function ensureMounted(): void {
  if (mounted) return
  mountApp(SCANNER_APP_KEY, ScannerModal, { container: document.body, watchContainer: false })
  mounted = true
}

/** Обработчик кнопки ⇄ на панели действий. */
export async function openCompareModal(): Promise<void> {
  ensureMounted()
  await openScanner()
}

export function closeCompareModal(): void {
  closeScanner()
}

export function toggleCompareModal(): void {
  if (isScannerOpen.value) closeScanner()
  else void openCompareModal()
}

/**
 * Регистрирует кнопку ⇄ в панели действий.
 *
 * Вызывать до initActionBar(), как и остальные init*UI(): порядок пилюль задаёт
 * ACTION_ORDER, а не очередь вызовов. Модалка здесь намеренно не монтируется —
 * ленивое монтирование при первом открытии сохраняется.
 *
 * П.3.7.2: регистрация безусловная, даже если тумблер выключен: панель сама отсеивает
 * скрытые кнопки в actionButtons. Передаём ссылку на модель, а не её значение, иначе
 * панель запомнила бы состояние на момент старта и тумблер требовал бы перезагрузки.
 */
export function initScannerUI(): void {
  registerActionButton({
    id: 'am-cmp-btn',
    label: '⇄',
    title: 'Сравнить списки Shikimori и AniList (AniMori)',
    order: ACTION_ORDER.compare,
    visible: showCompareButton,
    onClick: () => void openCompareModal(),
  })
}

/** Снятие приложения с реестра — понадобится при SPA-связывании на п.2.9. */
export function destroyScannerUI(): void {
  if (!mounted) return
  closeScanner()
  unmountApp(SCANNER_APP_KEY)
  mounted = false
}

// Совместимость: до разделения логика сверки жила в этом модуле, поэтому её публичный
// API пробрасывается дальше — сторонние импорты из 'features/scanner' не ломаются.
export * from './compare'
