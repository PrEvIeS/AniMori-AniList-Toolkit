<script setup lang="ts">
// Этап 2 п.2.7: окно переноса списков Shikimori ↔ AniList.
//
// Разметка снята с `openExportModal()` версии 1.9.1 буква в букву: тот же порядок блоков
// (ряд из двух полей → карточка «Что переносить» → карточка «Токен AniList» → «Запуск»),
// те же id, классы и inline-стили. Окно светлое, поэтому у полей свои тёмные границы и текст
// — без этого поля сливаются с фоном.
//
// Отличия от монолита ровно три, все осознанные:
//  1. Предупреждение о публичности профиля — требование RM2 п.2.7. Скрытый профиль даёт 403,
//     и раньше пользователь узнавал об этом только из сообщения об ошибке посреди переноса.
//  2. Подпись режима берётся из `syncMode`: тот же компонент станет импортом в десктопе.
//  3. Нет отдельного `<span class="amk-dot">`: в итерации 5 выяснилось, что точку рисует сам CSS,
//     а ручной span даёт задвоение.

import { computed, onMounted, ref, watch } from 'vue'
import { amkShikiTokens } from './sync-theme'
import {
  AL_DEVELOPER_URL,
  AL_REDIRECT_URL,
  alToken,
  authUrl,
  clientId,
  closeSyncModal,
  generateAuthUrl,
  isRunning,
  isSyncOpen,
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

const FIELD_STYLE =
  'flex:1;width:auto;background:rgba(0,0,0,0.08);color:#000;border:1px solid rgba(0,0,0,0.2);'

const AUTH_LINK_STYLE =
  'color:rgb(var(--color-blue));text-decoration:none;font-weight:700;display:inline-block;padding:6px 12px;border:1px solid rgb(var(--color-blue));border-radius:6px;'

// Тема Shikimori меняется без перезагрузки, поэтому переменные считываются при каждом показе.
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
        <h2 class="amk-title" style="color: #000">
          <span style="color: #e05264">Shikimori</span>&nbsp;➜&nbsp;<span style="color: #3dbbee"
            >AniList</span
          >
          <span class="amk-sub">{{ modeLabel }}</span>
        </h2>
        <button id="se-close" class="amk-close" title="Закрыть" @click="closeSyncModal">✕</button>
      </div>

      <div class="amk-body">
        <div
          class="amk-row-hint"
          style="
            margin-bottom: 12px;
            padding: 8px 10px;
            border-radius: 8px;
            background: rgba(224, 82, 100, 0.12);
            border: 1px solid rgba(224, 82, 100, 0.35);
            color: #000;
            line-height: 1.4;
          "
        >
          ⚠️ Ваш профиль на Shikimori должен быть открыт (публичен) на время переноса списков. Если
          профиль скрыт настройками приватности, сервер откажет в доступе.
        </div>

        <div style="display: flex; gap: 10px">
          <input
            id="se-user"
            v-model="shikiUser"
            class="amk-input"
            placeholder="Логин Shikimori"
            :style="FIELD_STYLE"
          />
          <input
            id="se-token"
            v-model="alToken"
            class="amk-input amk-mono"
            type="password"
            placeholder="Токен AniList"
            :style="FIELD_STYLE"
          />
        </div>

        <div class="amk-card">
          <div class="amk-card-title">Что переносить</div>
          <div class="amk-row">
            <span class="amk-row-label"><b>Аниме</b></span>
            <label class="amk-switch">
              <input id="se-anime" v-model="optAnime" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>
          <div class="amk-row">
            <span class="amk-row-label"><b>Манга</b></span>
            <label class="amk-switch">
              <input id="se-manga" v-model="optManga" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>
          <div class="amk-row">
            <span class="amk-row-label"><b>Избранное</b></span>
            <label class="amk-switch">
              <input id="se-favs" v-model="optFavs" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>
          <div class="amk-row">
            <span class="amk-row-label">
              <b>Точные даты просмотров</b>
              <span class="amk-row-hint">из истории Shikimori (медленнее)</span>
            </span>
            <label class="amk-switch">
              <input id="se-dates" v-model="optDates" type="checkbox" />
              <span class="amk-track"></span>
              <span class="amk-thumb"></span>
            </label>
          </div>
        </div>

        <div class="amk-card">
          <div class="amk-card-title">Токен AniList</div>
          <div class="amk-row-hint" style="padding: 8px 2px 6px">
            Создайте Client
            <a
              :href="AL_DEVELOPER_URL"
              target="_blank"
              rel="noopener"
              style="color: #3dbbee; text-decoration: none"
              >здесь</a
            >, redirect URL:
            <code style="background: rgba(0, 0, 0, 0.1); padding: 1px 5px; border-radius: 4px">{{
              AL_REDIRECT_URL
            }}</code>
          </div>
          <div style="display: flex; gap: 8px">
            <input
              id="se-gen-client"
              v-model="clientId"
              class="amk-input amk-mono"
              placeholder="Client ID"
              :style="FIELD_STYLE"
            />
            <button id="se-gen-btn" class="amk-btn amk-btn-ghost" @click="generateAuthUrl">
              Создать URL
            </button>
          </div>
          <div id="se-gen-url" style="margin-top: 10px; text-align: center; font-size: 12px">
            <a v-if="authUrl" :href="authUrl" target="_blank" rel="noopener" :style="AUTH_LINK_STYLE">
              👉 Клик для авторизации
            </a>
          </div>
        </div>
      </div>

      <div class="amk-foot">
        <button
          id="se-start"
          class="amk-btn amk-btn-primary amk-btn-block"
          style="border: 1px solid rgba(0, 0, 0, 0.3)"
          :disabled="isRunning"
          @click="runSync"
        >
          Запуск
        </button>
      </div>
    </div>
  </div>
</template>
