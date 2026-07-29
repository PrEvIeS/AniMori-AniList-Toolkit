// Пункт 1.3 плана: акцентные темы тулкита (строки 95-113 монолита).
//
// --am-accent по умолчанию = var(--color-blue) и следует теме AniList. Пресет
// переопределяет её на documentElement -> красит виджеты/модалки, не трогая тему сайта.
// Инлайновые «синий = AniList / розовый = Shikimori» намеренно оставлены на
// --color-blue (это семантика источника данных, а не акцент).

import type { AccentPreset } from './settings'

export interface AccentDefinition {
  name: string
  /** Триплет "r,g,b" или null — следовать теме сайта. */
  triple: string | null
  dot: string
}

export const AM_ACCENTS: Record<AccentPreset, AccentDefinition> = {
  site: { name: 'Тема сайта', triple: null, dot: 'rgb(var(--color-blue))' },
  sakura: { name: 'Sakura', triple: '244,114,182', dot: '#f472b6' },
  mono: { name: 'Mono', triple: '148,163,184', dot: '#94a3b8' },
  catppuccin: { name: 'Catppuccin', triple: '203,166,247', dot: '#cba6f7' },
}

let amAccentTriple: string | null = null

export function getAccentTriple(): string | null {
  return amAccentTriple
}

export function amApplyAccentToDom(): void {
  // 'site' (null) = синий AniList.
  document.documentElement.style.setProperty('--am-accent', amAccentTriple || 'var(--color-blue)')
}

export function amSetAccent(preset: string): void {
  const p = (AM_ACCENTS[preset as AccentPreset] ? preset : 'site') as AccentPreset
  amAccentTriple = AM_ACCENTS[p].triple
  amApplyAccentToDom()
}
