// Пункт 1.7 плана: панель настроек #am-panel (секция 8 монолита, строки 4226-4595).
//
// Разметка и идентификаторы повторяют 1.9.1 один в один: весь CSS (.amk-*, .am-dict-*,
// .am-cl-*, .am-accent-*) уже перенесён в style.scss коммитом 972803c, поэтому новых
// классов здесь нет и инлайновый style оставлен только там, где он был в монолите.
//
// Порт императивный сознательно: этап 1 закрывается с нулевой регрессией, а на этапе 2
// файл целиком заменяется на SettingsModal.vue (п.2.2).
//
// Важно про адреса: все абсолютные URL собираются конкатенацией и живут в константах
// выше разметки. В монолите два адреса были собраны шаблонной строкой и сломаны
// (тот же класс багов, что чинил 1306f00) — см. комментарии по месту.

import { AM_ACCENTS, amSetAccent } from '../../core/accent'
import { CL_COLORS, getCustomLinks, setCustomLinks } from '../../core/custom-links'
import { clearCache } from '../../core/db'
import {
  getUserDict,
  normDictKey,
  removeUserDictEntry,
  setUserDict,
  upsertUserDictEntry,
} from '../../core/dictionary'
import { saveSetting, settings } from '../../core/settings'
import type { AccentPreset, AniMoriSettings, TitleSource } from '../../core/settings'
import { amCopy, html, rawHTML } from '../../utils/dom'
import { Logger } from '../../utils/logger'
import { ACTION_ORDER, registerActionButton } from './actions'

const PANEL_ID = 'am-panel'

// Адреса — только конкатенацией, никогда шаблонной строкой.
const HTTPS = 'https://'
const SUP_GITHUB = HTTPS + 'github.com/foulnike/AniMori-AniList-Toolkit'
const SUP_GREASY = HTTPS + 'greasyfork.org/scripts/572948'
const ISSUES_NEW = SUP_GITHUB + '/issues/new'
const AL_DEV_SETTINGS = HTTPS + 'anilist.co/settings/developer'
const AL_PIN_REDIRECT = HTTPS + 'anilist.co/api/v2/oauth/pin'
const AL_AUTHORIZE = HTTPS + 'anilist.co/api/v2/oauth/authorize'
const CUSTOM_URL_EXAMPLE = HTTPS + 'site.com/search?q={query}'

/** boolean-настройки: id чекбокса = ключ в GM-хранилище, как в монолите. */
type BoolSettingKey = {
  [K in keyof AniMoriSettings]: AniMoriSettings[K] extends boolean ? K : never
}[keyof AniMoriSettings]

type DomainSettingKey = 'yummyDomain' | 'animegoDomain' | 'mangalibDomain'

const BOOL_SETTINGS: Array<{ id: string; key: BoolSettingKey }> = [
  { id: 'set_interface', key: 'translateInterface' },
  { id: 'set_chars', key: 'translateCharacters' },
  { id: 'set_staff', key: 'translateStaff' },
  { id: 'set_player', key: 'enablePlayer' },
  { id: 'set_ratings', key: 'enableRatings' },
  { id: 'set_franchise', key: 'enableFranchise' },
  { id: 'set_themes', key: 'enableThemes' },
  { id: 'set_extlinks', key: 'enableExtLinks' },
  { id: 'set_link_rutracker', key: 'enableLinkRutracker' },
  { id: 'set_link_yummy', key: 'enableLinkYummy' },
  { id: 'set_link_animego', key: 'enableLinkAnimego' },
  { id: 'set_link_mangalib', key: 'enableLinkMangalib' },
  { id: 'set_logger', key: 'enableLogger' },
]

const DOMAIN_SETTINGS: Array<{ id: string; key: DomainSettingKey }> = [
  { id: 'set_yummy_domain', key: 'yummyDomain' },
  { id: 'set_animego_domain', key: 'animegoDomain' },
  { id: 'set_mangalib_domain', key: 'mangalibDomain' },
]

let panel: HTMLElement | null = null

