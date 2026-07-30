<script setup lang="ts">
// Этап 2 п.2.7: кнопка модуля синхронизации.
//
// На Shikimori нет панели действий (`initActionBar()` работает только на AniList),
// поэтому кнопка остаётся самостоятельной и висит внизу слева, как в 1.9.1.
// Стили и поведение наведения перенесены из `initExporter()` без изменений.
//
// Кнопка же служит индикатором прогресса: раньше сетевой слой писал ей в textContent,
// теперь она просто показывает `buttonLabel`.

import { onMounted, ref } from 'vue'
import { amkShikiTokens } from './sync-theme'
import { buttonLabel, isRunning, openSyncModal } from './sync-state'

const btnRef = ref<HTMLButtonElement | null>(null)
const hovered = ref(false)

const BASE_STYLE =
  'position:fixed;bottom:20px;left:20px;z-index:9999;padding:11px 20px;' +
  'background:rgba(var(--color-foreground),0.8);' +
  'backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%);' +
  'border-radius:12px;cursor:pointer;font-weight:600;font-size:14px;' +
  'box-shadow:0 4px 20px rgba(0,0,0,0.18);transition:border-color .2s, color .2s;letter-spacing:0.3px;'

onMounted(() => {
  if (btnRef.value) amkShikiTokens(btnRef.value)
})
</script>

<template>
  <button
    id="animori-export-button"
    ref="btnRef"
    :style="
      BASE_STYLE +
      (hovered
        ? 'border:1px solid rgb(var(--color-blue));color:rgb(var(--color-blue));'
        : 'border:1px solid rgba(var(--color-text-light),0.2);color:rgb(var(--color-text));')
    "
    :disabled="isRunning"
    @mouseover="hovered = true"
    @mouseout="hovered = false"
    @click="openSyncModal"
  >
    {{ buttonLabel }}
  </button>
</template>
