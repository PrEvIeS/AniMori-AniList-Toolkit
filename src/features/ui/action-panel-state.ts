// Этап 2 п.2.5: состояние панели действий, отделённое от компонента.
//
// Зачем отдельный файл, а не всё внутри ActionPanel.vue или actions.ts:
// actions.ts обязан импортировать компонент, чтобы его смонтировать, а компонент
// обязан читать состояние. Если состояние держать в actions.ts, получится цикл
// actions.ts -> ActionPanel.vue -> actions.ts. Здесь цикла нет:
//   actions.ts -> ActionPanel.vue -> action-panel-state.ts
//   actions.ts -> action-panel-state.ts
//
// Кнопка плеера живёт в этом же состоянии, а не в разметке медиа-виджета:
// в монолите и на этапе 1 она вставлялась в общий контейнер императивно
// (player.ts -> ensureActionsContainer().prepend), а Vue владеет детьми
// контейнера целиком и посторонний узел внутри его разметки — источник
// расхождений при перерисовке.

import { computed, ref, shallowRef } from 'vue'

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

const registry = ref<ActionButton[]>([])

/**
 * Кнопки в порядке отрисовки.
 *
 * Порядок задаётся полем order, а не порядком регистрации: иначе поздние итерации
 * добавляли бы свои кнопки справа и раскладка разошлась бы с монолитом.
 */
export const actionButtons = computed<ActionButton[]>(() =>
  [...registry.value].sort((a, b) => a.order - b.order),
)

/**
 * Добавляет кнопку в панель. Повторная регистрация того же id игнорируется.
 * Можно вызывать и до, и после initActionBar(): панель реактивна.
 */
export function registerActionButton(button: ActionButton): void {
  if (registry.value.some((b) => b.id === button.id)) return
  registry.value.push(button)
}

export const PLAYER_BUTTON_ID = 'ru-player-btn'
export const PLAYER_BUTTON_LABEL = '▶ Плеер'
export const PLAYER_BUTTON_TITLE = 'Смотреть онлайн'

/** Видна ли кнопка плеера. Управляется медиа-виджетом плеера. */
export const isPlayerVisible = ref(false)

/**
 * Обработчик кнопки плеера. shallowRef, а не ref: значение — функция, и оборачивать
 * её в глубокую реактивность незачем. В шаблоне не используется, поэтому смена
 * обработчика при каждом mount() виджета не вызывает перерисовку панели.
 */
export const playerHandler = shallowRef<(() => void) | null>(null)

/** Показывает кнопку плеера и привязывает запуск для текущего тайтла. */
export function showPlayerButton(onClick: () => void): void {
  playerHandler.value = onClick
  isPlayerVisible.value = true
}

/**
 * Гасит кнопку плеера.
 *
 * Вызывается и виджетом плеера (плеер выключен в настройках или это не аниме),
 * и медиа-модулем при уходе со страницы тайтла: кнопка живёт в общей панели,
 * а не в разметке виджета, поэтому cleanupSelectors её не снимает.
 */
export function hidePlayerButton(): void {
  isPlayerVisible.value = false
  playerHandler.value = null
}