/** Свитч монолита: доверенная разметка, поэтому rawHTML. */
function sw(id: string, on: boolean): ReturnType<typeof rawHTML> {
  return rawHTML(
    `<label class="amk-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="amk-track"></span><span class="amk-thumb"></span></label>`,
  )
}

/** Иконки вкладок — те же SVG, что в 1.9.1. */
const TAB_ICONS: Record<string, string> = {
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

const TABS: Array<{ key: string; label: string; extra?: string }> = [
  { key: 'translate', label: 'Перевод' },
  { key: 'dict', label: 'Словарь', extra: '<span class="amk-tab-count" id="am-dict-count" hidden>0</span>' },
  { key: 'modules', label: 'Модули' },
  { key: 'appearance', label: 'Оформление' },
  { key: 'links', label: 'Ссылки' },
  { key: 'account', label: 'Аккаунт' },
  { key: 'misc', label: 'Прочее' },
  { key: 'support', label: 'Поддержать' },
]

function buildTabNav(): string {
  return TABS.map((tab, index) => {
    const active = index === 0 ? ' active' : ''
    const icon = TAB_ICONS[tab.key] ?? ''
    return (
      `<button type="button" class="amk-tab${active}" data-tab="${tab.key}">` +
      `<span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>` +
      `${tab.label}${tab.extra ?? ''}</button>`
    )
  }).join('')
}

function buildPanelMarkup(): string {
  return html`
    <div class="amk-modal">
      <div class="amk-head">
        <h2 class="amk-title">
          <span class="amk-dot"></span>AniMori <span class="amk-sub">настройки</span>
        </h2>
        <button class="amk-close" id="am-set-close" title="Закрыть">✕</button>
      </div>
      <div class="amk-body amk-tabbed">
        <nav class="amk-tabnav">${rawHTML(buildTabNav())}</nav>
        <div class="amk-tabpanes">
          <div class="amk-pane active" data-pane="translate">
            <div class="amk-card">
              <div class="amk-card-title">Перевод</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Интерфейс</b></span
                >${sw('set_interface', settings.translateInterface)}
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Тайтлы и описания</b
                  ><span class="amk-row-hint">основной источник · фоллбэк</span></span
                >
              </div>
              <div class="amk-row" style="gap:8px; border-top:none; padding-top:0;">
                <select class="amk-select" id="set_title_primary" style="flex:1;">
                  <option value="shikimori">Shikimori</option>
                  <option value="anime365">anime365</option>
                  <option value="off">Выключено (оригинал)</option>
                </select>
                <select class="amk-select" id="set_title_fallback" style="flex:1;">
                  <option value="none">Без фоллбэка</option>
                  <option value="shikimori">Shikimori</option>
                  <option value="anime365">anime365</option>
                </select>
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Персонажи</b><span class="amk-row-hint">с Shikimori</span></span
                >${sw('set_chars', settings.translateCharacters)}
              </div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Персонал</b><span class="amk-row-hint">с Shikimori</span></span
                >${sw('set_staff', settings.translateStaff)}
              </div>
            </div>
          </div>

          <div class="amk-pane am-notr" data-pane="dict">
            <div class="amk-card">
              <div class="amk-card-title">Локальный словарь</div>
              <div class="amk-row-hint" style="padding:2px 2px 8px; line-height:1.5;">
                Свои переводы поверх общего словаря. Применяются на странице сразу, без
                перезагрузки. Регистр сохраняется.
              </div>
              <div style="display:flex; gap:8px; margin-bottom:8px;">
                <input class="amk-input" id="am-dict-src" placeholder="Оригинал (англ.)" style="flex:1;" />
                <input class="amk-input" id="am-dict-tr" placeholder="Перевод (рус.)" style="flex:1;" />
                <button class="amk-btn amk-btn-primary" id="am-dict-add">＋</button>
              </div>
              <input
                class="amk-input"
                id="am-dict-search"
                placeholder="Поиск по своим записям…"
                style="margin-bottom:8px;"
              />
              <div
                id="am-dict-list"
                style="display:flex; flex-direction:column; gap:6px; max-height:260px; overflow:auto;"
              ></div>
              <div
                id="am-dict-empty"
                class="amk-row-hint"
                style="padding:14px 2px; text-align:center; display:none;"
              >
                Пока нет своих записей. Добавьте перевод выше или выделите текст на странице.
              </div>
            </div>
            <div class="amk-card">
              <div class="amk-card-title">Импорт / Экспорт</div>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="amk-btn amk-btn-ghost" id="am-dict-export" style="flex:1;">Экспорт</button>
                <button class="amk-btn amk-btn-ghost" id="am-dict-import" style="flex:1;">Импорт</button>
                <button class="amk-btn amk-btn-ghost" id="am-dict-copy" style="flex:1;">Копировать</button>
              </div>
              <button
                class="amk-btn amk-btn-primary amk-btn-block"
                id="am-dict-share"
                style="margin-top:8px; display:inline-flex; align-items:center; justify-content:center; gap:8px;"
              >
                ${rawHTML(
                  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
                )}Предложить в общую базу
              </button>
              <div class="amk-row-hint" style="padding:8px 2px 2px; line-height:1.5;">
                Экспорт скачивает JSON, «Копировать» кладёт его в буфер для отправки другим.
                Импорт объединяет с текущими записями.
              </div>
            </div>
          </div>

          <div class="amk-pane" data-pane="modules">
            <div class="amk-card">
              <div class="amk-card-title">Модули</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Аниме-плеер</b></span
                >${sw('set_player', settings.enablePlayer)}
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Рейтинги MAL и Shiki</b></span
                >${sw('set_ratings', settings.enableRatings)}
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Дерево франшизы</b></span
                >${sw('set_franchise', settings.enableFranchise)}
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Музыкальные темы</b></span
                >${sw('set_themes', settings.enableThemes)}
              </div>
            </div>
          </div>

          <div class="amk-pane" data-pane="appearance">
            <div class="amk-card">
              <div class="amk-card-title">Оформление</div>
              <div class="amk-row-hint" style="padding:2px 2px 8px;">
                Акцентный цвет тулкита — тему AniList не меняет
              </div>
              <div class="amk-accents" id="am-accent-chips"></div>
            </div>
          </div>

          <div class="amk-pane" data-pane="links">
            <div class="amk-card">
              <div class="amk-card-title">Внешние ссылки</div>
              <div class="amk-row">
                <span class="amk-row-label"><b>Показывать ссылки</b></span
                >${sw('set_extlinks', settings.enableExtLinks)}
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>RuTracker</b></span
                >${sw('set_link_rutracker', settings.enableLinkRutracker)}
              </div>
              <div class="amk-row">
                <span class="amk-row-label"><b>YummyAnime</b></span
                >${sw('set_link_yummy', settings.enableLinkYummy)}
              </div>
              <input
                class="amk-input amk-mono"
                id="set_yummy_domain"
                placeholder="yummyanime.tv"
                style="margin:2px 0 8px;"
              />
              <div class="amk-row">
                <span class="amk-row-label"><b>AnimeGO</b></span
                >${sw('set_link_animego', settings.enableLinkAnimego)}
              </div>
              <input
                class="amk-input amk-mono"
                id="set_animego_domain"
                placeholder="animego.org"
                style="margin:2px 0 8px;"
              />
              <div class="amk-row">
                <span class="amk-row-label"><b>MangaLib</b></span
                >${sw('set_link_mangalib', settings.enableLinkMangalib)}
              </div>
              <input
                class="amk-input amk-mono"
                id="set_mangalib_domain"
                placeholder="mangalib.me"
                style="margin:2px 0 6px;"
              />
            </div>
            <div class="amk-card">
              <div class="amk-card-title">Свои ссылки</div>
              <div id="am-custom-links-list" style="display:flex; flex-direction:column; gap:10px;"></div>
              <button
                class="amk-btn amk-btn-ghost"
                id="am-custom-add"
                style="width:100%; margin-top:10px;"
              >
                ＋ Добавить свою ссылку
              </button>
              <div class="amk-row-hint" style="padding:10px 2px 2px; line-height:1.5;">
                В URL-шаблоне подставляются:
                <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;"
                  >{ru}</code
                >
                — русское название,
                <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;"
                  >{romaji}</code
                >
                — ромадзи,
                <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;"
                  >{query}</code
                >
                — авто (ru → romaji). Всё кодируется автоматически.
              </div>
            </div>
          </div>

          <div class="amk-pane" data-pane="account">
            <div class="amk-card">
              <div class="amk-card-title">Авторизация AniList</div>
              <div class="amk-row-hint" style="padding:8px 2px 6px;">
                Токен нужен для экспорта и сравнения списков. Создайте Client
                <a
                  href="${AL_DEV_SETTINGS}"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="color:rgb(var(--color-blue));text-decoration:none;"
                  >здесь</a
                >, redirect URL:
                <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;"
                  >${AL_PIN_REDIRECT}</code
                >
              </div>
              <input
                class="amk-input amk-mono"
                type="password"
                id="set_al_token"
                placeholder="Токен AniList"
                style="margin-bottom:8px;"
              />
              <div style="display:flex; gap:8px; margin-bottom:6px;">
                <input class="amk-input amk-mono" id="set_al_client" placeholder="Client ID" style="flex:1;" />
                <button class="amk-btn amk-btn-ghost" id="set_al_gen" title="Создать ссылку авторизации">
                  Ссылка
                </button>
              </div>
              <div id="set_al_link_wrap" style="text-align:center; font-size:12px;"></div>
            </div>
          </div>

          <div class="amk-pane" data-pane="misc">
            <div class="amk-card">
              <div class="amk-card-title">Прочее</div>
              <div class="amk-row">
                <span class="amk-row-label"
                  ><b>Логгер</b
                  ><span class="amk-row-hint">отслеживание действий скрипта (для отладки)</span></span
                >${sw('set_logger', settings.enableLogger)}
              </div>
            </div>
          </div>

          <div class="amk-pane" data-pane="support">
            <div class="amk-card">
              <div class="amk-card-title">Поддержать проект</div>
              <div class="amk-row-hint" style="padding:2px 2px 10px; line-height:1.55;">
                AniMori — бесплатный проект, я делаю его из любви к японским мультикам. Денег не
                нужно. Если тулкит вам пригодился, лучшая благодарность — пара действий ниже. Это
                правда помогает.
              </div>
              <button
                class="amk-btn amk-btn-primary amk-btn-block"
                id="am-sup-star"
                style="margin-bottom:8px; gap:8px;"
              >
                ${rawHTML(
                  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                )}Star на GitHub
              </button>
              <button
                class="amk-btn amk-btn-ghost amk-btn-block"
                id="am-sup-review"
                style="margin-bottom:8px; gap:8px;"
              >
                ${rawHTML(
                  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
                )}Оценить на Greasy Fork
              </button>
              <div class="amk-row-hint" style="padding:2px 2px 6px; line-height:1.5;">
                Отзыв двигает скрипт в выдаче — так его находят новые пользователи.
              </div>
            </div>
            <div class="amk-card">
              <div class="amk-card-title">Поделиться</div>
              <div class="amk-row-hint" style="padding:2px 2px 8px; line-height:1.5;">
                Рассказать друзьям — тоже поддержка. Ссылка на установку:
              </div>
              <div style="display:flex; gap:8px;">
                <input
                  class="amk-input amk-mono"
                  id="am-sup-link"
                  readonly
                  value="${SUP_GREASY}"
                  style="flex:1;"
                />
                <button class="amk-btn amk-btn-primary" id="am-sup-copy" style="gap:7px;">
                  ${rawHTML(
                    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
                  )}<span>Копировать</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="amk-foot">
        <button class="amk-btn amk-btn-primary amk-btn-block" id="am-apply">
          Применить и перезагрузить
        </button>
        <button class="amk-btn amk-btn-danger" id="am-clear">Очистить кэш</button>
      </div>
    </div>
  `
}

// ==== Вкладки ====

function wireTabs(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.amk-tab').forEach((tab) => {
    tab.onclick = () => {
      const key = tab.dataset.tab
      root.querySelectorAll('.amk-tab').forEach((x) => x.classList.toggle('active', x === tab))
      root
        .querySelectorAll<HTMLElement>('.amk-pane')
        .forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === key))
    }
  })
}

