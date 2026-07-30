/** AniMori userscript entry point. */

import './style.scss'
import { fetchInterfaceDictionary } from './api/dictionary'
import { amSetAccent } from './core/accent'
import { IS_ANILIST, IS_SHIKI } from './core/constants'
import { openDB } from './core/db'
import { rebuildDictionary, setRemoteDict } from './core/dictionary'
import { loadSettings, settings } from './core/settings'
import { initExporter } from './features/exporter'
import { initMedia, registerMediaWidget } from './features/media'
import { extLinksWidget } from './features/media/extlinks'
import { franchiseWidget } from './features/media/franchise'
import { playerWidget } from './features/media/player'
import { ratingsWidget } from './features/media/ratings'
import { themesWidget } from './features/media/themes'
import { openCompareModal } from './features/scanner'
import { initSearch } from './features/search'
import { initTranslator } from './features/translator'
import { ACTION_ORDER, initActionBar, registerActionButton } from './features/ui/actions'
import { installGlobalErrorHandlers, Logger } from './utils/logger'

/**
 * Порядок важен и взят из init() монолита (строки 4210-4230, 4596-4613):
 * настройки → перехватчики ошибок → акцент → панель кнопок → БД → словарь →
 * переводчик → поиск → медиа-виджеты.
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

  // Кнопки ⚙ и </> регистрируются итерациями, которые принесут свои модалки;
  // ACTION_ORDER гарантирует, что они встанут левее ⇄, как в монолите.
  registerActionButton({
    id: 'am-cmp-btn',
    label: '⇄',
    title: 'Сравнить списки Shikimori и AniList (AniMori)',
    order: ACTION_ORDER.compare,
    onClick: () => void openCompareModal(),
  })
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
}

void bootstrap()
