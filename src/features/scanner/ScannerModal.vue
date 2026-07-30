<!--
  Этап 2 п.2.4: модалка сканера дельты. Заменяет openCompareModal и все cmpRender*.

  Разметка повторяет исходную: id am-cmp-overlay / am-cmp-status / am-cmp-result и классы
  amk-* сохранены, поэтому style.scss не меняется. Контент выводится только через
  интерполяцию — ни одного innerHTML, в отличие от этапа 1.

  ВНИМАНИЕ, грабли: в style.scss у селектора .amk-overlay стоит display: none. В монолите
  оверлей показывался императивно — el.style.display = 'flex'. При переходе на v-if элемент
  попадает в DOM, но остаётся невидимым, поэтому display:flex задан инлайном.
  Сам селектор не правим: на нём живёт ещё #am-panel и экспортёр Shikimori,
  а переезд amk-* в scoped-стили запланирован отдельно.

  Отличия поведения от 1.9.1 — два и оба согласованы: кнопка отмены во время скана
  и счётчик шагов рядом со строкой статуса.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ScannerDiffCategory from './ScannerDiffCategory.vue'
import {
  addIgnore,
  alName,
  alPlaceholder,
  cancelScan,
  closeScanner,
  deepCheck,
  favAnime,
  favCharacters,
  favIsEqual,
  favManga,
  favStaff,
  hasResult,
  ignoreList,
  isScannerOpen,
  isScanning,
  progressLabel,
  removeIgnore,
  shikiLogin,
  startScan,
  statsAnime,
  statsManga,
  statusRows,
  statusText,
  totalDiffCount,
  visibleSections,
} from './scanner-state'
import type { DiffRow } from './scanner-state'

/** Избранное и имена переиспользуют ту же секцию, только без крестиков. */
function favRows(items: Array<{ id: number; title: string }>, side: string): DiffRow[] {
  return items.map((x) => ({ id: x.id, title: x.title, meta: side }))
}

function nameRows(items: Array<{ title: string }>, side: string): DiffRow[] {
  return items.map((x, i) => ({ id: i, title: x.title, meta: side }))
}

const favSections = computed(() => {
  const out: Array<{ key: string; label: string; rows: DiffRow[] }> = []
  const a = favAnime.value
  const m = favManga.value
  const c = favCharacters.value
  const s = favStaff.value
  if (a) {
    if (a.onlyShiki.length)
      out.push({
        key: 'fav-anime-shiki',
        label: 'Избранное — аниме только на Shikimori',
        rows: favRows(a.onlyShiki, 'Shikimori'),
      })
    if (a.onlyAl.length)
      out.push({
        key: 'fav-anime-al',
        label: 'Избранное — аниме только на AniList',
        rows: favRows(a.onlyAl, 'AniList'),
      })
  }
  if (m) {
    if (m.onlyShiki.length)
      out.push({
        key: 'fav-manga-shiki',
        label: 'Избранное — манга только на Shikimori',
        rows: favRows(m.onlyShiki, 'Shikimori'),
      })
    if (m.onlyAl.length)
      out.push({
        key: 'fav-manga-al',
        label: 'Избранное — манга только на AniList',
        rows: favRows(m.onlyAl, 'AniList'),
      })
  }
  if (c) {
    if (c.onlyShiki.length)
      out.push({
        key: 'fav-char-shiki',
        label: 'Персонажи только на Shikimori',
        rows: nameRows(c.onlyShiki, 'Shikimori'),
      })
    if (c.onlyAl.length)
      out.push({
        key: 'fav-char-al',
        label: 'Персонажи только на AniList',
        rows: nameRows(c.onlyAl, 'AniList'),
      })
  }
  if (s) {
    if (s.onlyShiki.length)
      out.push({
        key: 'fav-staff-shiki',
        label: 'Люди только на Shikimori',
        rows: nameRows(s.onlyShiki, 'Shikimori'),
      })
    if (s.onlyAl.length)
      out.push({
        key: 'fav-staff-al',
        label: 'Люди только на AniList',
        rows: nameRows(s.onlyAl, 'AniList'),
      })
  }
  return out
})

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) closeScanner()
}
</script>

