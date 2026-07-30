<script setup lang="ts">
// Этап 2 п.2.7: окно переноса списков.
//
// Разметка повторяет `openExportModal()` из 1.9.1: те же id, те же классы, те же inline-стили,
// те же подписи и тот же порядок строк. Селектор `#shiki-export-overlay` в `style.scss`
// задаёт светлую тему окна, поэтому id сохранён буква в букву.
//
// Два осознанных отличия от монолита:
//  1. Предупреждение о публичности профиля — прямое требование RM2 п.2.7. Скрытый профиль
//     даёт 403 в fetchShikimoriListV2, и раньше об этом сообщало только сообщение об ошибке.
//  2. Подпись режима берётся из `syncMode`: тот же компонент будет работать импортом
//     в десктопной сборке на AniList.
//
// Точка в шапке рисуется самим CSS, поэтому отдельный `<span class="amk-dot">` сюда не ставится:
// в итерации 5 такой span дал задвоение точки у сканера.

import { computed, onMounted, ref, watch } from 'vue'
import { amkShikiTokens } from './sync-theme'
import {
  AL_DEVELOPER_URL,
  AL_REDIRECT_URL,
  alToken,
  authUrl,
  clientId,
  closeSyncModal,
  isRunning,
  isSyncOpen,
  generateAuthUrl,
  optAnime,
  optDates,
  optFavs,
  optManga,
  runSync,
  shikiUser,
  syncMode,
} from './sync-state'

const overlayRef = ref<HTMLElement | null>(null)

const modeLabel = computed(() => (syncMode.value === 'export' ? 'экспорт' : 'импорт'))
const startLabel = computed(() => 'Запуск')

// Переменные темы нужно пересчитать каждый раз при показе: тема Shikimori меняется без перезагрузки.
function applyTokens() {
  if (overlayRef.value) amkShikiTokens(overlayRef.value)
}
onMounted(applyTokens)
watch(isSyncOpen, (open) => {
  if (open) requestAnimationFrame(applyTokens)
})
</script>

<template>
  <div
    v-if="isSyncOpen"
    id="shiki-export-overlay"
    ref="overlayRef"
    class="amk-overlay"
    style="display: flex"
    @click.self="closeSyncModal"
  >
    <div class="amk-modal" style="width: 500px; background: rgba(255, 255, 255, 0.85)">
      <div class="amk-head">
        <div class="amk-title">
          <span style="color: #e05264">Shikimori</span>&nbsp;➜&nbsp;<span style="color: #3dbbee"
            >AniList</span
          >
          <span class="amk-sub">{{ modeLabel }}</span>
        </div>
        <button id="se-close" class="amk-close" @click="closeSyncModal">✕</button>
      </div>

      <div class="amk-body">
        <div
          class="amk-row-hint"
          style="
            margin-bottom: 12px;
            padding: 8px 10px;
            border-radius: 8px;
            background: rgba(246, 193, 119, 0.18);
            line-height: 1.4;
          "
        >
          ⚠️ Ваш профиль на Shikimori должен быть открыт (публичен) на время переноса списков. Если
          профиль скрыт настройками приватности, сервер откажет в доступе.
        </div>

        <div class="amk-card">
          <div class="amk-card-title">Что переносить</div>

          <div class="amk-row">
            <div class="amk-row-label">Аниме</div>
            <label class="amk-switch">
              <input id="se-anime" v-model="optAnime" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>

          <div class="amk-row">
            <div class="amk-row-label">Манга</div>
            <label class="amk-switch">
              <input id="se-manga" v-model="optManga" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>

          <div class="amk-row">
            <div class="amk-row-label">Избранное</div>
            <label class="amk-switch">
              <input id="se-favs" v-model="optFavs" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>

          <div class="amk-row">
            <div>
              <div class="amk-row-label">Точные даты просмотров</div>
              <div class="amk-row-hint">из истории Shikimori (медленнее)</div>
            </div>
            <label class="amk-switch">
              <input id="se-dates" v-model="optDates" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>
        </div>

        <div class="amk-card">
          <div class="amk-card-title">Профиль Shikimori</div>
          <input
            id="se-user"
            v-model="shikiUser"
            class="amk-input"
            type="text"
            placeholder="Логин на Shikimori"
          />
        </div>

        <div class="amk-card">
          <div class="amk-card-title">Токен AniList</div>
          <div class="amk-row-hint" style="margin-bottom: 8px">
            Создайте Client
            <a :href="AL_DEVELOPER_URL" target="_blank" rel="noopener">здесь</a>, redirect URL:
            <span class="amk-mono">{{ AL_REDIRECT_URL }}</span>
          </div>

          <div style="display: flex; gap: 8px; margin-bottom: 8px">
            <input
              id="se-gen-client"
              v-model="clientId"
              class="amk-input"
              type="text"
              placeholder="Client ID"
            />
            <button id="se-gen-btn" class="amk-btn amk-btn-ghost" @click="generateAuthUrl">
              Создать URL
            </button>
          </div>

          <a
            v-if="authUrl"
            id="se-gen-url"
            :href="authUrl"
            target="_blank"
            rel="noopener"
            style="display: block; margin-bottom: 8px"
          >
            👉 Клик для авторизации
          </a>

          <input
            id="se-token"
            v-model="alToken"
            class="amk-input"
            type="text"
            placeholder="Вставьте токен"
          />
        </div>
      </div>

      <div class="amk-foot">
        <button
          id="se-start"
          class="amk-btn amk-btn-primary amk-btn-block"
          :disabled="isRunning"
          @click="runSync"
        >
          {{ startLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