// ==== Акценты ====

function renderAccentChips(): void {
  const wrap = document.getElementById('am-accent-chips')
  if (!wrap) return

  ;(Object.keys(AM_ACCENTS) as AccentPreset[]).forEach((key) => {
    const accent = AM_ACCENTS[key]
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'am-accent-chip' + (settings.accentPreset === key ? ' active' : '')
    chip.dataset.key = key

    const dot = document.createElement('span')
    dot.className = 'am-accent-dot'
    dot.style.background = accent.dot
    chip.append(dot, document.createTextNode(accent.name))

    chip.onclick = () => {
      saveSetting('accentPreset', 'am_accent', key)
      wrap.querySelectorAll('.am-accent-chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      amSetAccent(key)
    }

    wrap.appendChild(chip)
  })
}

// ==== Простые настройки ====

function wireBooleanSettings(): void {
  for (const { id, key } of BOOL_SETTINGS) {
    const el = document.getElementById(id)
    if (el instanceof HTMLInputElement) {
      el.onchange = () => saveSetting(key, id, el.checked)
    }
  }
}

function wireDomainSettings(): void {
  for (const { id, key } of DOMAIN_SETTINGS) {
    const el = document.getElementById(id)
    if (!(el instanceof HTMLInputElement)) continue
    el.value = settings[key]
    el.onchange = () => {
      const normalized = el.value
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '')
      el.value = normalized
      saveSetting(key, id, normalized)
    }
  }
}

