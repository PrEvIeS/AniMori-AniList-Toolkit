// Пункт 2.2 плана: реактивное состояние панели настроек #am-panel.
//
// Разделение обязанностей: здесь состояние и запись в хранилище, разметка — в
// SettingsModal.vue. Компонент не обращается к хранилищу за настройками напрямую
// (РИСК №1 из AUDITION.md): всё идёт через saveSetting() из core/settings.ts.
//
// Пункт 3.5.3: прямых обращений к GM_* здесь больше нет.
//   • токен AniList читается и пишется через api/anilist.ts, где лежит его кэш.
//     Своей копии токена панель не держит: иначе после сохранения нового токена
//     запросы продолжили бы уходить со старым до перезагрузки страницы.
//   • копирование словаря идёт через amCopy(): там уже есть и мост, и запасной
//     браузерный путь, и запись в лог при отказе — дублировать эту логику нечего.
//     Сигнатура осталась синхронной, чтобы не менять обработчики клика в компоненте.
//   • свои ссылки и локальный словарь уже живут в core/custom-links и core/dictionary
//     со своими кэшами — здесь их геттеры по-прежнему синхронные.
//
// Косметическая уборка (2 августа): прямых window.open здесь больше нет — внешние
// адреса уходят через Bridge.shell.openExternal(). В браузере это та же новая вкладка,
// в десктопной сборке — системный браузер, но теперь без участия глобального патча
// из features/ui/links.ts и с записью в журнал при отказе.

import { computed, ref } from 'vue'
import type { WritableComputedRef } from 'vue'

import { Bridge } from '@/bridge'
import { getStoredAlToken, setAlToken } from '../../api/anilist'
import { AM_ACCENTS, amSetAccent } from '../../core/accent'
import { CL_COLORS, getCustomLinks, setCustomLinks } from '../../core/custom-links'
import type { CustomLink } from '../../core/custom-links'
import {
  getUserDict,
  normDictKey,
  removeUserDictEntry,
  setUserDict,
  upsertUserDictEntry,
} from '../../core/dictionary'
import { saveSetting, settings } from '../../core/settings'
import type { AccentPreset, AniMoriSettings, TitleSource } from '../../core/settings'
import { syncAdblock } from '@adblock-impl'
import { amCopy } from '../../utils/dom'
import { Logger } from '../../utils/logger'

// ==== Адреса: только конкатенацией, никогда шаблонной строкой ====

const HTTPS = 'https://'
export const SUP_GITHUB = HTTPS + 'github.com/foulnike/AniMori-AniList-Toolkit'
export const SUP_GREASY = HTTPS + 'greasyfork.org/scripts/572948'
export const SUP_GREASY_FEEDBACK = SUP_GREASY + '/feedback'
export const ISSUES_NEW = SUP_GITHUB + '/issues/new'
export const AL_DEV_SETTINGS = HTTPS + 'anilist.co/settings/developer'
export const AL_PIN_REDIRECT = HTTPS + 'anilist.co/api/v2/oauth/pin'
export const AL_AUTHORIZE = HTTPS + 'anilist.co/api/v2/oauth/authorize'
export const CUSTOM_URL_EXAMPLE = HTTPS + 'site.com/search?q={query}'

/**
 * Единая точка открытия внешних адресов из панели настроек.
 *
 * Мост сам выбирает путь: в юзерскрипте — новая вкладка браузера, в десктопной
 * сборке — системный браузер. Отказ пишется в журнал: молчаливо не открывшаяся
 * ссылка уже однажды была дефектом без единого следа в логах.
 */
function openExternal(url: string): void {
  void Bridge.shell.openExternal(url).catch((e: unknown) => {
    Logger('ERROR', 'Не удалось открыть ссылку: ' + url, e)
  })
}

// ==== Видимость панели и активная вкладка ====

export type TabKey =
  | 'translate'
  | 'dict'
  | 'modules'
  | 'appearance'
  | 'links'
  | 'account'
  | 'misc'
  | 'support'

export const isSettingsOpen = ref(false)
export const activeTab = ref<TabKey>('translate')

export function openSettings(): void {
  isSettingsOpen.value = true
}

