// Этап 2 п.2.1: единая точка монтирования Vue-приложений в чужую страницу.
//
// Никто кроме этого модуля не должен звать createApp().mount() напрямую.
// Причины три, все из AUDITION.md:
//
// РИСК №4 (рекурсия мутаций). Vue на каждом реактивном обновлении выдаёт сотни
// микро-мутаций. Если корень не помечен am-notr до первого mount(), наблюдатель
// переводчика успевает зайти в свежую разметку, переводит текст, Vue возвращает
// свой — и цикл не заканчивается. Порядок здесь важен буквально: класс → вставка в DOM → mount().
//
// РИСК №3 (React против Vue). AniList — React-SPA и без предупреждений сносит чужие
// узлы при перерисовке. Если контейнер вырезали, экземпляр приложения остаётся жив и
// держит подписки — это zombie-компонент и утечка. Поэтому всё смонтированное
// регистрируется здесь, а не в пункте 2.9: риск актуален с первого mount(), а не с конца этапа.
// В пункте 2.9 останется только привязка к SPA-навигации через core/lifecycle.
//
// Этап 3. Компоненты не должны знать о GM_*. Здесь нет ни одного обращения к хранилищу
// или сети сознательно: модуль переезжает в Tauri без правок.

import { createApp } from 'vue'
import type { App, Component } from 'vue'
import { NO_TRANSLATE_CLASS } from '../features/translator/dom'
import { Logger } from './logger'

/** Префикс id у всех созданных нами корней. Удобно искать в инспекторе. */
const ROOT_ID_PREFIX = 'am-vue-'

/** Класс на каждом корне: единый селектор для массовых операций и стилей. */
export const VUE_ROOT_CLASS = 'am-vue-root'

export interface MountOptions {
  /**
   * Где создать корень. По умолчанию document.body — самое безопасное место:
   * React туда не залезает. Всё, что встраивается внутрь разметки сайта, обязано
   * передавать container и быть готовым к пересозданию.
   */
  container?: HTMLElement
  /** props корневого компонента. */
  props?: Record<string, unknown>
  /** Дополнительные классы на корневом узле. */
  rootClasses?: readonly string[]
  /**
   * Следить за тем, что корень остался в документе. При пропаже — пересоздать.
   * Для модалок в body не нужно, для инъекций в React-дерево — обязательно.
   */
  watchContainer?: boolean
}

interface MountedEntry {
  key: string
  app: App<Element>
  root: HTMLElement
  component: Component
  options: MountOptions
  observer?: MutationObserver
}

/** Реестр живых приложений. Ключ — логическое имя («settings», «logger»). */
const registry = new Map<string, MountedEntry>()

function createRoot(key: string, options: MountOptions): HTMLElement {
  const root = document.createElement('div')
  root.id = ROOT_ID_PREFIX + key
  // Класс-иммунитет выставляется ДО вставки в документ и ДО mount().
  root.classList.add(NO_TRANSLATE_CLASS, VUE_ROOT_CLASS)
  for (const cls of options.rootClasses ?? []) root.classList.add(cls)
  return root
}

/**
 * Монтирует компонент и регистрирует его под ключом key.
 * Повторный вызов с тем же ключом возвращает уже созданный экземпляр,
 * а не плодит второе приложение: модалки открываются из разных мест.
 *
 * @returns экземпляр приложения или null, если смонтировать не удалось.
 */
export function mountApp(
  key: string,
  component: Component,
  options: MountOptions = {},
): App<Element> | null {
  const existing = registry.get(key)
  if (existing) {
    if (existing.root.isConnected) return existing.app
    // Корень вырезали из-под нас — чистим и монтируем заново.
    Logger('WARN', `mountApp: корень «${key}» исчез из DOM, пересоздаю`)
    unmountApp(key)
  }

  const parent = options.container ?? document.body
  if (!parent) {
    Logger('ERROR', `mountApp: нет контейнера для «${key}»`)
    return null
  }

  const root = createRoot(key, options)

  try {
    parent.appendChild(root)
    const app = createApp(component, options.props ?? {})

    // Ошибка в любом компоненте не должна ронять остальной скрипт.
    app.config.errorHandler = (err, _instance, info) => {
      Logger('ERROR', `Vue «${key}»: сбой в ${info}`, err)
    }

    app.mount(root)

    const entry: MountedEntry = { key, app, root, component, options }
    if (options.watchContainer) entry.observer = watchRoot(entry, parent)
    registry.set(key, entry)

    return app
  } catch (e) {
    Logger('ERROR', `mountApp: не удалось смонтировать «${key}»`, e)
    root.remove()
    return null
  }
}

/**
 * Наблюдатель за исчезновением корня (РИСК №3).
 * Следим только за детьми родителя и без subtree: внутренние мутации — это
 * работа самого Vue, и подписка на них вернёт ту же рекурсию, от которой ушли.
 */
function watchRoot(entry: MountedEntry, parent: HTMLElement): MutationObserver | undefined {
  if (!window.MutationObserver) return undefined
  try {
    const observer = new MutationObserver(() => {
      if (entry.root.isConnected) return
      observer.disconnect()
      const { key, component, options } = entry
      registry.delete(key)
      try {
        entry.app.unmount()
      } catch {
        /* узлов уже нет — нормально */
      }
      Logger('INFO', `vue-mounter: корень «${key}» удалён страницей, монтирую заново`)
      mountApp(key, component, options)
    })
    observer.observe(parent, { childList: true })
    return observer
  } catch (e) {
    Logger('WARN', `vue-mounter: не удалось включить наблюдение за «${entry.key}»`, e)
    return undefined
  }
}

/** Смонтированное приложение по ключу, если оно есть. */
export function getApp(key: string): App<Element> | undefined {
  return registry.get(key)?.app
}

/** Корневой узел приложения по ключу. */
export function getRoot(key: string): HTMLElement | undefined {
  return registry.get(key)?.root
}

/**
 * Корневой компонент приложения через defineExpose.
 * Так панель действий открывает модалки, не зная о их внутренностях.
 */
export function getExposed<T = Record<string, unknown>>(key: string): T | null {
  const app = registry.get(key)?.app
  if (!app) return null
  return (app._instance?.exposed as T | undefined) ?? null
}

/** Снимает одно приложение и убирает его корень из DOM. */
export function unmountApp(key: string): void {
  const entry = registry.get(key)
  if (!entry) return
  registry.delete(key)
  entry.observer?.disconnect()
  try {
    entry.app.unmount()
  } catch (e) {
    Logger('WARN', `unmountApp: сбой при снятии «${key}»`, e)
  }
  entry.root.remove()
}

/**
 * Снимает всё. Вызывается из LifecycleManager при смене роута (пункт 2.9).
 * Порядок не важен: приложения между собой не связаны.
 */
export function unmountAll(): void {
  for (const key of Array.from(registry.keys())) unmountApp(key)
}

/** Список ключей живых приложений — для дампа состояния в логгере. */
export function listMountedApps(): string[] {
  return Array.from(registry.keys())
}