/** Источники названий: фоллбэк не может совпадать с основным. */
function wireTitleSources(): void {
  const primary = document.getElementById('set_title_primary')
  const fallback = document.getElementById('set_title_fallback')
  if (!(primary instanceof HTMLSelectElement) || !(fallback instanceof HTMLSelectElement)) return

  primary.value = settings.titlePrimary
  fallback.value = settings.titleFallback

  const sync = (): void => {
    const off = primary.value === 'off'
    fallback.disabled = off
    Array.from(fallback.options).forEach((o) => {
      o.disabled = o.value !== 'none' && o.value === primary.value
    })
    if (off || fallback.value === primary.value) fallback.value = 'none'
  }

  sync()

  primary.onchange = () => {
    saveSetting('titlePrimary', 'set_title_primary', primary.value as TitleSource)
    sync()
    saveSetting('titleFallback', 'set_title_fallback', fallback.value as TitleSource)
  }
  fallback.onchange = () => {
    saveSetting('titleFallback', 'set_title_fallback', fallback.value as TitleSource)
  }
}

// ==== Свои ссылки ====

function renderCustomLinksEditor(): void {
  const list = document.getElementById('am-custom-links-list')
  if (!list) return

  const links = getCustomLinks()
  list.textContent = ''

  links.forEach((cl, idx) => {
    const row = document.createElement('div')
    row.className = 'am-cl-row'

    const top = document.createElement('div')
    top.style.cssText = 'display:flex; gap:8px; align-items:center;'

    const nameIn = document.createElement('input')
    nameIn.className = 'amk-input'
    nameIn.placeholder = 'Название'
    nameIn.value = cl.name || ''
    nameIn.style.flex = '1'

    const del = document.createElement('button')
    del.className = 'amk-btn amk-btn-ghost am-cl-del'
    del.textContent = '✕'
    del.title = 'Удалить'
    top.append(nameIn, del)

    const urlIn = document.createElement('input')
    urlIn.className = 'amk-input amk-mono'
    // В монолите этот placeholder был собран шаблонной строкой и показывал
    // лишние фигурные скобки вокруг адреса — тот же дефект, что чинил 1306f00.
    urlIn.placeholder = CUSTOM_URL_EXAMPLE
    urlIn.value = cl.url || ''
    urlIn.style.marginTop = '6px'

    const swatches = document.createElement('div')
    swatches.className = 'am-cl-swatches'
    CL_COLORS.forEach((color) => {
      const sample = document.createElement('span')
      sample.className = 'am-cl-sw' + (cl.color === color ? ' active' : '')
      sample.style.background = 'rgb(' + color + ')'
      sample.onclick = () => {
        const arr = getCustomLinks()
        const target = arr[idx]
        if (!target) return
        target.color = color
        setCustomLinks(arr)
        renderCustomLinksEditor()
      }
      swatches.appendChild(sample)
    })

    const save = (): void => {
      const arr = getCustomLinks()
      const target = arr[idx]
      if (!target) return
      target.name = nameIn.value.trim()
      target.url = urlIn.value.trim()
      setCustomLinks(arr)
    }

    nameIn.onchange = save
    urlIn.onchange = save
    del.onclick = () => {
      const arr = getCustomLinks()
      arr.splice(idx, 1)
      setCustomLinks(arr)
      renderCustomLinksEditor()
    }

    row.append(top, urlIn, swatches)
    list.appendChild(row)
  })
}

