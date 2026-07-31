<!--
  Пункт 2.2 плана: панель настроек #am-panel на Vue (замена императивного features/ui/settings.ts).

  Разметка, идентификаторы и классы повторяют 1.9.1 один в один — весь CSS (.amk-*, .am-dict-*,
  .am-cl-*, .am-accent-*) уже лежит в style.scss и не менялся. Инлайновый style оставлен ровно
  там, где он был в монолите.

  Состояние и запись в хранилище живут в settings-state.ts. Компонент не трогает GM_setValue
  напрямую (РИСК №1 из AUDITION.md).

  Текстовые поля намеренно работают через :value + @change, а не v-model: монолит сохранял их
  по событию change (потеря фокуса), а не на каждое нажатие клавиши. Сохраняем это поведение,
  иначе домены и словарь писались бы в хранилище посимвольно.

  Пункт 2.8: во вкладке «Модули» появилась карточка «Десктоп» — единственный блок настроек,
  которого не было в 1.9.1. Он намеренно отделён от остальных модулей: переключатель пишет ключ,
  но потребитель появится только на 4.7 в on_new_window Tauri.

  Пункт 2.10: там же карточка «Реклама». В отличие от «Десктопа», её тумблер действует сразу —
  hideAds дёргает syncAdblock() в settings-state.ts. Перезагрузка нужна только чтобы вернуть
  баннеры обратно: выпотрошенные слоты мы не восстанавливаем.

  Динамический import() здесь запрещён: сборка — однофайловый userscript, любой чанк ломает его.
