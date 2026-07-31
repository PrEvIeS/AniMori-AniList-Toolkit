<script setup lang="ts">
// Этап 2 п.2.7: окно переноса списков Shikimori → AniList.
//
// Разметка снята с `openExportModal()` версии 1.9.1: тот же порядок блоков (ряд из двух
// полей → карточка «Что переносить» → карточка «Токен AniList» → «Запуск»), те же id и классы.
//
// Пункт 3.7 снял с окна всю светлую обвязку. Раньше окно рисовалось на Shikimori, где нет
// переменных темы AniList, поэтому фон, цвет текста и границы полей задавались вручную
// (белый фон, чёрный текст), а недостающие переменные подставлял sync-theme.ts. Теперь окно
// открывается только на AniList, где работают те же --color-*, что у настроек и сравнения.
// Оформление отдано классам .amk-*, и окно автоматически следует теме сайта и акценту.
//
// Отличия от монолита, все осознанные:
//  1. Предупреждение о публичности профиля — требование RM2 п.2.7. Текст зависит от платформы:
//     в браузере запросы уходят с куками сессии и скрытый профиль читается, в десктопе — нет.
//     Показывать браузерному пользователю требование, которое его не касается, нечестно.
//  2. Подпись режима берётся из `syncMode`.
//  3. Нет отдельного `<span class="amk-dot">`: точку рисует сам CSS, ручной span даёт задвоение.

import { isAnonymousShikiAccess } from '../../api/shikimori-user'
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

const modeLabel = syncMode === 'export' ? 'экспорт' : 'импорт'

/**
 * В десктопе списки читаются анонимно и открытый профиль обязателен. В юзерскрипте
 * запрос идёт через GM_xmlhttpRequest с куками браузера, поэтому требования нет — нужен
 * лишь выполненный вход на Shikimori в том же браузере.
 */
const anonymous = isAnonymousShikiAccess()

const FIELD_STYLE = 'flex:1;width:auto;'

const AUTH_LINK_STYLE =
  'color:rgb(var(--color-blue));text-decoration:none;font-weight:700;display:inline-block;padding:6px 12px;border:1px solid rgb(var(--color-blue));border-radius:6px;'
</script>

<template>
  <div
    v-if="isSyncOpen"
    id="shiki-export-overlay"
    class="amk-overlay"
    style="display: flex"
    @click.self="closeSyncModal"
  >
    <div class="amk-modal" style="width: 500px">
      <div class="amk-head">
        <h2 class="amk-title">
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
            line-height: 1.4;
          "
        >
          <template v-if="anonymous">
            ⚠️ Списки читаются без входа в аккаунт, поэтому ваш профиль на Shikimori должен быть
            открыт (публичен) на время переноса. Если профиль скрыт настройками приватности,
            сервер откажет в доступе.
          </template>
          <template v-else>
            ℹ️ Списки читаются с Shikimori под вашей сессией в этом же браузере. Если вы не вошли
            в аккаунт, скрытый профиль будет недоступен.
          </template>
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
          :disabled="isRunning"
          @click="runSync"
        >
          Запуск
        </button>
      </div>
    </div>
  </div>
</template>