function wireCustomLinks(): void {
  renderCustomLinksEditor()
  const addBtn = document.getElementById('am-custom-add')
  if (!addBtn) return
  addBtn.onclick = () => {
    const arr = getCustomLinks()
    const color = CL_COLORS[arr.length % CL_COLORS.length] ?? CL_COLORS[0] ?? '61,180,242'
    arr.push({ name: '', url: '', color })
    setCustomLinks(arr)
    renderCustomLinksEditor()
  }
}

// ==== Редактор локального словаря ====

function renderDictEditor(): void {
  const listEl = document.getElementById('am-dict-list')
  if (!listEl) return

  const emptyEl = document.getElementById('am-dict-empty')
  const searchEl = document.getElementById('am-dict-search')
  const userDict = getUserDict()
  const total = Object.keys(userDict).length

  const badge = document.getElementById('am-dict-count')
  if (badge) {
    badge.textContent = String(total)
    badge.hidden = total === 0
  }

  const query = normDictKey(
    searchEl instanceof HTMLInputElement ? searchEl.value : '',
  ).toLowerCase()

  const keys = Object.keys(userDict)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .filter(
      (k) =>
        !query ||
        k.toLowerCase().includes(query) ||
        String(userDict[k]).toLowerCase().includes(query),
    )

  listEl.textContent = ''
  if (emptyEl) emptyEl.style.display = total ? 'none' : 'block'

  keys.forEach((key) => {
    const row = document.createElement('div')
    row.className = 'am-dict-row'

    const srcIn = document.createElement('input')
    srcIn.className = 'amk-input'
    srcIn.value = key
    srcIn.style.flex = '1'

    const trIn = document.createElement('input')
    trIn.className = 'amk-input'
    trIn.value = userDict[key] ?? ''
    trIn.style.flex = '1'

    const del = document.createElement('button')
    del.className = 'amk-btn amk-btn-ghost am-dict-del'
    del.textContent = '✕'
    del.title = 'Удалить'

    const commit = (): void => {
      const newKey = normDictKey(srcIn.value)
      const newValue = normDictKey(trIn.value)
      if (!newKey || !newValue) return
      if (newKey !== key) removeUserDictEntry(key)
      upsertUserDictEntry(newKey, newValue)
      if (newKey !== key) renderDictEditor()
    }

    srcIn.onchange = commit
    trIn.onchange = commit
    del.onclick = () => {
      removeUserDictEntry(key)
      renderDictEditor()
    }

    row.append(srcIn, trIn, del)
    listEl.appendChild(row)
  })
}

