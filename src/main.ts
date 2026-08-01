/** AniMori userscript entry point. */

import './style.scss'
import { loadInterfaceDictionary } from './api/dictionary'
import { loadAlToken } from './api/anilist'
import { amSetAccent } from './core/accent'
import { IS_ANILIST, IS_SHIKI } from './core/constants'
import { loadCustomLinks } from './core/custom-links'
import { openDB, runGarbageCollector } from './core/db'
import { loadUserDict, rebuildDictionary, setRemoteDict } from './core/dictionary'
import { initLifecycle, registerRouteTask, registerShutdownTask } from './core/lifecycle'
import { loadSettings, settings } from './core/settings'
import { destroyAdblock, initAdblock } from './features/adblock'
import { destroyNetProbe, initNetProbe } from './features/adblock/net-probe'
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
import { initLinks } from './features/ui/links'
import { initLoggerUI } from './features/ui/logger-ui'
import { initNavPanel } from './features/ui/nav'
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
  // Временная разведка к 4.7 — снимается вместе со всем остальным.
  registerShutdownTask('net-probe', destroyNetProbe)

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

  // Пункт 4.5: перехват ссылок в десктопной сборке. Ставится рано и до проверок
  // домена: ссылки есть на любой странице, куда бы окно ни зашло, а без обработчика
  // клики по ним просто исчезают. Сама функция проверяет платформу и в браузере
  // не делает ничего.
  initLinks()

  // Итерация 3.5.3: токен AniList теперь лежит в асинхронном хранилище, а берётся
  // синхронно при сборке заголовков запроса. Токен нужен сравнению списков, переносу
  // и панели настроек. Без этого первый авторизованный запрос ушёл бы анонимным, а в
  // поле токена пользователь увидел бы пустоту вместо сохранённого значения.
  await loadAlToken()

  // Итерация 3.7: на доменах Shikimori AniMori больше не рисует ничего. Раньше здесь
  // поднимался экспортер, но десктопная оболочка показывает только anilist.co, и точка
  // входа на чужом домене там недостижима. После 3.6 списки читаются через мост с любого
  // домена, поэтому перенос переехал в панель действий AniList — одинаково в обеих сборках.
  //
  // Итерация 1 августа: в шапке юзерскрипта остался только @match на anilist.co, но эта
  // проверка НЕ лишняя и удалять её нельзя. У пользователя со старой установленной версией
  // шапка обновится лишь после переустановки скрипта из GreasyFork, и до тех пор точка
  // входа продолжит стартовать на shikimori.io. Без явного выхода там поднялась бы вся
  // остальная обвязка AniList.
  if (IS_SHIKI) return
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

  // Временная разведка к пункту 4.7: приёмник сводки о том, куда ходят вложенные
  // фреймы (прежде всего кадр плеера). Ставится сразу за адблоком и до любого UI:
  // первое сообщение из чужого кадра может прийти в любой момент, а повторять его
  // некому. В браузерной сборке слушатель просто молчит.
  initNetProbe()

  // Без этого вызова amAccentTriple остаётся null и сохранённый пресет
  // игнорируется: виджеты красятся синим AniList независимо от выбора.
  amSetAccent(settings.accentPreset)

  // П.2.6: каждая фича сама регистрирует свою кнопку внутри init*(), поэтому
  // точка входа больше не знает ни id кнопок, ни их обработчиков.
  // Все вызовы идут до initActionBar(), а порядок пилюль задаёт ACTION_ORDER,
  // а не очерёдность регистрации: ⚙, </>, ⇄, перенос — как в монолите плюс новая кнопка.
  // initLoggerUI() сам проверяет settings.enableLogger и при выключенном логгере
  // не добавляет ни кнопку, ни подписку на записи.
  initSettingsUI()
  initLoggerUI()
  initScannerUI()
  initExporter()
  initActionBar()

  // Пункт 4.5: блок навигации — замена тулбара в десктопной сборке: назад,
  // вперёд, обновить, плюс F5 / Ctrl+R / Alt+стрелки. Стоит после панели действий
  // и никак с ней не связан: это отдельное Vue-приложение в body. Функция сама
  // проверяет платформу и в браузере не делает ничего.
  initNavPanel()

  await openDB()

  const needTranslator =
    settings.translateInterface ||
    settings.translateTitles ||
    settings.translateCharacters ||
    settings.translateStaff

  if (needTranslator) {
    // Правка пункта 4.5 (дефект «перевод периодически пропадает целиком»). Раньше здесь
    // стоял прямой сетевой запрос за словарём, и старт ЖДАЛ его при каждом запуске окна:
    // не отдался GitHub — интерфейс остаётся английским до следующей перезагрузки,
    // отдался медленно — на столько же задерживаются переводчик, поиск и все виджеты.
    // Теперь словарь берётся из IndexedDB и применяется сразу, а сеть работает только
    // на обновление и уходит в фон. Ждём её лишь на самом первом запуске и после
    // ручной очистки кэша.
    //
    // Колбэк может быть вызван дважды — кэшем и затем фоновым обновлением. Это штатно:
    // setRemoteDict() пересобирает итоговый словарь и сам просит переводчик пройти
    // по странице заново.
    Logger('API', 'Загрузка словаря интерфейса...')
    const applied = await loadInterfaceDictionary((dict) => setRemoteDict(dict))
    // Словаря нет ни в кэше, ни в сети: пересобираем вручную, чтобы правки
    // пользователя всё равно применились.
    if (!applied) rebuildDictionary()
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