export function closeSettings(): void {
  isSettingsOpen.value = false
}

export function toggleSettings(): void {
  isSettingsOpen.value = !isSettingsOpen.value
}

// ==== Мост между reactive-моделями и core/settings ====

/**
 * Версия настроек: `settings` — обычный объект, а не reactive(), поэтому computed
 * не увидит мутацию сам. Каждая запись через saveSetting() бампает счётчик, и все
 * модели пересчитываются. Так `settings` остаётся единственным источником правды.
 */
const settingsVersion = ref(0)

function settingRef<K extends keyof AniMoriSettings>(
  key: K,
  storageKey: string,
): WritableComputedRef<AniMoriSettings[K]> {
  return computed({
    get: () => {
      void settingsVersion.value
      return settings[key]
    },
    set: (value) => {
      saveSetting(key, storageKey, value)
      settingsVersion.value++
    },
  })
}

// ==== Вкладка «Перевод» ====

export const translateInterface = settingRef('translateInterface', 'set_interface')
export const translateCharacters = settingRef('translateCharacters', 'set_chars')
export const translateStaff = settingRef('translateStaff', 'set_staff')
export const titlePrimary = settingRef('titlePrimary', 'set_title_primary')
export const titleFallback = settingRef('titleFallback', 'set_title_fallback')

/** Фоллбэк недоступен, пока основной источник выключен. */
export const fallbackDisabled = computed(() => titlePrimary.value === 'off')

/** Фоллбэк не может совпадать с основным источником. */
export function isFallbackOptionDisabled(value: TitleSource): boolean {
  return value !== 'none' && value === titlePrimary.value
}

/**
 * Приводит пару источников к валидному состоянию — то же правило, что делал sync()
 * в императивной версии: выключенный основной или совпадение сбрасывают фоллбэк.
 */
export function syncTitleSources(): void {
  const invalid = titlePrimary.value === 'off' || titleFallback.value === titlePrimary.value
  if (invalid && titleFallback.value !== 'none') titleFallback.value = 'none'
}

// ==== Вкладка «Модули» ====

export const enablePlayer = settingRef('enablePlayer', 'set_player')
export const enableRatings = settingRef('enableRatings', 'set_ratings')
export const enableFranchise = settingRef('enableFranchise', 'set_franchise')
export const enableThemes = settingRef('enableThemes', 'set_themes')

/**
 * Есть ли в этой сборке блокировщик рекламы.
 *
 * Правка 2 августа: в юзерскрипте блокировщика больше нет. Причина не техническая,
 * а продуктовая: расширение браузера режет и баннеры сайта, и рекламу внутри кадра
 * плеера, то есть покрывает обе половины нашего тумблера, а не одну, и не ломается
 * при каждой пересборке вёрстки AniList. В десктопной оболочке расширений нет —
 * там блокировщик остаётся единственным способом и работает целиком.
 *
 * Флаг читает разметка панели: в браузере вместо тумблера показывается пояснение.
 * Значение константно на всю сессию, поэтому не ref и не computed.
 */
export const isAdblockAvailable = Bridge.platform === 'tauri'

/**
 * Пункт 2.10 плана: единственный тумблер блокировщика рекламы (десктоп).
 *
 * Осознанно сведён в один переключатель «на всё». Пользователю не нужно знать,
 * что баннеры сайта режет DOM-модуль, а рекламу внутри плеера — сетевой блокировщик
 * уровня движка в оболочке Tauri: это одна и та же кнопка «блокировать рекламу».
 * Поэтому запись идёт сразу в два ключа: set_hide_ads читает наш модуль,
 * set_block_popups читает десктопный мост.
 *
 * Правка 2 августа: вторая запись стала условной. В браузере потребителя
 * у set_block_popups нет и быть не может, а сама модель туда больше не показывается;
 * писать ключ было бы мусором в хранилище.
 *
 * В отличие от остальных моделей, здесь есть немедленный потребитель, поэтому
 * после записи дёргаем syncAdblock(): включил — стиль и наблюдатель поднялись,
 * выключил — снялись. Перезагрузка нужна только чтобы увидеть баннеры обратно:
 * выпотрошенные слоты мы не восстанавливаем. В юзерскриптной сборке syncAdblock —
 * заглушка из impl.noop.ts.
 */
