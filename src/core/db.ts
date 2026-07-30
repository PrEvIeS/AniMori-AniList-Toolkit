// Пункт 1.4 плана: слой IndexedDB (строки 1282-1487 монолита).
//
// Инстанс базы держится в приватной переменной модуля: наружу отдаются только функции,
// поэтому случайно обратиться к сырому IDBDatabase из UI-кода уже нельзя.
//
// Этап 3: этот модуль остаётся как есть. IndexedDB одинаково доступен и в юзерскрипте,
// и в WebView Tauri, так что через Bridge его прятать не нужно — в отличие от GM_*.

import { CACHE_TIME, DB_NAME, DB_VERSION } from './constants'
import { Logger } from '../utils/logger'
import type { CacheRecord, CacheStoreName, DbStats, DbStatsError } from './types'

type Migration = (db: IDBDatabase) => void

let globalDbInstance: IDBDatabase | null = null

/**
 * Миграции схемы. Ключ — версия, значение — мигратор от N-1 к N.
 * Прогон от `oldVersion+1` до DB_VERSION; каждый шаг идемпотентен (objectStoreNames.contains).
 * Новая миграция: поднять DB_VERSION в constants.ts и добавить `[N+1]: ...`.
 * Версии 1..5 консолидированы в шаг 5, далее нумерация с 6.
 */
const DB_MIGRATIONS: Record<number, Migration> = {
  5: (db) => {
    if (!db.objectStoreNames.contains('shikiCache'))
      db.createObjectStore('shikiCache', { keyPath: 'key' })
    if (!db.objectStoreNames.contains('malCache'))
      db.createObjectStore('malCache', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('franchiseCache'))
      db.createObjectStore('franchiseCache', { keyPath: 'id' })
  },
}

/** Открывает базу, прогоняя недостающие миграции. Возвращает null при сбое. */
export async function openDB(): Promise<IDBDatabase | null> {
  if (globalDbInstance) return globalDbInstance

  return new Promise((resolve) => {
    Logger('DB', 'Открытие подключения к IndexedDB...')
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = req.result
      const fromVersion = e.oldVersion || 0
      Logger('DB', `Миграция БД: ${fromVersion} → ${DB_VERSION}`)

      for (let v = fromVersion + 1; v <= DB_VERSION; v++) {
        const migrate = DB_MIGRATIONS[v]
        if (!migrate) continue
        try {
          migrate(db)
          Logger('DB', `Миграция БД: шаг ${v} выполнен успешно`)
        } catch (err) {
          Logger('ERROR', `Миграция БД: сбой на шаге ${v}`, err)
        }
      }
    }

    req.onsuccess = () => {
      globalDbInstance = req.result
      resolve(globalDbInstance)
    }

    req.onerror = () => {
      Logger('ERROR', 'Ошибка открытия IndexedDB', req.error)
      resolve(null)
    }
  })
}

/**
 * Читает запись по ключу.
 * @param store Имя object store.
 * @param key keyPath стора: `key` (строка) для shikiCache, `id` (число) для остальных.
 */
export async function dbGet<T = unknown>(
  store: CacheStoreName,
  key: IDBValidKey,
): Promise<T | null> {
  try {
    const db = await openDB()
    if (!db) return null

    return await new Promise<T | null>((resolve) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => {
        Logger('ERROR', `Ошибка чтения DB (${store})`, key)
        resolve(null)
      }
    })
  } catch (e) {
    Logger('ERROR', `Сбой dbGet (${store})`, e)
    return null
  }
}

/** Пишет (put — вставка или перезапись) запись в object store. */
export async function dbSet(store: CacheStoreName, data: CacheRecord): Promise<void> {
  try {
    const db = await openDB()
    if (!db) return

    return await new Promise<void>((resolve) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(data)
      tx.oncomplete = () => {
        Logger('DB', `Запись в кэш ${store} успешна`)
        resolve()
      }
      tx.onerror = (e) => {
        Logger('ERROR', `Ошибка записи DB (${store})`, e)
        resolve()
      }
    })
  } catch (e) {
    Logger('ERROR', `Сбой dbSet (${store})`, e)
  }
}

