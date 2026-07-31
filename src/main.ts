/** AniMori userscript entry point. */

import './style.scss'
import { fetchInterfaceDictionary } from './api/dictionary'
import { amSetAccent } from './core/accent'
import { IS_ANILIST, IS_SHIKI } from './core/constants'
import { loadCustomLinks } from './core/custom-links'
import { openDB, runGarbageCollector } from './core/db'
import { loadUserDict, rebuildDictionary, setRemoteDict } from './core/dictionary'
import { initLifecycle, registerRouteTask, registerShutdownTask } from './core/lifecycle'
import { loadSettings, settings } from './core/settings'
import { destroyAdblock, initAdblock } from './features/adblock'
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
import { sweepPhantomRoots, unmountAll, unmountPageScoped } from './utils/vue-mounter'

/**
 * Задержка перед запуском сборщика мусора кэша (строка 4653 монолита).
 * Смысл — не конкурировать с запросами и отрисовкой первой страницы.
 */
const GC_DELAY_MS = 15000

/**
 * П.2.9: вся привязка подсистем к SPA-навигации собрана в одном месте.
 *
 * Почему здесь, а не в core/lifecycle.ts: ядро сознательно не знает ни о виджетах,
 * ни о Vue, ни об адблоке — иначе core начал бы импортировать features и получился
 * круговой граф зависимостей.
 *
 * Порядок задач важен: сначала снимаем то, что привязано к ушедшей странице,
 * потом чистим фантомы, и только потом собираем новую страницу. Иначе уборка
 * снесла бы только что вставленные виджеты.
 */
function wireLifecycle(): void {
  // 1. Постраничные Vue-приложения (pageScoped: true) снимаются целиком.
  //    Панель действий и модалки сюда НЕ попадают: они живут в body всю сессию.
  registerRouteTask('vue:page-scoped', () => {
    const count = unmountPageScoped()
    if (count > 0) Logger('INFO', `[Router] Снято постраничных приложений: ${count}`)
  })

  // 2. Фантомы: узлы am-vue-root без живого приложения за ними. Остаются, когда React
  //    переносит кусок разметки вместе с нашим корнем вместо того, чтобы его удалить.
  registerRouteTask('vue:phantoms', () => {
    sweepPhantomRoots()
  })

  // 3. Медиа-страница: загрузка данных при смене тайтла и восстановление виджетов.
  registerRouteTask('media', refreshMediaPage)

  // Задачи разбора выполняются в обратном порядке. В браузере не вызываются никогда:
  // вкладку закрывают вместе с документом. Готовим их под Этап 3, где WebView Tauri
  // живёт дольше страницы.
  registerShutdownTask('vue:all', unmountAll)
  registerShutdownTask('adblock', destroyAdblock)

  initLifecycle()
}

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

  // Итерация 3.5.3: свои ссылки и правки словаря переехали в асинхронное хранилище,
  // но читаются синхронно во время отрисовки. Поэтому кэши наполняются здесь — до
  // первого построения виджетов и до rebuildDictionary(). Иначе на первой же странице
  // пропали бы пользовательские ссылки в блоке «Где посмотреть» и личные переводы.
  // Оба чтения независимы, поэтому идут параллельно и не тянут старт.
  await Promise.all([loadCustomLinks(), loadUserDict()])

  // П.2.10: адблок идёт ПЕРВЫМ среди всего, что касается страницы: его стиль должен
  // оказаться в документе раньше первой отрисовки баннера, иначе реклама успеет мигнуть
  // и вёрстка дёрнется. Функция сама проверяет settings.hideAds и при выключенной
  // настройке не делает ничего.
  //
  // П.2.9: адблок сознательно НЕ входит ни в реестр Vue-приложений, ни в задачи
  // смены роута. Его наблюдатель висит на documentElement и обязан переживать переходы:
  // если сносить его вместе с остальным, баннеры вернутся на первой же смене страницы.
  // destroyAdblock() вызывается только при полном разборе и при выключении тумблера.
  initAdblock()

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
  wireLifecycle()

  // Фоновая чистка устаревшего кэша. В порте функция была реализована, но ниоткуда
  // не вызывалась, из-за чего IndexedDB росла бесконечно.
  window.setTimeout(() => void runGarbageCollector(), GC_DELAY_MS)
}

void bootstrap()