export const hideAds = computed<boolean>({
  get: () => {
    void settingsVersion.value
    return settings.hideAds
  },
  set: (value) => {
    saveSetting('hideAds', 'set_hide_ads', value)
    if (isAdblockAvailable) saveSetting('blockPlayerPopups', 'set_block_popups', value)
    settingsVersion.value++
    syncAdblock()
  },
})

// ==== Вкладка «Ссылки» ====

export const enableExtLinks = settingRef('enableExtLinks', 'set_extlinks')
export const enableLinkRutracker = settingRef('enableLinkRutracker', 'set_link_rutracker')
export const enableLinkYummy = settingRef('enableLinkYummy', 'set_link_yummy')
export const enableLinkAnimego = settingRef('enableLinkAnimego', 'set_link_animego')
export const enableLinkMangalib = settingRef('enableLinkMangalib', 'set_link_mangalib')
export const yummyDomain = settingRef('yummyDomain', 'set_yummy_domain')
export const animegoDomain = settingRef('animegoDomain', 'set_animego_domain')
export const mangalibDomain = settingRef('mangalibDomain', 'set_mangalib_domain')

/** Схема и хвостовой слэш отрезаются, как в wireDomainSettings(). */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
}

// ==== Вкладка «Прочее» ====

export const enableLogger = settingRef('enableLogger', 'set_logger')

/**
 * Пункт 3.7.2: видимость кнопок переноса и сравнения в панели действий.
 *
 * Обычные settingRef, но у них есть второй потребитель кроме окна настроек: ссылка
 * на эти модели уходит в поле visible при регистрации кнопки (features/scanner
 * и features/exporter). Передаётся именно ссылка, а не значение: кнопки регистрируются
 * один раз на старте, а тумблер должен срабатывать сразу, без перезагрузки.
 *
 * Поэтому же зависимость односторонняя: модели живут здесь, а фичи их читают.
 * Обратного импорта (settings-state → scanner/exporter) быть не должно — это цикл.
 */
export const showSyncButton = settingRef('showSyncButton', 'set_btn_sync')
export const showCompareButton = settingRef('showCompareButton', 'set_btn_compare')

// ==== Вкладка «Оформление» ====

export const accentPreset = settingRef('accentPreset', 'am_accent')
export const ACCENT_KEYS = Object.keys(AM_ACCENTS) as AccentPreset[]

export function selectAccent(key: AccentPreset): void {
  accentPreset.value = key
  amSetAccent(key)
}

// ==== Свои ссылки ====

export const customLinks = ref<CustomLink[]>([])

export function reloadCustomLinks(): void {
  customLinks.value = getCustomLinks()
}

/** В хранилище кладём чистые объекты, а не reactive-прокси. */
export function persistCustomLinks(): void {
  setCustomLinks(
    customLinks.value.map((link) => ({
      name: link.name.trim(),
      url: link.url.trim(),
      color: link.color,
    })),
  )
}

export function addCustomLink(): void {
  const palette = CL_COLORS[customLinks.value.length % CL_COLORS.length]
  customLinks.value.push({ name: '', url: '', color: palette ?? CL_COLORS[0] ?? '61,180,242' })
  persistCustomLinks()
}

export function removeCustomLink(index: number): void {
  if (index < 0 || index >= customLinks.value.length) return
  customLinks.value.splice(index, 1)
  persistCustomLinks()
}

export function setCustomLinkColor(index: number, color: string): void {
  const link = customLinks.value[index]
  if (!link) return
  link.color = color
  persistCustomLinks()
}

// ==== Локальный словарь ====

export interface DictEntry {
  key: string
  value: string
}

/** Геттер словаря синхронный и внешний — пинаем computed вручную после записи. */
const dictVersion = ref(0)

export const dictSearch = ref('')
export const dictSrcDraft = ref('')
export const dictTrDraft = ref('')

export function refreshDict(): void {
  dictVersion.value++
}

export const dictEntries = computed<DictEntry[]>(() => {
  void dictVersion.value
  const userDict = getUserDict()
  return Object.keys(userDict)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((key) => ({ key, value: userDict[key] ?? '' }))
})