-->
<template>
  <div
    v-if="isSettingsOpen"
    id="am-panel"
    class="am-accent-scope"
    style="display: flex"
    @click.self="closeSettings()"
  >
    <div class="amk-modal">
      <div class="amk-head">
        <h2 class="amk-title">
          <span class="amk-dot"></span>AniMori <span class="amk-sub">настройки</span>
        </h2>
        <button class="amk-close" id="am-set-close" title="Закрыть" @click="closeSettings()">✕</button>
      </div>

      <div class="amk-body amk-tabbed">
        <nav class="amk-tabnav">
          <button
            v-for="tab in TABS"
            :key="tab.key"
            type="button"
            class="amk-tab"
            :class="{ active: activeTab === tab.key }"
            :data-tab="tab.key"
            @click="activeTab = tab.key"
          >
            <span class="amk-tab-ic">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                v-html="TAB_ICONS[tab.key]"
              ></svg>
            </span>
            {{ tab.label }}
            <span v-if="tab.key === 'dict'" class="amk-tab-count" id="am-dict-count" :hidden="dictTotal === 0">{{
              dictTotal
            }}</span>
          </button>
        </nav>

        <div class="amk-tabpanes">
          <!-- ==== Перевод ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'translate' }" data-pane="translate">
            <div class="amk-card">
              <div class="amk-card-title">Перевод</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Интерфейс</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_interface" v-model="translateInterface" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Тайтлы и описания</b><span class="amk-row-hint">основной источник · фоллбэк</span></span
                >
              </div>
              <div class="amk-row" style="gap: 8px; border-top: none; padding-top: 0">
                <select
                  class="amk-select"
                  id="set_title_primary"
                  style="flex: 1"
                  :value="titlePrimary"
                  @change="onPrimaryChange($event)"
                >
                  <option value="shikimori">Shikimori</option>
                  <option value="anime365">anime365</option>
                  <option value="off">Выключено (оригинал)</option>
                </select>
                <select
                  class="amk-select"
                  id="set_title_fallback"
                  style="flex: 1"
                  :value="titleFallback"
                  :disabled="fallbackDisabled"
                  @change="onFallbackChange($event)"
                >
                  <option value="none">Без фоллбэка</option>
                  <option value="shikimori" :disabled="isFallbackOptionDisabled('shikimori')">Shikimori</option>
                  <option value="anime365" :disabled="isFallbackOptionDisabled('anime365')">anime365</option>
                </select>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Персонажи</b><span class="amk-row-hint">с Shikimori</span></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_chars" v-model="translateCharacters" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Персонал</b><span class="amk-row-hint">с Shikimori</span></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_staff" v-model="translateStaff" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
            </div>
          </div>

          <!-- ==== Словарь ==== -->
          <div class="amk-pane am-notr" :class="{ active: activeTab === 'dict' }" data-pane="dict">
            <div class="amk-card">
              <div class="amk-card-title">Локальный словарь</div>
              <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
                Свои переводы поверх общего словаря. Применяются на странице сразу, без перезагрузки. Регистр
                сохраняется.
              </div>
              <div style="display: flex; gap: 8px; margin-bottom: 8px">
                <input
                  class="amk-input"
                  id="am-dict-src"
                  placeholder="Оригинал (англ.)"
                  style="flex: 1"
                  v-model="dictSrcDraft"
                />
                <input
                  class="amk-input"
                  id="am-dict-tr"
                  placeholder="Перевод (рус.)"
                  style="flex: 1"
                  v-model="dictTrDraft"
                  @keydown.enter="addDictDraft()"
                />
                <button class="amk-btn amk-btn-primary" id="am-dict-add" @click="addDictDraft()">＋</button>
              </div>
              <input
                class="amk-input"
                id="am-dict-search"
                placeholder="Поиск по своим записям…"
                style="margin-bottom: 8px"
                v-model="dictSearch"
              />
              <div id="am-dict-list" style="display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto">
                <div v-for="entry in filteredDictEntries" :key="entry.key" class="am-dict-row">
                  <input
                    class="amk-input"
                    style="flex: 1"
                    :value="entry.key"
                    @change="onDictKeyChange(entry.key, entry.value, $event)"
                  />
                  <input
                    class="amk-input"
                    style="flex: 1"
                    :value="entry.value"
                    @change="onDictValueChange(entry.key, $event)"
                  />
                  <button
                    class="amk-btn amk-btn-ghost am-dict-del"
                    title="Удалить"
                    @click="deleteDictEntry(entry.key)"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div
                id="am-dict-empty"
                class="amk-row-hint"
                style="padding: 14px 2px; text-align: center"
                :style="{ display: dictTotal === 0 ? 'block' : 'none' }"
              >
                Пока нет своих записей. Добавьте перевод выше или выделите текст на странице.
              </div>
            </div>
            <div class="amk-card">
              <div class="amk-card-title">Импорт / Экспорт</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <button class="amk-btn amk-btn-ghost" id="am-dict-export" style="flex: 1" @click="exportDict()">
                  Экспорт
                </button>
                <button class="amk-btn amk-btn-ghost" id="am-dict-import" style="flex: 1" @click="importDictFromFile()">
                  Импорт
                </button>
                <button class="amk-btn amk-btn-ghost" id="am-dict-copy" style="flex: 1" @click="onDictCopy()">
                  {{ dictCopyLabel }}
                </button>
              </div>
              <button
                class="amk-btn amk-btn-primary amk-btn-block"
                id="am-dict-share"
                style="margin-top: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 8px"
                @click="shareDict()"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
                Предложить в общую базу
              </button>
              <div class="amk-row-hint" style="padding: 8px 2px 2px; line-height: 1.5">
                Экспорт скачивает JSON, «Копировать» кладёт его в буфер для отправки другим. Импорт объединяет с
                текущими записями.
              </div>
            </div>
          </div>

          <!-- ==== Модули ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'modules' }" data-pane="modules">
            <div class="amk-card">
              <div class="amk-card-title">Модули</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Аниме-плеер</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_player" v-model="enablePlayer" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Рейтинги MAL и Shiki</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_ratings" v-model="enableRatings" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Дерево франшизы</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_franchise" v-model="enableFranchise" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Музыкальные темы</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_themes" v-model="enableThemes" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
            </div>

            <div class="amk-card">
              <div class="amk-card-title">Реклама</div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Блокировать рекламу AniList</b
                  ><span class="amk-row-hint">баннеры сайта · применяется сразу</span></span
                >
                <label class="amk-switch">
                  <input type="checkbox" id="set_hide_ads" v-model="hideAds" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row-hint" style="padding: 8px 2px 2px; line-height: 1.5">
                Рекламные слоты сайта скрываются вместе с отступами, а их содержимое (включая iframe) удаляется,
                чтобы не тратить трафик и память. Выключение вернёт баннеры после перезагрузки страницы.
              </div>
            </div>

            <div class="amk-card">
              <div class="amk-card-title">Десктоп</div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Блокировать попапы плеера</b
                  ><span class="amk-row-hint">рекламные окна Kodik · только в десктопной версии</span></span
                >
                <label class="amk-switch">
                  <input type="checkbox" id="set_block_popups" v-model="blockPlayerPopups" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row-hint" style="padding: 8px 2px 2px; line-height: 1.5">
                В браузере переключатель ничего не делает: скрипт не может вмешаться в чужой iframe плеера.
                Настройка вступит в силу в десктопном приложении — там новые окна перехватываются на уровне
                оболочки. Реклама, которая уводит текущую страницу редиректом, и оверлеи внутри самого видео
                этим не блокируются.
              </div>
            </div>
          </div>

          <!-- ==== Оформление ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'appearance' }" data-pane="appearance">
            <div class="amk-card">
              <div class="amk-card-title">Оформление</div>
              <div class="amk-row-hint" style="padding: 2px 2px 8px">
                Акцентный цвет тулкита — тему AniList не меняет
              </div>
              <div class="amk-accents" id="am-accent-chips">
                <button
                  v-for="key in ACCENT_KEYS"
                  :key="key"
                  type="button"
                  class="am-accent-chip"
                  :class="{ active: accentPreset === key }"
                  :data-key="key"
                  @click="selectAccent(key)"
                >
                  <span class="am-accent-dot" :style="{ background: AM_ACCENTS[key].dot }"></span>{{
                    AM_ACCENTS[key].name
                  }}
                </button>
              </div>
            </div>
          </div>

          <!-- ==== Ссылки ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'links' }" data-pane="links">
            <div class="amk-card">
              <div class="amk-card-title">Внешние ссылки</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Показывать ссылки</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_extlinks" v-model="enableExtLinks" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>RuTracker</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_link_rutracker" v-model="enableLinkRutracker" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>YummyAnime</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_link_yummy" v-model="enableLinkYummy" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <input
                class="amk-input amk-mono"
                id="set_yummy_domain"
                placeholder="yummyanime.tv"
                style="margin: 2px 0 8px"
                :value="yummyDomain"
                @change="onDomainChange('yummy', $event)"
              />
              <div class="amk-row">
                <span class="amk-row-label"><b>AnimeGO</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_link_animego" v-model="enableLinkAnimego" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <input
                class="amk-input amk-mono"
                id="set_animego_domain"
                placeholder="animego.org"
                style="margin: 2px 0 8px"
                :value="animegoDomain"
                @change="onDomainChange('animego', $event)"
              />
              <div class="amk-row">
                <span class="amk-row-label"><b>MangaLib</b></span>
                <label class="amk-switch">
                  <input type="checkbox" id="set_link_mangalib" v-model="enableLinkMangalib" />
                  <span class="amk-track"></span><span class="amk-thumb"></span>
                </label>
              </div>
              <input
                class="amk-input amk-mono"
                id="set_mangalib_domain"
                placeholder="mangalib.me"
                style="margin: 2px 0 6px"
                :value="mangalibDomain"
                @change="onDomainChange('mangalib', $event)"
              />
            </div>

            <div class="amk-card">
              <div class="amk-card-title">Свои ссылки</div>
              <div id="am-custom-links-list" style="display: flex; flex-direction: column; gap: 10px">
                <div v-for="(link, index) in customLinks" :key="index" class="am-cl-row">
                  <div style="display: flex; gap: 8px; align-items: center">
                    <input
                      class="amk-input"
                      placeholder="Название"
                      style="flex: 1"
                      :value="link.name"
                      @change="onLinkFieldChange(index, 'name', $event)"
                    />
                    <button
                      class="amk-btn amk-btn-ghost am-cl-del"
                      title="Удалить"
                      @click="removeCustomLink(index)"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    class="amk-input amk-mono"
                    :placeholder="CUSTOM_URL_EXAMPLE"
                    style="margin-top: 6px"
                    :value="link.url"
                    @change="onLinkFieldChange(index, 'url', $event)"
                  />
                  <div class="am-cl-swatches">
                    <span
                      v-for="color in CL_COLORS"
                      :key="color"
                      class="am-cl-sw"
                      :class="{ active: link.color === color }"
                      :style="{ background: 'rgb(' + color + ')' }"
                      @click="setCustomLinkColor(index, color)"
                    ></span>
                  </div>
                </div>
              </div>
              <button class="amk-btn amk-btn-ghost" id="am-custom-add" style="width: 100%; margin-top: 10px" @click="addCustomLink()">
                ＋ Добавить свою ссылку
              </button>
              <div class="amk-row-hint" style="padding: 10px 2px 2px; line-height: 1.5">
                В URL-шаблоне подставляются:
                <code style="background: rgba(var(--color-text-light), 0.12); padding: 1px 5px; border-radius: 4px"
                  >{ru}</code
                >
                — русское название,
                <code style="background: rgba(var(--color-text-light), 0.12); padding: 1px 5px; border-radius: 4px"
                  >{romaji}</code
                >
                — ромадзи,
                <code style="background: rgba(var(--color-text-light), 0.12); padding: 1px 5px; border-radius: 4px"
                  >{query}</code
                >
                — авто (ru → romaji). Всё кодируется автоматически.
              </div>
            </div>
          </div>

          <!-- ==== Аккаунт ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'account' }" data-pane="account">
            <div class="amk-card">
              <div class="amk-card-title">Авторизация AniList</div>
              <div class="amk-row-hint" style="padding: 8px 2px 6px">
                Токен нужен для экспорта и сравнения списков. Создайте Client
                <a
                  :href="AL_DEV_SETTINGS"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="color: rgb(var(--color-blue)); text-decoration: none"
                  >здесь</a
                >, redirect URL:
                <code style="background: rgba(var(--color-text-light), 0.12); padding: 1px 5px; border-radius: 4px">{{
                  AL_PIN_REDIRECT
                }}</code>
              </div>
              <input
                class="amk-input amk-mono"
                type="password"
                id="set_al_token"
                placeholder="Токен AniList"
                style="margin-bottom: 8px"
                :value="alToken"
                @change="onTokenChange($event)"
              />
              <div style="display: flex; gap: 8px; margin-bottom: 6px">
                <input class="amk-input amk-mono" id="set_al_client" placeholder="Client ID" style="flex: 1" v-model="alClientId" />
                <button class="amk-btn amk-btn-ghost" id="set_al_gen" title="Создать ссылку авторизации" @click="onGenerateAuthLink()">
                  Ссылка
                </button>
              </div>
              <div id="set_al_link_wrap" style="text-align: center; font-size: 12px">
                <a
                  v-if="alAuthLink"
                  :href="alAuthLink"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="
                    color: rgb(var(--color-blue));
                    text-decoration: none;
                    font-weight: bold;
                    display: block;
                    padding: 6px;
                    border: 1px dashed rgb(var(--color-blue));
                    border-radius: 6px;
                    margin-top: 5px;
                    transition: 0.2s;
                  "
                  >👉 Клик: Перейти к авторизации</a
                >
              </div>
            </div>
          </div>

          <!-- ==== Прочее ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'misc' }" data-pane="misc">
            <div class="amk-card">
              <div class="amk-card-title">Прочее</div>
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
          </div>

          <!-- ==== Поддержать ==== -->
          <div class="amk-pane" :class="{ active: activeTab === 'support' }" data-pane="support">
            <div class="amk-card">
              <div class="amk-card-title">Поддержать проект</div>
              <div class="amk-row-hint" style="padding: 2px 2px 10px; line-height: 1.55">
                AniMori — бесплатный проект, я делаю его из любви к японским мультикам. Денег не нужно. Если тулкит
                вам пригодился, лучшая благодарность — пара действий ниже. Это правда помогает.
              </div>
              <button
                class="amk-btn amk-btn-primary amk-btn-block"
                id="am-sup-star"
                style="margin-bottom: 8px; gap: 8px"
                @click="openExternal(SUP_GITHUB)"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                Star на GitHub
              </button>
              <button
                class="amk-btn amk-btn-ghost amk-btn-block"
                id="am-sup-review"
                style="margin-bottom: 8px; gap: 8px"
                @click="openExternal(SUP_GREASY_FEEDBACK)"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Оценить на Greasy Fork
              </button>
              <div class="amk-row-hint" style="padding: 2px 2px 6px; line-height: 1.5">
                Отзыв двигает скрипт в выдаче — так его находят новые пользователи.
              </div>
            </div>
            <div class="amk-card">
              <div class="amk-card-title">Поделиться</div>
              <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
                Рассказать друзьям — тоже поддержка. Ссылка на установку:
              </div>
              <div style="display: flex; gap: 8px">
                <input class="amk-input amk-mono" id="am-sup-link" readonly :value="SUP_GREASY" style="flex: 1" />
                <button class="amk-btn amk-btn-primary" id="am-sup-copy" style="gap: 7px" @click="onSupportCopy($event)">
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span>{{ supportCopyLabel }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="amk-foot">
        <button class="amk-btn amk-btn-primary amk-btn-block" id="am-apply" @click="reloadPage()">
          Применить и перезагрузить
        </button>
        <button class="amk-btn amk-btn-danger" id="am-clear" @click="onClearCache()">Очистить кэш</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

import { AM_ACCENTS } from '../../core/accent'
import { CL_COLORS } from '../../core/custom-links'
import { clearCache } from '../../core/db'
import type { TitleSource } from '../../core/settings'
import { amCopy } from '../../utils/dom'
import {
  ACCENT_KEYS,
  AL_DEV_SETTINGS,
  AL_PIN_REDIRECT,
  CUSTOM_URL_EXAMPLE,
  SUP_GITHUB,
  SUP_GREASY,
  SUP_GREASY_FEEDBACK,
  accentPreset,
  activeTab,
  addCustomLink,
  addDictDraft,
  alAuthLink,
  alClientId,
  alToken,
  animegoDomain,
  blockPlayerPopups,
  closeSettings,
  commitDictEntry,
  copyDictToClipboard,
  customLinks,
  deleteDictEntry,
  dictSearch,
  dictSrcDraft,
  dictTotal,
  dictTrDraft,
  enableExtLinks,
  enableFranchise,
  enableLinkAnimego,
  enableLinkMangalib,
  enableLinkRutracker,
  enableLinkYummy,
  enableLogger,
  enablePlayer,
  enableRatings,
  enableThemes,
  exportDict,
  fallbackDisabled,
  filteredDictEntries,
  generateAuthLink,
  hideAds,
  importDictFromFile,
  isFallbackOptionDisabled,
  isSettingsOpen,
  loadAuthState,
  mangalibDomain,
  normalizeDomain,
  persistCustomLinks,
  refreshDict,
  reloadCustomLinks,
  removeCustomLink,
  saveAlToken,
  selectAccent,
  setCustomLinkColor,
  shareDict,
  syncTitleSources,
  titleFallback,
  titlePrimary,
  translateCharacters,
  translateInterface,
  translateStaff,
  yummyDomain,
} from './settings-state'
import type { TabKey } from './settings-state'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'translate', label: 'Перевод' },
  { key: 'dict', label: 'Словарь' },
  { key: 'modules', label: 'Модули' },
  { key: 'appearance', label: 'Оформление' },
  { key: 'links', label: 'Ссылки' },
  { key: 'account', label: 'Аккаунт' },
  { key: 'misc', label: 'Прочее' },
  { key: 'support', label: 'Поддержать' },
]

