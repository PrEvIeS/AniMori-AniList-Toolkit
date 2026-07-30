// Пункт 1.7 плана: плавающая панель кнопок AniMori (строки 4213-4224 монолита).
//
// Разметка повторяет монолит один в один: контейнер #animori-actions с классом
// am-accent-scope в конце body, внутри — кнопки .am-premium-btn. Стили для обоих
// селекторов уже перенесены в style.scss, поэтому инлайновый CSS здесь не нужен.
//
// Кнопки регистрируются, а не вписываются жёстко: модалки настроек и логгера
// приезжают следующими итерациями, и им достаточно вызвать registerActionButton().
// Порядок задаётся числом, а не порядком вызова, иначе поздние итерации добавляли
// бы свои кнопки справа и раскладка разошлась бы с монолитом.
//
// На Этапе 2 файл заменяется на ActionPanel.vue (п.2.5), а registerActionButton
// станет emit'ом событий.

import { Logger } from '../../utils/logger'

const CONTAINER_ID = 'animori-actions'

/** Порядок кнопок слева направо, как в монолите: ⚙, </>, ⇄. */
export const ACTION_ORDER = {
  settings: 10,
  logger: 20,
  compare: 30,
} as const

export interface ActionButton {
  /** id узла: сохраняем идентификаторы монолита (am-set-btn, am-log-btn, am-cmp-btn). */
  id: string
  /** Подпись кнопки. Вставляется как текст, не как HTML. */
  label: string
  title: string
  /** Меньше — левее. Значения из ACTION_ORDER. */
  order: number
  onClick: () => void
}

const buttons: ActionButton[] = []
let container: HTMLElement | null = null

function render(): void {
  if (!container) return

  container.textContent = ''
  const ordered = [...buttons].sort((a, b) => a.order - b.order)

  for (const button of ordered) {
    const el = document.createElement('button')
    el.id = button.id
    el.type = 'button'
    el.className = 'am-premium-btn'
    // textContent, а не innerHTML: монолит писал '&lt;/&gt;' и получал '</>',
    // здесь тот же результат без разбора HTML.
    el.textContent = button.label
    el.title = button.title
    el.onclick = () => {
      try {
        button.onClick()
      } catch (e) {
        Logger('ERROR', `[UI] Ошибка обработчика кнопки ${button.id}`, e)
      }
    }
    container.appendChild(el)
  }
}

/**
 * Добавляет кнопку в панель. Повторная регистрация того же id игнорируется.
 * Можно вызывать и до, и после initActionBar().
 */
export function registerActionButton(button: ActionButton): void {
  if (buttons.some((b) => b.id === button.id)) return
  buttons.push(button)
  render()
}

/** Создаёт контейнер панели и отрисовывает зарегистрированные кнопки. */
export function initActionBar(): void {
  if (container) return

  const existing = document.getElementById(CONTAINER_ID)
  if (existing) {
    container = existing
  } else {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    container.classList.add('am-accent-scope')
    document.body.appendChild(container)
  }

  render()
}
