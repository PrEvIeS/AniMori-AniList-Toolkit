<!--
  Итерация 5.1: вкладка «Разработчик».

  Здесь живёт то, что нужно для разбора проблем, а не для обычной работы: тумблер логгера
  (переехал из «Прочего», ключ хранилища set_logger не менялся) и ручная проверка
  доступности источников из ./net-check.

  Карточка ставится рядом с логгером осознанно: первое действие при жалобе «ничего не
  грузится» — посмотреть журнал и прогнать проверку.

  Строки добавляются по ходу прогона (onRow), потому что полный круг с мёртвыми адресами
  может занять десятки секунд, и молчащая кнопка всё это время читалась бы как зависание.

  Верстка строки отчёта: слева название и причина (сжимается и переносится), справа
  код и время в колонке фиксированной ширины без переноса. Без min-width: 0 левая
  колонка во флексе не сжимается меньше своего текста и наезжает на правую.

  Итерация 5.3, часть третья: сюда же встала карточка прокси (SettingsProxyCard.vue).
  Место выбрано по соседству с проверкой сети: прокси включают именно тогда, когда
  проверка показала недоступные источники, и два элемента читаются как один сценарий.
  Карточка сама скрывает себя в юзерскриптной сборке, поэтому здесь проверки платформы нет.
-->
<template>
  <div class="amk-card">
    <div class="amk-card-title">Отладка</div>
    <div class="amk-row">
      <span class="amk-row-label"
        ><b>Логгер</b><span class="amk-row-hint">отслеживание действий скрипта (для отладки)</span></span
      >
      <label class="amk-switch">
        <input type="checkbox" id="set_logger" v-model="enableLogger" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>
  </div>

  <div class="amk-card">
    <div class="amk-card-title">Проверка сети</div>
    <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
      По очереди стучится во все источники, которыми пользуется AniMori, и покажет код ответа с
      временем. Полный прогон занимает до полуминуты, если часть адресов не отвечает.
    </div>
    <button
      class="amk-btn amk-btn-primary amk-btn-block"
      id="am-net-run"
      :disabled="busy"
      @click="onRun()"
    >
      {{ busy ? 'Проверяем…' : 'Проверить источники' }}
    </button>
    <div v-if="hint" class="amk-row-hint" style="padding: 8px 2px 0; line-height: 1.5">
      {{ hint }}
    </div>
    <div
      v-if="rows.length > 0"
      id="am-net-rows"
      style="display: flex; flex-direction: column; gap: 6px; margin-top: 10px"
    >
      <div
        v-for="row in rows"
        :key="row.id"
        class="amk-row"
        style="gap: 10px; align-items: flex-start"
      >
        <span class="amk-row-label" style="min-width: 0; flex: 1 1 auto"
          ><b style="overflow-wrap: anywhere">{{ row.label }}</b
          ><span class="amk-row-hint" style="overflow-wrap: anywhere">{{ row.detail }}</span></span
        >
        <span
          class="amk-row-hint amk-mono"
          style="flex: 0 0 auto; white-space: nowrap; text-align: right; padding-top: 1px"
          :style="{ color: row.ok ? 'rgb(var(--color-green, 166,227,161))' : 'rgb(var(--color-red, 243,139,168))' }"
          >{{ row.status > 0 ? row.status : '—' }} · {{ row.latencyMs }} мс</span
        >
      </div>
    </div>
  </div>

  <SettingsProxyCard />
</template>

<script setup lang="ts">
import { ref } from 'vue'

import SettingsProxyCard from './SettingsProxyCard.vue'
import { canRunNetCheck, netCheckCooldownRemaining, runNetCheck } from './net-check'
import type { NetCheckRow } from './net-check'
import { enableLogger } from './settings-state'

const rows = ref<NetCheckRow[]>([])
const busy = ref(false)
const hint = ref('')

async function onRun(): Promise<void> {
  if (busy.value) return
  if (!canRunNetCheck()) {
    const left = Math.ceil(netCheckCooldownRemaining() / 1000)
    hint.value = 'Повторная проверка будет доступна через ' + String(left) + ' с'
    return
  }

  busy.value = true
  hint.value = ''
  rows.value = []

  try {
    await runNetCheck((row) => {
      rows.value = [...rows.value, row]
    })
    const bad = rows.value.filter((r) => !r.ok)
    hint.value =
      bad.length === 0
        ? 'Все источники ответили.'
        : 'Не ответили: ' +
          String(bad.length) +
          ' из ' +
          String(rows.value.length) +
          '. Если среди них есть нужные вам сервисы — поможет VPN.'
  } finally {
    busy.value = false
  }
}
</script>
