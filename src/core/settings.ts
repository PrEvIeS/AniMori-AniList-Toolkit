// Пункт 1.3 плана: пользовательские настройки (строки 68-93 монолита).
//
// Пункт 3.5: хранилище больше не GM_*, а Bridge.storage. Этим закрыт РИСК №1
// из AUDITION.md: чтение стало асинхронным ровно в одном модуле, а не во всех
// потребителях настроек.
//
// Главное правило для всех остальных модулей не изменилось: читать `settings.x`
// в момент использования, а не копировать значения в свои константы и тем более
// не читать их на верхнем уровне модуля. До `await loadSettings()` в `settings`
// лежат дефолты, а не сохранённые значения: bootstrap() ждёт загрузку ДО запуска
// наблюдателя мутаций и рендера UI.
//
// Логгер здесь недоступен: `utils/logger` сам читает этот модуль, и импорт дал бы цикл.
// Диагностика сбоев хранилища идёт в `console`, как и внутри самого моста.

import { Bridge } from '@/bridge'

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
   * По умолчанию ВКЛЮЧЕНО (было выключено до этой правки). Причина смены: в панели
   * настроек этот ключ и hideAds пишет ОДИН тумблер «Блокировщик рекламы»
   * (settings-state.ts). При разных дефолтах свежая установка показывала бы тумблер
   * включённым, а попапы при этом не блокировались бы до первого переключения
   * туда-сюда. Для юзерскрипта смена дефолта ничего не меняет: потребителя у ключа
   * там по-прежнему нет.
   */
  blockPlayerPopups: boolean
  /**
   * Пункт 2.10 плана: резать рекламные блоки самого AniList.
   *
   * В отличие от blockPlayerPopups, этот ключ работает ВЕЗДЕ уже сейчас: баннеры
   * AniList живут в главном фрейме на том же домене, где выполняется скрипт,
   * поэтому их видит обычный модуль (src/features/adblock).
   *
   * По умолчанию включено: пустой рекламный слот — не потеря функциональности,
   * а вот дыры в вёрстке и лишние iframe пользователю не нужны.
   */
  hideAds: boolean
  /**
   * Пункт 3.7.2: показывать ли пилюлю «Перенос» в панели действий.
   *
   * Скрывается только кнопка, а не сам модуль: окно переноса остаётся
   * смонтированным и доступным программно, а сетевой слой к панели не привязан.
   * Смысл ключа чисто интерфейсный — перенос списков делают один раз, а место
   * в пилюле занято постоянно.
   *
   * По умолчанию включено: скрывать функциональность за настройкой, о которой
   * пользователь не знает, — верный способ сделать её ненайденной.
   */
  showSyncButton: boolean
  /**
   * Пункт 3.7.2: показывать ли пилюлю ⇄ (сравнение списков) в панели действий.
   *
   * Отдельный ключ, а не общий с переносом: у кнопок разная частота
   * использования, и объединение заставило бы прятать обе ради одной.
   */
  showCompareButton: boolean
  /** Производная: тайтлы включены, пока основной источник != 'off'. */
  translateTitles: boolean
}

/**
 * Значения по умолчанию — то, что видит пользователь при первом запуске.
 *
 * Вынесены в отдельную константу, потому что нужны дважды: как стартовое
 * состояние `settings` до завершения loadSettings() и как дефолты самого чтения.
 *
 * Важно про область действия: это ЗНАЧЕНИЯ НА СЛУЧАЙ ОТСУТСТВИЯ КЛЮЧА в хранилище,
 * а не «сброс к заводским». У того, кто уже трогал настройку, лежит своё значение,
 * и оно перебьёт любой дефолт отсюда. Переключать чужие сохранённые настройки
 * обновлением скрипта мы сознательно не будем.
 *
 * Источники названий: основной — anime365, фоллбэк — Shikimori. У anime365 переводы
 * названий ближе к тому, что ожидает русскоязычный зритель, но база уже неполная:
 * манга там не покрыта вообще (api/anime365.ts отвечает null на MANGA), и часть
 * тайтлов без русского названия. Именно поэтому фоллбэк теперь не 'none',
 * а Shikimori: без него на таких страницах оставалось бы английское название
 * без всякого объяснения, и выглядело бы это как поломка перевода.
 */
const DEFAULT_SETTINGS: AniMoriSettings = {
  translateInterface: true,
  titlePrimary: 'anime365',
  titleFallback: 'shikimori',
  translateCharacters: true,
  translateStaff: true,
  enablePlayer: true,
  enableRatings: true,
  enableFranchise: true,
  enableThemes: true,
  enableExtLinks: true,
  enableLinkRutracker: true,
  enableLinkYummy: true,
  enableLinkAnimego: true,
  enableLinkMangalib: true,
  yummyDomain: 'yummyanime.tv',
  animegoDomain: 'animego.org',
  mangalibDomain: 'mangalib.me',
  enableLogger: true,
  accentPreset: 'site',
  blockPlayerPopups: true,
  hideAds: true,
  showSyncButton: true,
  showCompareButton: true,
  translateTitles: true,
}