function wireDictEditor(): void {
  const searchEl = document.getElementById('am-dict-search')
  if (searchEl instanceof HTMLInputElement) searchEl.oninput = renderDictEditor
  renderDictEditor()

  const addBtn = document.getElementById('am-dict-add')
  const srcEl = document.getElementById('am-dict-src')
  const trEl = document.getElementById('am-dict-tr')

  if (addBtn && srcEl instanceof HTMLInputElement && trEl instanceof HTMLInputElement) {
    addBtn.onclick = () => {
      if (upsertUserDictEntry(srcEl.value, trEl.value)) {
        srcEl.value = ''
        trEl.value = ''
        srcEl.focus()
        renderDictEditor()
      }
    }
    trEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addBtn.click()
    })
  }

  const exportBtn = document.getElementById('am-dict-export')
  if (exportBtn) {
    exportBtn.onclick = () => {
      const blob = new Blob([JSON.stringify(getUserDict(), null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'animori-dictionary.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }
  }

  const copyBtn = document.getElementById('am-dict-copy')
  if (copyBtn) {
    copyBtn.onclick = () => {
      try {
        GM_setClipboard(JSON.stringify(getUserDict(), null, 2))
        const prev = copyBtn.textContent
        copyBtn.textContent = '✓ Скопировано'
        setTimeout(() => {
          copyBtn.textContent = prev
        }, 1400)
      } catch (e) {
        Logger('WARN', 'Не удалось скопировать словарь в буфер', e)
      }
    }
  }

  const importBtn = document.getElementById('am-dict-import')
  if (importBtn) importBtn.onclick = importDictFromFile

  const shareBtn = document.getElementById('am-dict-share')
  if (shareBtn) shareBtn.onclick = shareDict
}

function importDictFromFile(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'

  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed: unknown = JSON.parse(String(reader.result))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad')

        const incoming = parsed as Record<string, unknown>
        const userDict = getUserDict()
        let lastKey = ''
        let lastValue = ''

        Object.keys(incoming).forEach((k) => {
          const key = normDictKey(k)
          const value = normDictKey(String(incoming[k] ?? ''))
          if (!key || !value) return
          userDict[key] = value
          lastKey = key
          lastValue = value
        })

        setUserDict(userDict)
        // В монолите здесь вызывался глобальный amRetranslate(). Теперь он приватный,
        // поэтому повторно пишем одну запись через upsertUserDictEntry: он сам
        // пересобирает словарь и тригерит ре-перевод страницы.
        if (lastKey) upsertUserDictEntry(lastKey, lastValue)
        renderDictEditor()
      } catch {
        alert('Не удалось разобрать файл словаря (ожидается JSON вида {"English":"Русский"}).')
      }
    }
    reader.readAsText(file)
  }

  input.click()
}

