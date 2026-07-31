// Пункт 1.3 плана: настройки пользовательских внешних ссылок (строки 213–222 монолита).
//
// JSON-массив в хранилище ('am_custom_links'): [{ name, url, color }], где:
//   url — шаблон с {ru}/{romaji}/{query}
//   color — триплет "r,g,b"
//
// Итерация 3.5.3: GM_getValue/GM_setValue заменены на Bridge.storage. Хранилище
// асинхронное, а виджет внешних ссылок строится синхронно прямо во время отрисовки
// сайдбара, поэтому список держим в памяти: loadCustomLinks() один раз наполняет кэш
// при старте, getCustomLinks() отдаёт копию кэша, setCustomLinks() сначала обновляет
// память и только потом пишет в хранилище. Тот же приём, что и в core/settings.ts.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

export interface CustomLink {
  name: string
  url: string
  /** Триплет "r,g,b" для --c в CSS. */
  color: string
}

/** Палитра по умолчанию: 6 триплетов для новых ссылок. */
export const CL_COLORS = [
  '61,180,242',
  '243,139,168',
  '183,148,244',
  '166,227,161',
  '246,193,119',
  '224,82,100',
]

const STORAGE_KEY = 'am_custom_links'

/** Кэш в памяти: getCustomLinks() обязан оставаться синхронным. */
let cache: CustomLink[] = []

/** Разбирает значение из хранилища: там может лежать и строка, и готовый массив. */
function parseLinks(raw: unknown): CustomLink[] {
  const arr = Array.isArray(raw) ? raw : JSON.parse((raw as string) || '[]')
  return Array.isArray(arr) ? (arr as CustomLink[]) : []
}

/**
 * Наполняет кэш из хранилища. Вызывается один раз из bootstrap() до отрисовки
 * виджетов. При сбое оставляет пустой список: блок внешних ссылок просто не покажет
 * пользовательские пункты, встроенные сервисы при этом работают.
 */
export async function loadCustomLinks(): Promise<void> {
  try {
    const raw = await Bridge.storage.get<unknown>(STORAGE_KEY, '[]')
    cache = parseLinks(raw)
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения am_custom_links', e)
    cache = []
  }
}

/**
 * Отдаёт копию списка. Копия, а не сам массив: раньше каждый вызов возвращал свежий
 * результат JSON.parse, и правки в нём не влияли на сохранённые данные до setCustomLinks().
 */
export function getCustomLinks(): CustomLink[] {
  return cache.map((link) => ({ ...link }))
}

/**
 * Сохраняет список: сначала память, затем хранилище. Никогда не бросает исключение,
 * иначе редактор ссылок в настройках падал бы на ошибке записи.
 */
export function setCustomLinks(arr: CustomLink[]): void {
  cache = Array.isArray(arr) ? arr.map((link) => ({ ...link })) : []
  void Bridge.storage.set(STORAGE_KEY, JSON.stringify(cache)).catch((e) => {
    Logger('ERROR', 'Ошибка записи am_custom_links', e)
  })
}