/** Иконки вкладок — те же SVG, что в 1.9.1. */
const TAB_ICONS: Record<TabKey, string> = {
  translate:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  dict: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  modules:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  appearance: '<path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/>',
  links:
    '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-2 2"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l2-2"/>',
  account: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="M16 7l3 3"/>',
  misc: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  support:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
}

const dictCopyLabel = ref('Копировать')
const supportCopyLabel = ref('Копировать')

function inputValue(e: Event): string {
  const el = e.target
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : ''
}

// ==== Источники названий ====

function onPrimaryChange(e: Event): void {
  titlePrimary.value = inputValue(e) as TitleSource
  syncTitleSources()
}

function onFallbackChange(e: Event): void {
  titleFallback.value = inputValue(e) as TitleSource
}

// ==== Домены ====

function onDomainChange(which: 'yummy' | 'animego' | 'mangalib', e: Event): void {
  const normalized = normalizeDomain(inputValue(e))
  if (which === 'yummy') yummyDomain.value = normalized
  else if (which === 'animego') animegoDomain.value = normalized
  else mangalibDomain.value = normalized
}

// ==== Свои ссылки ====

function onLinkFieldChange(index: number, field: 'name' | 'url', e: Event): void {
  const link = customLinks.value[index]
  if (!link) return
  link[field] = inputValue(e).trim()
  persistCustomLinks()
}