function shareDict(): void {
  const userDict = getUserDict()
  const count = Object.keys(userDict).length
  if (!count) {
    alert('Пока нечем делиться — добавьте хотя бы одну запись.')
    return
  }

  const json = JSON.stringify(userDict, null, 2)
  const plural = count === 1 ? 'запись' : count < 5 ? 'записи' : 'записей'
  const title = `[Словарь] ${count} ${plural} от пользователя`
  const fence = '```'
  const body =
    'Предлагаю добавить эти переводы в общий словарь AniMori:\n\n' +
    fence +
    'json\n' +
    json +
    '\n' +
    fence +
    '\n'

  const url =
    ISSUES_NEW +
    '?title=' +
    encodeURIComponent(title) +
    '&labels=dictionary&body=' +
    encodeURIComponent(body)

  // Лимит URL GitHub (~8 КБ): большой словарь — JSON в буфер, форма открывается пустой.
  if (url.length > 7000) {
    try {
      GM_setClipboard(json)
    } catch (e) {
      Logger('WARN', 'Не удалось скопировать словарь в буфер', e)
    }
    const hint =
      'Словарь скопирован в буфер обмена — вставьте его сюда внутри блока ' +
      fence +
      'json ... ' +
      fence
    const short =
      ISSUES_NEW +
      '?title=' +
      encodeURIComponent(title) +
      '&labels=dictionary&body=' +
      encodeURIComponent(hint)
    alert(
      'Словарь большой и не помещается в ссылку — он скопирован в буфер обмена. Откроется форма issue, вставьте (Ctrl+V) содержимое в тело.',
    )
    window.open(short, '_blank', 'noopener')
    return
  }

  window.open(url, '_blank', 'noopener')
}

