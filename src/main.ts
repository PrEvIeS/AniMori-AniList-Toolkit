/** AniMori userscript entry point. */

import './style.scss'
import { IS_ANILIST, IS_SHIKI } from './core/constants'
import { initExporter } from './features/exporter'
import { openCompareModal } from './features/scanner'

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

async function bootstrap(): Promise<void> {
  if (IS_SHIKI) initExporter()
  if (IS_ANILIST) initScannerLauncher()
}

void bootstrap()
