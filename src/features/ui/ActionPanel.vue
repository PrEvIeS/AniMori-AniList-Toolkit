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
-->

<script setup lang="ts">
import { Logger } from '../../utils/logger'
import {
  actionButtons,
  isPlayerVisible,
  PLAYER_BUTTON_ID,
  PLAYER_BUTTON_LABEL,
  PLAYER_BUTTON_TITLE,
  playerHandler,
  type ActionButton,
} from './action-panel-state'

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
    <button
      v-if="isPlayerVisible"
      :id="PLAYER_BUTTON_ID"
      type="button"
      class="am-premium-btn"
      :title="PLAYER_BUTTON_TITLE"
      @click="runPlayer"
    >
      {{ PLAYER_BUTTON_LABEL }}
    </button>

    <!--
      Интерполяция, а не v-html: монолит писал в разметку '&lt;/&gt;' и получал '</>',
      здесь тот же результат без разбора HTML.
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
      {{ button.label }}
    </button>
  </div>
</template>