<template>
  <div
    v-if="isScannerOpen"
    id="am-cmp-overlay"
    class="amk-overlay"
    style="display: flex"
    @click="onOverlayClick"
    @keydown.esc="closeScanner"
  >
    <div class="amk-modal amk-wide">
      <div class="amk-head">
        <div class="amk-title">
          <span class="amk-dot" style="background: rgb(var(--color-pink))"></span>
          <span class="amk-dot" style="background: rgb(var(--color-blue))"></span>
          Сравнение списков
          <span class="amk-sub">Shikimori ↔ AniList</span>
        </div>
        <button id="am-cmp-close" class="amk-close" type="button" @click="closeScanner">✕</button>
      </div>

      <div class="amk-body">
        <div class="amk-row">
          <input
            id="am-cmp-shiki"
            v-model="shikiLogin"
            class="amk-input"
            type="text"
            placeholder="Логин или id на Shikimori"
            :disabled="isScanning"
            @keydown.enter="startScan"
          />
          <input
            id="am-cmp-al"
            v-model="alName"
            class="amk-input"
            type="text"
            :placeholder="'Имя на AniList (' + alPlaceholder + ')'"
            :disabled="isScanning"
            @keydown.enter="startScan"
          />
        </div>

        <label class="amk-check">
          <input id="am-cmp-deep" v-model="deepCheck" type="checkbox" :disabled="isScanning" />
          Глубокая проверка (сверять каталоги — медленнее)
        </label>

        <div class="amk-row">
          <button
            id="am-cmp-run"
            class="amk-btn amk-btn-primary"
            type="button"
            :disabled="isScanning"
            @click="startScan"
          >
            {{ isScanning ? 'Сканирую…' : 'Сравнить' }}
          </button>
          <button v-if="isScanning" class="amk-btn amk-btn-ghost" type="button" @click="cancelScan">
            Отменить
          </button>
        </div>

        <div id="am-cmp-status" class="amk-meta">
          <span v-if="progressLabel" class="amk-count">{{ progressLabel }}</span>
          {{ statusText }}
        </div>

        <div id="am-cmp-result">
          <template v-if="hasResult">
            <table v-if="statsAnime" class="amk-table">
              <thead>
                <tr>
                  <th>Аниме</th>
                  <th>Shikimori</th>
                  <th>AniList</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Всего</td>
                  <td>{{ statsAnime.shiki.total }}</td>
                  <td>{{ statsAnime.al.total }}</td>
                </tr>
                <tr v-for="row in statusRows" :key="row.key">
                  <td>{{ row.label }}</td>
                  <td>{{ statsAnime.shiki.byStatus[row.key] }}</td>
                  <td>{{ statsAnime.al.byStatus[row.key] }}</td>
                </tr>
                <tr>
                  <td>Средняя оценка</td>
                  <td>{{ statsAnime.shiki.mean.toFixed(2) }}</td>
                  <td>{{ statsAnime.al.mean.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>

            <table v-if="statsManga" class="amk-table">
              <thead>
                <tr>
                  <th>Манга</th>
                  <th>Shikimori</th>
                  <th>AniList</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Всего</td>
                  <td>{{ statsManga.shiki.total }}</td>
                  <td>{{ statsManga.al.total }}</td>
                </tr>
                <tr v-for="row in statusRows" :key="row.key">
                  <td>{{ row.label }}</td>
                  <td>{{ statsManga.shiki.byStatus[row.key] }}</td>
                  <td>{{ statsManga.al.byStatus[row.key] }}</td>
                </tr>
                <tr>
                  <td>Средняя оценка</td>
                  <td>{{ statsManga.shiki.mean.toFixed(2) }}</td>
                  <td>{{ statsManga.al.mean.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>

            <ScannerDiffCategory
              v-for="section in visibleSections"
              :key="section.key"
              :label="section.label"
              :rows="section.rows"
              :sign="section.sign"
              :ignorable="section.ignorable"
              @ignore="addIgnore"
            />
            <div v-if="totalDiffCount === 0" class="amk-meta">Расхождений нет.</div>

            <ScannerDiffCategory
              v-for="section in favSections"
              :key="section.key"
              :label="section.label"
              :rows="section.rows"
              :sign="1"
              :ignorable="false"
            />
            <div v-if="favIsEqual" class="amk-meta">Избранное совпадает.</div>
          </template>
        </div>

        <details v-if="ignoreList.length" class="amk-collapse">
          <summary>
            Скрытые тайтлы
            <span class="amk-count">{{ ignoreList.length }}</span>
          </summary>
          <div class="amk-collapse-body">
            <div v-for="item in ignoreList" :key="item.signed" class="amk-diffrow">
              <span class="amk-name">{{ item.title }}</span>
              <span class="amk-meta">{{ item.kind }}</span>
              <button
                class="amk-x cmp-unignore"
                type="button"
                title="Вернуть тайтл в результаты"
                @click="removeIgnore(item.signed)"
              >
                ↺
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>
