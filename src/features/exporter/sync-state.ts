// Этап 2 п.2.7: состояние модуля синхронизации.
//
// Та же схема, что у логгера, настроек и сканера: точка монтирования и компонент не
// импортируют друг друга, всё общее живёт здесь.
//
// Прогресс раньше писался в `btn.textContent` из глубины сетевых функций. Теперь
// это `buttonLabel` — обычный ref, а `sync-api.ts` просто зовёт колбэк.

import { computed, ref } from 'vue'
import { IS_SHIKI } from '../../core/constants'
import { Logger } from '../../utils/logger'
import {
  fetchShikiHistoryDates,
  fetchShikiUserId,
  fetchShikimoriFavorites,
  fetchShikimoriListV2,
  getExistingAnilistFavorites,
  getSyncFailures,
  resetSyncFailures,
  syncShikiToAlFavorites,
  syncShikiToAlList,
  type AniListUser,
  type HistoryDates,
} from './sync-api'
import { anilistQuery } from '../../api/anilist'

/** Подпись кнопки в покое. В 1.9.1 было жёсткое 'Экспорт'. */
export const IDLE_LABEL = 'Экспорт'

/**
 * Режим работы модуля. По RM2 компонент один, а подписи зависят от среды:
 * на Shikimori это «экспорт», в десктопе на AniList — «импорт».
 *
 * Сейчас достижим только режим 'export': импортная ветка требует Bridge из п.3.6,
 * потому что без cookies Shikimori список читается только у публичного профиля (РИСК №2).
 * Каркас заведён заранее, чтобы на Этапе 3 менялся транспорт, а не разметка.
 */
export type SyncMode = 'export' | 'import'

export const syncMode = computed<SyncMode>(() => (IS_SHIKI ? 'export' : 'import'))

/** Видимость модалки. В 1.9.1 оверлей создавался и удалялся через remove(). */
export const isSyncOpen = ref(false)

/** Идёт ли перенос. На время работы кнопка блокируется, как и раньше. */
export const isRunning = ref(false)

/** Текущая подпись кнопки: она же индикатор прогресса. */
export const buttonLabel = ref(IDLE_LABEL)

export const shikiUser = ref('')
export const alToken = ref('')
export const clientId = ref('')

/** Ссылка авторизации; пустая строка значит «ещё не создавали». */
export const authUrl = ref('')

export const optAnime = ref(true)
export const optManga = ref(true)
export const optFavs = ref(true)
export const optDates = ref(true)

// Абсолютные адреса собираются конкатенацией — то же правило, что в панели настроек.
const AL_HOST = 'https://' + 'anilist.co'
export const AL_DEVELOPER_URL = AL_HOST + '/settings/developer'
export const AL_REDIRECT_URL = AL_HOST + '/api/v2/oauth/pin'

/** Логин из адреса страницы Shikimori, как в монолите. */
function guessShikiUser(): string {
  const urlPath = window.location.pathname.split('/')
  const first = urlPath[1]
  return urlPath.length > 1 && first && !['animes', 'mangas', 'forum'].includes(first) ? first : ''
}

export function openSyncModal(): void {
  if (!shikiUser.value) shikiUser.value = guessShikiUser()
  alToken.value = (GM_getValue('AL_TOKEN', '') as string) || ''
  isSyncOpen.value = true
}

export function closeSyncModal(): void {
  isSyncOpen.value = false
}

/** Создаёт ссылку авторизации по Client ID. В 1.9.1 ссылка вставлялась в DOM вручную. */
export function generateAuthUrl(): void {
  const cid = clientId.value.trim()
  if (!cid) {
    alert('Введите Client ID')
    return
  }
  authUrl.value = AL_HOST + '/api/v2/oauth/authorize?client_id=' + cid + '&response_type=token'
}

/**
 * Перенос Shikimori → AniList. Порядок шагов, проверки, тексты alert и confirm
 * сохранены из монолита без изменений.
 */
export async function runSync(): Promise<void> {
  const user = shikiUser.value.trim()
  const token = alToken.value.trim()

  if (!user || !token) {
    alert('Заполните логин и токен!')
    return
  }
  if (!optAnime.value && !optManga.value && !optFavs.value) {
    alert('Выберите опции для экспорта!')
    return
  }

  GM_setValue('AL_TOKEN', token)
  // Токен не остаётся в поле после сохранения — поведение из 1.9.1.
  alToken.value = ''
  isSyncOpen.value = false
  isRunning.value = true

  const onProgress = (text: string) => {
    buttonLabel.value = text
  }

  try {
    resetSyncFailures()
    onProgress('Соединение с AniList...')
    const res = await anilistQuery<{ Viewer: AniListUser }>(
      'query{Viewer{id name mediaListOptions{scoreFormat}}}',
      {},
      true,
    )
    const alUser = res.data!.Viewer

    onProgress('Поиск профиля Shiki...')
    const shikiId = await fetchShikiUserId(user)

    if (
      !confirm(
        `Начать перенос Shikimori ➜ AniList для профиля '${alUser.name}'?\n\nВнимание: Экспорт может занять некоторое время.`,
      )
    )
      return

    let historyDates: Record<string, HistoryDates> | null = null
    if (optDates.value && (optAnime.value || optManga.value))
      historyDates = await fetchShikiHistoryDates(shikiId, onProgress)
    if (optAnime.value) {
      const animeList = await fetchShikimoriListV2(shikiId, 'anime')
      await syncShikiToAlList(animeList, 'anime', alUser, historyDates, onProgress)
    }
    if (optManga.value) {
      const mangaList = await fetchShikimoriListV2(shikiId, 'manga')
      await syncShikiToAlList(mangaList, 'manga', alUser, historyDates, onProgress)
    }
    if (optFavs.value) {
      const exFavs = await getExistingAnilistFavorites(alUser.id, onProgress)
      const shikiFavs = await fetchShikimoriFavorites(user)
      await syncShikiToAlFavorites(shikiFavs, exFavs, onProgress)
    }

    const failures = getSyncFailures()
    if (failures > 0) {
      alert(`Экспорт завершён частично: ${failures} операций не выполнено. Подробности в логгере.`)
    } else {
      alert('Экспорт успешно завершен!')
    }
  } catch (e) {
    Logger('ERROR', 'Экспорт Shikimori → AniList: ошибка выполнения', e)
    alert('Ошибка: ' + ((e as Error).message || e))
  } finally {
    isRunning.value = false
    setTimeout(() => {
      buttonLabel.value = IDLE_LABEL
    }, 2000)
  }
}
