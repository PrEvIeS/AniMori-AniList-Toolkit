// Пункт 1.3 плана: пользовательские настройки (строки 68-93 монолита).
//
// РИСК №1 из AUDITION.md: сейчас значения читаются синхронно через GM_getValue прямо
// при импорте модуля. На этапе 3 (TauriBridge, plugin-store) чтение станет асинхронным,
// поэтому инициализация вынесена в loadSettings() — bootstrap() обязан дождаться её
// ДО запуска MutationObserver и рендера UI. Импортирующие модули должны читать
// `settings.x` в момент использования, а не копировать значения в свои константы.

export type TitleSource = 'shikimori' | 'anime365' | 'off' | 'none'
export type AccentPreset = 'site' | 'sakura' | 'mono' | 'catppuccin'

export interface AniMoriSettings {
  translateInterface: boolean
  titlePrimary: TitleSource
  titleFallback: TitleSource
  translateCharacters: boolean
  translateStaff: boolean
  enablePlayer: boolean
  enableRatings: boolean
  enableFranchise: boolean
  enableThemes: boolean
  enableExtLinks: boolean
  enableLinkRutracker: boolean
  enableLinkYummy: boolean
  enableLinkAnimego: boolean
  enableLinkMangalib: boolean
  yummyDomain: string
  animegoDomain: string
  mangalibDomain: string
  enableLogger: boolean
  accentPreset: AccentPreset
  /**
   * Пункт 2.8 плана: блокировать всплывающие окна, которые открывает плеер.
   *
   * В юзерскрипте потребителя нет и быть не может: браузер сам решает судьбу
   * window.open из чужого iframe, а Kodik крутится в кросс-доменном фрейме —
   * дотянуться до него скриптом нельзя. Настройка заработает на пункте 4.7,
   * когда в Tauri появится обработчик on_new_window: он перехватывает запрос
   * на создание окна из любого фрейма, включая рекламные прероллы Kodik.
   *
   * Оговорка на будущее: on_new_window ловит только НОВЫЕ окна и вкладки.
   * Реклама, которая уводит текущий фрейм редиректом, и оверлеи, отрисованные
   * внутри самого плеера, этим ключом не отсекаются — под них на 4.7 нужен
   * отдельный фильтр навигации.
   *
   * По умолчанию выключено: поведение до Этапа 4 не меняется, а пользователь
   * сознательно включает то, что заработает только в десктопной сборке.
   */
  blockPlayerPopups: boolean
  /** Производная: тайтлы включены, пока основной источник != 'off'. */
  translateTitles: boolean
}

function readSettings(): AniMoriSettings {
  // Обратная совместимость: старый ключ set_titles -> новый set_title_primary.
  const titlePrimary = GM_getValue<TitleSource>(
    'set_title_primary',
    GM_getValue('set_titles', true) ? 'shikimori' : 'off',
  )

  return {
    translateInterface: GM_getValue('set_interface', true),
    titlePrimary,
    titleFallback: GM_getValue<TitleSource>('set_title_fallback', 'none'),
    translateCharacters: GM_getValue('set_chars', true),
    translateStaff: GM_getValue('set_staff', true),
    enablePlayer: GM_getValue('set_player', true),
    enableRatings: GM_getValue('set_ratings', true),
    enableFranchise: GM_getValue('set_franchise', true),
    enableThemes: GM_getValue('set_themes', true),
    enableExtLinks: GM_getValue('set_extlinks', true),
    enableLinkRutracker: GM_getValue('set_link_rutracker', true),
    enableLinkYummy: GM_getValue('set_link_yummy', true),
    enableLinkAnimego: GM_getValue('set_link_animego', true),
    enableLinkMangalib: GM_getValue('set_link_mangalib', true),
    yummyDomain: GM_getValue('set_yummy_domain', 'yummyanime.tv'),
    animegoDomain: GM_getValue('set_animego_domain', 'animego.org'),
    mangalibDomain: GM_getValue('set_mangalib_domain', 'mangalib.me'),
    enableLogger: GM_getValue('set_logger', true),
    accentPreset: GM_getValue<AccentPreset>('am_accent', 'site'),
    blockPlayerPopups: GM_getValue('set_block_popups', false),
    translateTitles: titlePrimary !== 'off',
  }
}

/**
 * Единственный экземпляр настроек. Мутируется на месте, ссылка не меняется —
 * на этапе 2 этот объект станет `reactive()` для v-model в SettingsModal.vue.
 */
export const settings: AniMoriSettings = readSettings()

/** Перечитать настройки из хранилища (вызывается из bootstrap()). */
export async function loadSettings(): Promise<AniMoriSettings> {
  Object.assign(settings, readSettings())
  return settings
}

/** Записать одну настройку и сразу обновить производные значения. */
export function saveSetting<K extends keyof AniMoriSettings>(
  key: K,
  storageKey: string,
  value: AniMoriSettings[K],
): void {
  settings[key] = value
  GM_setValue(storageKey, value)
  settings.translateTitles = settings.titlePrimary !== 'off'
}
