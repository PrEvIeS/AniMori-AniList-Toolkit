// Этап 2 п.2.4: точка монтирования сканера.
//
// До рефакторинга здесь лежали 34 857 б: загрузка, сверка, четыре функции рендера
// и ручная сборка DOM. Сейчас логика в compare.ts, состояние в scanner-state.ts,
// разметка в ScannerModal.vue — та же схема, что у logger-ui.ts и settings.ts.
//
// Сигнатура openCompareModal() сохранена намеренно: main.ts регистрирует кнопку
// am-cmp-btn с этим обработчиком, а перенос регистрации кнопок в сами фичи — это п.2.6.
// Не смешиваем два пункта в одной итерации, чтобы точка отката оставалась чистой.

import { mountApp, unmountApp } from '../../utils/vue-mounter'
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