// ==== Авторизация AniList ====

function wireAniListAuth(): void {
  const tokenInput = document.getElementById('set_al_token')
  if (tokenInput instanceof HTMLInputElement) {
    tokenInput.value = GM_getValue<string>('AL_TOKEN', '')
    tokenInput.onchange = () => GM_setValue('AL_TOKEN', tokenInput.value.trim())
  }

  const genBtn = document.getElementById('set_al_gen')
  const clientInput = document.getElementById('set_al_client')
  const wrap = document.getElementById('set_al_link_wrap')
  if (!genBtn || !(clientInput instanceof HTMLInputElement) || !wrap) return

  genBtn.onclick = () => {
    const clientId = clientInput.value.trim()
    if (!clientId) {
      alert('Введите Client ID (его можно создать в настройках AniList -> Developer)')
      return
    }

    const link = document.createElement('a')
    // В монолите этот адрес собирался шаблонной строкой и получал лишние
    // фигурные скобки вокруг схемы, то есть ссылка авторизации в 1.9.1 вела в никуда.
    // Тот же класс багов, что чинил 1306f00; здесь — только конкатенация.
    link.href =
      AL_AUTHORIZE + '?client_id=' + encodeURIComponent(clientId) + '&response_type=token'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.style.cssText =
      'color:rgb(var(--color-blue)); text-decoration:none; font-weight:bold; display:block; padding:6px; border:1px dashed rgb(var(--color-blue)); border-radius:6px; margin-top:5px; transition: 0.2s;'
    link.textContent = '👉 Клик: Перейти к авторизации'

    wrap.textContent = ''
    wrap.appendChild(link)
  }
}

// ==== Вкладка «Поддержать» ====

function wireSupportTab(): void {
  const star = document.getElementById('am-sup-star')
  if (star) star.onclick = () => window.open(SUP_GITHUB, '_blank', 'noopener')

  const review = document.getElementById('am-sup-review')
  if (review) review.onclick = () => window.open(SUP_GREASY + '/feedback', '_blank', 'noopener')

  const copy = document.getElementById('am-sup-copy')
  if (copy) {
    copy.onclick = () => {
      amCopy(SUP_GREASY, copy)
      const label = copy.querySelector('span')
      if (!label) return
      const prev = label.textContent
      label.textContent = 'Скопировано ✓'
      setTimeout(() => {
        label.textContent = prev
      }, 1200)
    }
  }
}

// ==== Сборка ====

function togglePanel(): void {
  if (!panel) return
  panel.style.display = window.getComputedStyle(panel).display === 'none' ? 'flex' : 'none'
}

/**
 * Создаёт панель настроек и регистрирует кнопку ⚙.
 * Вызывать только после loadSettings(): вся разметка читает settings.
 */
export function initSettingsUI(): void {
  if (panel) return

  panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.classList.add('am-accent-scope')
  panel.innerHTML = buildPanelMarkup()
  document.body.appendChild(panel)

  wireTabs(panel)
  wireSupportTab()
  renderAccentChips()
  wireDomainSettings()
  wireTitleSources()
  wireBooleanSettings()
  wireCustomLinks()
  wireDictEditor()
  wireAniListAuth()

  // Закрытие: клик по оверлею или ✕.
  panel.addEventListener('click', (e) => {
    if (e.target === panel && panel) panel.style.display = 'none'
  })
  const closeBtn = document.getElementById('am-set-close')
  if (closeBtn) {
    closeBtn.onclick = () => {
      if (panel) panel.style.display = 'none'
    }
  }

  const applyBtn = document.getElementById('am-apply')
  if (applyBtn) applyBtn.onclick = () => location.reload()

  const clearBtn = document.getElementById('am-clear')
  if (clearBtn) {
    clearBtn.onclick = () => {
      void clearCache().then(() => {
        alert('Кэш сброшен!')
        location.reload()
      })
    }
  }

  registerActionButton({
    id: 'am-set-btn',
    label: '⚙',
    title: 'Настройки AniMori',
    order: ACTION_ORDER.settings,
    onClick: togglePanel,
  })
}