export const dictTotal = computed(() => dictEntries.value.length)

export const filteredDictEntries = computed<DictEntry[]>(() => {
  const query = normDictKey(dictSearch.value).toLowerCase()
  if (!query) return dictEntries.value
  return dictEntries.value.filter(
    (entry) =>
      entry.key.toLowerCase().includes(query) || entry.value.toLowerCase().includes(query),
  )
})

/** Добавляет запись из полей ввода. Возвращает false, если поля пустые. */
export function addDictDraft(): boolean {
  if (!upsertUserDictEntry(dictSrcDraft.value, dictTrDraft.value)) return false
  dictSrcDraft.value = ''
  dictTrDraft.value = ''
  refreshDict()
  return true
}

/** Правка существующей записи: переименование ключа удаляет старый. */
export function commitDictEntry(oldKey: string, source: string, translation: string): void {
  const newKey = normDictKey(source)
  const newValue = normDictKey(translation)
  if (!newKey || !newValue) return
  if (newKey !== oldKey) removeUserDictEntry(oldKey)
  upsertUserDictEntry(newKey, newValue)
  refreshDict()
}

export function deleteDictEntry(key: string): void {
  removeUserDictEntry(key)
  refreshDict()
}

export function exportDict(): void {
  const blob = new Blob([JSON.stringify(getUserDict(), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'animori-dictionary.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/**
 * Копирует весь локальный словарь в буфер обмена.
 *
 * amCopy() сам выбирает путь (мост, затем браузерный API) и пишет в лог при
 * отказе. Возвращаемое значение говорит лишь о том, что копирование удалось
 * запустить — так было и до переезда на мост.
 */
export function copyDictToClipboard(): boolean {
  try {
    amCopy(JSON.stringify(getUserDict(), null, 2))
    return true
  } catch (e) {
    Logger('WARN', 'Не удалось скопировать словарь в буфер', e)
    return false
  }
}

export function importDictFromFile(): void {
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
        // Как и в императивной версии: повторная запись одной пары через
        // upsertUserDictEntry пересобирает словарь и тригерит ре-перевод страницы.
        if (lastKey) upsertUserDictEntry(lastKey, lastValue)
        refreshDict()
      } catch {
        alert('Не удалось разобрать файл словаря (ожидается JSON вида {"English":"Русский"}).')
      }
    }
    reader.readAsText(file)
  }

  input.click()
}

export function shareDict(): void {
  const userDict = getUserDict()
  const count = Object.keys(userDict).length
  if (!count) {
    alert('Пока нечем делиться — добавьте хотя бы одну запись.')
    return
  }

  const json = JSON.stringify(userDict, null, 2)
  const plural = count === 1 ? 'запись' : count < 5 ? 'записи' : 'записей'
  const title = '[Словарь] ' + String(count) + ' ' + plural + ' от пользователя'
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
    copyDictToClipboard()
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
    openExternal(short)
    return
  }

  openExternal(url)
}

// ==== Авторизация AniList ====
//
// AL_TOKEN не входит в AniMoriSettings и живёт в api/anilist.ts вместе со своим кэшем.
// Здесь только поле ввода. Показываем именно сохранённый токен (getStoredAlToken),
// а не тот, что getAlToken() может подсмотреть в Vuex сайта: иначе в поле молча
// появлялся бы чужой сессионный токен, который пользователь туда не вводил.

export const alToken = ref('')
export const alClientId = ref('')
export const alAuthLink = ref('')

export function loadAuthState(): void {
  alToken.value = getStoredAlToken()
}

export function saveAlToken(): void {
  setAlToken(alToken.value.trim())
}

/** Собирает ссылку авторизации. Возвращает false, если Client ID пуст. */
export function generateAuthLink(): boolean {
  const clientId = alClientId.value.trim()
  if (!clientId) {
    alAuthLink.value = ''
    return false
  }
  // В монолите адрес собирался шаблонной строкой и получал лишние фигурные скобки,
  // то есть ссылка вела в никуда. Здесь — только конкатенация.
  alAuthLink.value = AL_AUTHORIZE + '?client_id=' + encodeURIComponent(clientId) + '&response_type=token'
  return true
}