// ==== Словарь ====

function onDictKeyChange(oldKey: string, value: string, e: Event): void {
  commitDictEntry(oldKey, inputValue(e), value)
}

function onDictValueChange(key: string, e: Event): void {
  commitDictEntry(key, key, inputValue(e))
}

function onDictCopy(): void {
  if (!copyDictToClipboard()) return
  dictCopyLabel.value = '✓ Скопировано'
  setTimeout(() => {
    dictCopyLabel.value = 'Копировать'
  }, 1400)
}

// ==== Аккаунт ====

function onTokenChange(e: Event): void {
  alToken.value = inputValue(e).trim()
  saveAlToken()
}

function onGenerateAuthLink(): void {
  if (!generateAuthLink()) {
    alert('Введите Client ID (его можно создать в настройках AniList -> Developer)')
  }
}

// ==== Поддержать ====

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener')
}

function onSupportCopy(e: Event): void {
  const target = e.currentTarget
  amCopy(SUP_GREASY, target instanceof HTMLElement ? target : undefined)
  supportCopyLabel.value = 'Скопировано ✓'
  setTimeout(() => {
    supportCopyLabel.value = 'Копировать'
  }, 1200)
}

// ==== Подвал ====

function reloadPage(): void {
  location.reload()
}

function onClearCache(): void {
  void clearCache().then(() => {
    alert('Кэш сброшен!')
    location.reload()
  })
}

// ==== Жизненный цикл ====

onMounted(() => {
  reloadCustomLinks()
  loadAuthState()
  syncTitleSources()
})

// Словарь и свои ссылки могут меняться извне (захват выделения на странице),
// поэтому перечитываем их при каждом открытии панели.
watch(isSettingsOpen, (open) => {
  if (!open) return
  refreshDict()
  reloadCustomLinks()
})
</script>