async function readSettings(): Promise<AniMoriSettings> {
  const storage = Bridge.storage

  // Все ключи читаются одним залпом. В браузере разницы нет — GM_getValue отвечает
  // сразу, — а в Tauri последовательный await превратился бы в два десятка
  // последовательных вызовов через IPC на старте приложения.
  const [
    translateInterface,
    storedTitlePrimary,
    legacyTitles,
    titleFallback,
    translateCharacters,
    translateStaff,
    enablePlayer,
    enableRatings,
    enableFranchise,
    enableThemes,
    enableExtLinks,
    enableLinkRutracker,
    enableLinkYummy,
    enableLinkAnimego,
    enableLinkMangalib,
    yummyDomain,
    animegoDomain,
    mangalibDomain,
    enableLogger,
    accentPreset,
    blockPlayerPopups,
    hideAds,
    showSyncButton,
    showCompareButton,
  ] = await Promise.all([
    storage.get('set_interface', DEFAULT_SETTINGS.translateInterface),
    storage.get<TitleSource>('set_title_primary'),
    storage.get('set_titles', true),
    storage.get<TitleSource>('set_title_fallback', DEFAULT_SETTINGS.titleFallback),
    storage.get('set_chars', DEFAULT_SETTINGS.translateCharacters),
    storage.get('set_staff', DEFAULT_SETTINGS.translateStaff),
    storage.get('set_player', DEFAULT_SETTINGS.enablePlayer),
    storage.get('set_ratings', DEFAULT_SETTINGS.enableRatings),
    storage.get('set_franchise', DEFAULT_SETTINGS.enableFranchise),
    storage.get('set_themes', DEFAULT_SETTINGS.enableThemes),
    storage.get('set_extlinks', DEFAULT_SETTINGS.enableExtLinks),
    storage.get('set_link_rutracker', DEFAULT_SETTINGS.enableLinkRutracker),
    storage.get('set_link_yummy', DEFAULT_SETTINGS.enableLinkYummy),
    storage.get('set_link_animego', DEFAULT_SETTINGS.enableLinkAnimego),
    storage.get('set_link_mangalib', DEFAULT_SETTINGS.enableLinkMangalib),
    storage.get('set_yummy_domain', DEFAULT_SETTINGS.yummyDomain),
    storage.get('set_animego_domain', DEFAULT_SETTINGS.animegoDomain),
    storage.get('set_mangalib_domain', DEFAULT_SETTINGS.mangalibDomain),
    storage.get('set_logger', DEFAULT_SETTINGS.enableLogger),
    storage.get<AccentPreset>('am_accent', DEFAULT_SETTINGS.accentPreset),
    storage.get('set_block_popups', DEFAULT_SETTINGS.blockPlayerPopups),
    storage.get('set_hide_ads', DEFAULT_SETTINGS.hideAds),
    storage.get('set_btn_sync', DEFAULT_SETTINGS.showSyncButton),
    storage.get('set_btn_compare', DEFAULT_SETTINGS.showCompareButton),
  ])

  // Обратная совместимость: старый ключ set_titles -> новый set_title_primary.
  // Раньше старый ключ стоял вторым аргументом вложенного GM_getValue; теперь
  // читаются оба, и старый применяется только при отсутствии нового — поведение
  // то же самое, ценой одного лишнего чтения.
  //
  // Здесь НЕЛЬЗЯ писать 'shikimori' литералом, как было раньше: старый ключ
  // set_titles есть почти у всех, кто когда-либо заходил в настройки старой версии,
  // и жёсткий литерал сделал бы новый дефолт недостижимым: источником молча
  // оставался бы Shikimori.
  const titlePrimary = storedTitlePrimary ?? (legacyTitles ? DEFAULT_SETTINGS.titlePrimary : 'off')

  return {
    translateInterface,
    titlePrimary,
    titleFallback,
    translateCharacters,
    translateStaff,
    enablePlayer,
    enableRatings,
    enableFranchise,
    enableThemes,
    enableExtLinks,
    enableLinkRutracker,
    enableLinkYummy,
    enableLinkAnimego,
    enableLinkMangalib,
    yummyDomain,
    animegoDomain,
    mangalibDomain,
    enableLogger,
    accentPreset,
    blockPlayerPopups,
    hideAds,
    showSyncButton,
    showCompareButton,
    translateTitles: titlePrimary !== 'off',
  }
}

/**
 * Единственный экземпляр настроек. Мутируется на месте, ссылка не меняется —
 * на этом держатся все потребители и реактивные модели панели настроек.
 *
 * До завершения loadSettings() здесь дефолты. Читать настройки на верхнем уровне
 * своего модуля нельзя: импорты выполняются до bootstrap(), и такой код увидит
 * значение по умолчанию вместо сохранённого.
 */
export const settings: AniMoriSettings = { ...DEFAULT_SETTINGS }

/** Перечитать настройки из хранилища (вызывается из bootstrap()). */
export async function loadSettings(): Promise<AniMoriSettings> {
  try {
    Object.assign(settings, await readSettings())
  } catch (e) {
    // Хранилище недоступно — работаем на дефолтах. Падать целиком хуже:
    // без настроек скрипт всё ещё полезен, без bootstrap() — уже нет.
    console.error('[AniMori] Не удалось прочитать настройки, используются значения по умолчанию', e)
  }
  return settings
}

/**
 * Записать одну настройку и сразу обновить производные значения.
 *
 * Память обновляется ДО записи в хранилище: интерфейс обязан отреагировать на клик
 * мгновенно, как и раньше с синхронным GM_setValue. Сбой записи не откатывает
 * значение в памяти: пользователь продолжает работать в выбранном режиме до конца
 * сессии, просто выбор не переживёт перезагрузку.
 *
 * Функция стала асинхронной, но сознательно НЕ отклоняется: вызывают её из setter’ов
 * реактивных моделей, где дождаться результата негде, а непойманный reject всплыл бы
 * глобальным unhandledrejection.
 */
export async function saveSetting<K extends keyof AniMoriSettings>(
  key: K,
  storageKey: string,
  value: AniMoriSettings[K],
): Promise<void> {
  settings[key] = value
  settings.translateTitles = settings.titlePrimary !== 'off'

  try {
    await Bridge.storage.set(storageKey, value)
  } catch (e) {
    console.error('[AniMori] Не удалось сохранить настройку ' + storageKey, e)
  }
}
