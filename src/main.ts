/** AniMori userscript entry point. */

import './style.scss'
import { fetchInterfaceDictionary } from './api/dictionary'
import { amSetAccent } from './core/accent'
import { IS_ANILIST, IS_SHIKI } from './core/constants'
import { openDB, runGarbageCollector } from './core/db'
import { rebuildDictionary, setRemoteDict } from './core/dictionary'
import { initLifecycle } from './core/lifecycle'
import { loadSettings, settings } from './core/settings'
import { initExporter } from './features/exporter'
import { initMedia, refreshMediaPage, registerMediaWidget } from './features/media'
import { extLinksWidget } from './features/media/extlinks'
import { franchiseWidget } from './features/media/franchise'
import { playerWidget } from './features/media/player'
import { ratingsWidget } from './features/media/ratings'
import { themesWidget } from './features/media/themes'
import { initScannerUI } from './features/scanner'
import { initSearch } from './features/search'
import { initTranslator } from './features/translator'
import { initActionBar } from './features/ui/actions'
import { initLoggerUI } from './features/ui/logger-ui'
import { initSettingsUI } from './features/ui/settings'
import { installGlobalErrorHandlers, Logger } from './utils/logger'

/**
 * Задержка перед запуском сборщика мусора кэша (строка 4653 монолита).
 * Смысл — не конкурировать с запросами и отрисовкой первой страницы.
 */
const GC_DELAY_MS = 15000

/**
 * Порядок важен и взят из init() монолита (строки 4210-4230, 4596-4655):
 * настройки → перехватчики ошибок → акцент → панель кнопок → БД → словарь →
 * переводчик → поиск → медиа-виджеты → SPA-обвязка → сборщик мусора.
 *
 * Важно: флаги перевода гасят только загрузку удалённого словаря. Сам переводчик
 * инициализируется всегда, потому что на его наблюдателе мутаций живут медиа-виджеты
 * (плеер, рейтинги, франшиза), которые от настроек перевода не зависят.
 *
 * РИСК №1 из AUDITION.md: на Этапе 3 настройки станут асинхронными, поэтому всё,
 * что читает settings, идёт строго после await loadSettings().
 */
async function bootstrap(): Promise<void> {
  await loadSettings()

  // Читает settings.enableLogger, поэтому только после loadSettings().
  installGlobalErrorHandlers()

  if (IS_SHIKI) {
    initExporter()
    return
  }
  if (!IS_ANILIST) return

  // Без этого вызова amAccentTriple остаётся null и сохранённый пресет
  // игнорируется: виджеты красятся синим AniList независимо от выбора.
  amSetAccent(settings.accentPreset)

  // П.2.6: каждая фича сама регистрирует свою кнопку внутри init*UI(), поэтому
  // точка входа больше не знает ни id кнопок, ни их обработчиков.
  // Все три вызова идут до initActionBar(), а порядок пилюль задаёт ACTION_ORDER,
  // а не очерёдность регистрации: ⚙, </>, ⇄ — как в монолите.
  // initLoggerUI() сам проверяет settings.enableLogger и при выключенном логгере
  // не добавляет ни кнопку, ни подписку на записи.
  initSettingsUI()
  initLoggerUI()
  initScannerUI()
  initActionBar()

  await openDB()

  const needTranslator =
    settings.translateInterface ||
    settings.translateTitles ||
    settings.translateCharacters ||
    settings.translateStaff

  if (needTranslator) {
    Logger('API', 'Загрузка словаря интерфейса...')
    const remoteDict = await fetchInterfaceDictionary()
    // setRemoteDict сам пересобирает итоговый словарь; при сбое загрузки
    // пересобираем вручную, чтобы правки пользователя всё равно применились.
    if (remoteDict) setRemoteDict(remoteDict)
    else rebuildDictionary()
  } else {
    rebuildDictionary()
  }

  initTranslator()

  // Русский поиск и захват выделения: оба вешают слушатели на body и не требуют
  // готовой разметки сайта, поэтому порядок относительно виджетов не важен.
  initSearch()

  // Медиа-виджеты живут на наблюдателе переводчика, поэтому регистрируются после него.
  // Порядок регистрации задаёт порядок монтирования блоков в сайдбаре.
  registerMediaWidget(playerWidget)
  registerMediaWidget(ratingsWidget)
  registerMediaWidget(franchiseWidget)
  registerMediaWidget(themesWidget)
  registerMediaWidget(extLinksWidget)
  initMedia()

  // SPA-обвязка ставится после initMedia(): первый проход по странице делает сам
  // медиа-модуль, а здесь подключаются только последующие смены адреса.
  // Без этого вызова виджеты появлялись только там, где React успевал пересобрать
  // разметку и срабатывал наблюдатель мутаций.
  initLifecycle(refreshMediaPage)

  // Фоновая чистка устаревшего кэша. В порте функция была реализована, но ниоткуда
  // не вызывалась, из-за чего IndexedDB росла бесконечно.
  window.setTimeout(() => void runGarbageCollector(), GC_DELAY_MS)
}

void bootstrap()