/** Очищает все сторы кэша. Вызывается из настроек по кнопке. */
export async function clearCache(): Promise<void> {
  Logger('INFO', 'Запущен ручной сброс кэша IndexedDB')
  const db = await openDB()
  if (!db) return

  const tx = db.transaction(['shikiCache', 'malCache', 'franchiseCache'], 'readwrite')
  tx.objectStore('shikiCache').clear()
  tx.objectStore('malCache').clear()
  tx.objectStore('franchiseCache').clear()

  return new Promise((resolve) => {
    tx.oncomplete = () => resolve()
  })
}

/**
 * Фоновый GC: курсором по shikiCache удаляет записи старше CACHE_TIME.
 * Fire-and-forget — промис резолвится до окончания обхода курсора, как и в монолите.
 */
export async function runGarbageCollector(): Promise<void> {
  try {
    const db = await openDB()
    if (!db) return

    const store = db.transaction(['shikiCache'], 'readwrite').objectStore('shikiCache')
    const req = store.openCursor()
    let deletedCount = 0

    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        const record = cursor.value as { ts?: number }
        if (typeof record.ts === 'number' && Date.now() - record.ts > CACHE_TIME) {
          cursor.delete()
          deletedCount++
        }
        cursor.continue()
      } else if (deletedCount > 0) {
        Logger('DB', `Garbage Collector очистил ${deletedCount} устаревших записей из кэша`)
      }
    }
  } catch (e) {
    Logger('ERROR', 'Ошибка Garbage Collector', e)
  }
}

/** Снимок БД для инспектора: количество записей по типам ключей и оценка размера. */
export async function getDbStats(): Promise<DbStats | DbStatsError> {
  try {
    const db = await openDB()
    if (!db) return { error: 'БД недоступна' }

    // 1. Размер памяти — до открытия транзакции, иначе она успеет закрыться на await.
    let estimatedSize = 'Неизвестно'
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate()
        estimatedSize = ((est.usage ?? 0) / 1024 / 1024).toFixed(2) + ' MB'
      }
    } catch (e) {
      Logger('WARN', 'getDbStats: navigator.storage.estimate() недоступен', e)
    }

    // 2. Транзакция
    return await new Promise<DbStats | DbStatsError>((resolve) => {
      const tx = db.transaction(['shikiCache', 'malCache'], 'readonly')
      const shikiStore = tx.objectStore('shikiCache')
      const malStore = tx.objectStore('malCache')

      const stats: DbStats = {
        media: 0,
        characters: 0,
        staff: 0,
        themes: 0,
        malMappings: 0,
        totalCacheRecords: 0,
        estimatedSize,
      }

      const malReq = malStore.count()
      malReq.onsuccess = () => {
        stats.malMappings = malReq.result
      }

      const shikiReq = shikiStore.getAllKeys()
      shikiReq.onsuccess = () => {
        const keys = shikiReq.result
        stats.totalCacheRecords = keys.length
        keys.forEach((key) => {
          if (typeof key !== 'string') return
          if (key.startsWith('MED2_') || key.startsWith('FULL_')) stats.media++
          else if (key.startsWith('CHR2_')) stats.characters++
          else if (key.startsWith('STF3_')) stats.staff++
          // Исправление дефекта монолита: темы кэшируются под префиксом THEMES2_
          // (см. api/animethemes.ts), а счётчик искал THEMES_, поэтому в инспекторе
          // всегда показывалось 0 тем. Ошибка только в статистике: сам кэш работал.
          else if (key.startsWith('THEMES2_')) stats.themes++
        })
      }

      tx.oncomplete = () => resolve(stats)
      tx.onerror = () => resolve({ error: 'Ошибка чтения метрик БД' })
    })
  } catch (e) {
    Logger('ERROR', 'Сбой getDbStats', e)
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
