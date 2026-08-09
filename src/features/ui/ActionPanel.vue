<!--
  Этап 2 п.2.5: плавающая панель кнопок AniMori. Заменяет императивный render()
  из features/ui/actions.ts (этап 1, п.1.7).

  Компонент рендерит САМ контейнер #animori-actions, а не его содержимое, и монтируется
  в document.body. Причина в style.scss: #animori-actions — это display:flex, а разделители
  между кнопками нарисованы селектором .am-premium-btn + .am-premium-btn. Если бы
  компонент монтировался внутрь готового контейнера, узел-корень vue-mounter'а встал бы
  между контейнером и кнопками: кнопки перестали бы быть flex-элементами пилюли и
  потеряли бы разделители. Стили при этом не тронуты ни на строку.

  Кнопка плеера — часть этой же панели (в монолите и на этапе 1 её вставлял player.ts
  через prepend). Она идёт первой: в раскладке монолита плеер слева.

  Этап 3 п.3.7: у кнопки появилось три варианта содержимого вместо одного: строка
  прогресса (если операция идёт), иконка (если задана) или текстовая подпись.
  Порядок именно такой: пока идёт перенос, пользователю важнее видеть его ход, чем значок.

  Шаг 6.2: кнопка плеера переезжает через Teleport под обложку тайтла, а без
  посадочного места остаётся в панели: узел один и тот же, второй ветки не нужно.
-->

<script setup lang="ts">
import { Logger } from '../../utils/logger'
import {
  actionButtons,
  isPlayerVisible,
  PLAYER_BUTTON_HERO_LABEL,
  PLAYER_BUTTON_ID,
  PLAYER_BUTTON_LABEL,
  PLAYER_BUTTON_TITLE,
  playerAnchor,
  playerHandler,
  type ActionButton,
} from './action-panel-state'
import './player-hero.scss'

/**
 * Ошибка обработчика не должна ломать панель: до этого пункта каждый onClick был
 * обёрнут в try/catch внутри render(), и это поведение сохраняется. Без обёртки
 * исключение всплыло бы в планировщик Vue и погасило бы обновления компонента.
 */
function runAction(button: ActionButton): void {
  try {
    button.onClick()
  } catch (e) {
    Logger('ERROR', `[UI] Ошибка обработчика кнопки ${button.id}`, e)
  }
}

/** Текущая строка прогресса кнопки либо пусто, если операция не идёт. */
function progressOf(button: ActionButton): string {
  return button.progress ? button.progress.value : ''
}

function runPlayer(): void {
  const handler = playerHandler.value
  if (!handler) return
  try {
    handler()
  } catch (e) {
    Logger('ERROR', '[UI] Ошибка обработчика кнопки плеера', e)
  }
}
</script>

<template>
  <div id="animori-actions" class="am-accent-scope">
    <!--
      При выключенном телепорте адрес не используется, но Vue требует годного значения,
      поэтому без посадочного места подставляется body.
    -->
    <Teleport :to="playerAnchor ?? 'body'" :disabled="!playerAnchor">
      <button
        v-if="isPlayerVisible"
        :id="PLAYER_BUTTON_ID"
        type="button"
        class="am-premium-btn"
        :class="{ 'am-player-hero': !!playerAnchor }"
        :title="PLAYER_BUTTON_TITLE"
        @click="runPlayer"
      >
        {{ playerAnchor ? PLAYER_BUTTON_HERO_LABEL : PLAYER_BUTTON_LABEL }}
      </button>
    </Teleport>

    <!--
      Интерполяция, а не v-html для подписи: монолит писал в разметку '&lt;/&gt;' и получал '</>',
      здесь тот же результат без разбора HTML. v-html остаётся только для собственных
      SVG-констант — точно так же, как устроены иконки вкладок в SettingsModal.vue.
    -->
    <button
      v-for="button in actionButtons"
      :key="button.id"
      :id="button.id"
      type="button"
      class="am-premium-btn"
      :title="button.title"
      @click="runAction(button)"
    >
      <template v-if="progressOf(button)">{{ progressOf(button) }}</template>
      <svg
        v-else-if="button.icon"
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="vertical-align: -2px"
        v-html="button.icon"
      ></svg>
      <template v-else>{{ button.label }}</template>
    </button>
  </div>
</template>
