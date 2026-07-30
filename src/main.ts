/** AniMori userscript entry point. */

import './style.scss'
import { DICT_URL, IS_ANILIST, IS_SHIKI } from './core/constants'
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
import { initTranslator } from './features/translator'
import { Logger } from './utils/logger'

function initScannerLauncher(): void {
  if (document.getElementById('animori-compare-button')) return
  const btn = document.createElement('button')
  btn.id = 'animori-compare-button'
  btn.type = 'button'
  btn.textContent = 'Сравнить списки'
  btn.style.cssText =
    'position:fixed;bottom:20px;left:20px;z-index:9999;padding:11px 20px;background:rgba(var(--color-foreground),.9);border:1px solid rgba(var(--color-text-light),.2);color:rgb(var(--color-text));border-radius:12px;cursor:pointer;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.18)'
  btn.onclick = () => void openCompareModal()
  document.body.appendChild(btn)
}

/**
 * Тянет общий словарь интерфейса. Промис никогда не отклоняется:
 * если словарь не скачался, переводчик всё равно запускается и делает то, что умеет
 * без словаря (даты, счётчики, русские названия тайтлов).
 */
function loadInterfaceDictionary(): Promise<void> {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: DICT_URL,
      onload: (res) => {
        try {
          setRemoteDict(JSON.parse(res.responseText) as Record<string, string>)
        } catch (e) {
          Logger('ERROR', 'Не удалось разобрать словарь интерфейса', e)
        }
        resolve()
      },
      onerror: (e) => {
        Logger('ERROR', 'Сетевая ошибка при загрузке словаря', e)
        resolve()
      },
    })
  })
}

/**
 * Порядок важен и взят из монолита (строки 4597-4610):
 * настройки → БД → словарь → переводчик → медиа-виджеты.
 * РИСК №1 из AUDITION.md: на Этапе 4 настройки станут асинхронными, поэтому
 * наблюдатель запускается только после того, как настройки уже в памяти.
 */
async function bootstrap(): Promise<void> {
  await loadSettings()

  if (IS_SHIKI) initExporter()
  if (!IS_ANILIST) return

  initScannerLauncher()

  const needTranslator =
    settings.translateInterface ||
    settings.translateTitles ||
    settings.translateCharacters ||
    settings.translateStaff
  if (!needTranslator) return

  await openDB()

  Logger('API', 'Загрузка словаря интерфейса...')
  await loadInterfaceDictionary()
  rebuildDictionary()

  initTranslator()

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
