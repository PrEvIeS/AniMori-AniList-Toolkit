<!--
  Этап 2 п.2.4: одна секция расхождений. Замена cmpRenderDiff из этапа 1.

  Разметка и классы повторяют исходный HTML один в один (amk-collapse,
  amk-collapse-body, amk-count, amk-diffrow, amk-name, amk-meta, amk-x), чтобы
  style.scss остался нетронутым. Классы-крючки cmp-ignore / cmp-unignore из 1.9.1
  больше не нужны для логики (события привязаны через Vue), но оставлены на месте:
  они участвуют в оформлении и служат якорями для ручной проверки.

  Ограничение в 500 строк и хвост «…ещё N» сохранены: без них секция на десятки
  тысяч строк кладёт рендер.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { CMP_SECTION_LIMIT } from './scanner-state'
import type { DiffRow } from './scanner-state'

const props = defineProps<{
  label: string
  rows: DiffRow[]
  sign: 1 | -1
  ignorable: boolean
}>()

const emit = defineEmits<{ (e: 'ignore', id: number, sign: 1 | -1): void }>()

const shown = computed(() => props.rows.slice(0, CMP_SECTION_LIMIT))
const rest = computed(() => Math.max(0, props.rows.length - CMP_SECTION_LIMIT))
</script>

<template>
  <details class="amk-collapse">
    <summary>
      {{ label }}
      <span class="amk-count">{{ rows.length }}</span>
    </summary>
    <div class="amk-collapse-body">
      <div v-for="row in shown" :key="row.id" class="amk-diffrow">
        <span class="amk-name">{{ row.title }}</span>
        <span class="amk-meta">{{ row.meta }}</span>
        <button
          v-if="ignorable"
          class="amk-x cmp-ignore"
          type="button"
          title="Скрыть тайтл из результатов сравнения"
          @click="emit('ignore', row.id, sign)"
        >
          ✕
        </button>
      </div>
      <div v-if="rest > 0" class="amk-meta">…ещё {{ rest }}</div>
    </div>
  </details>
</template>
