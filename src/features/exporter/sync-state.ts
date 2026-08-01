// Этап 2 п.2.7: состояние модуля синхронизации.
//
// Та же схема, что у логгера, настроек и сканера: точка монтирования и компонент не
// импортируют друг друга, всё общее живёт здесь.
//
// Прогресс раньше писался в `btn.textContent` из глубины сетевых функций. Теперь
// это `buttonLabel` — обычный ref, а `sync-api.ts` просто зовёт колбэк.
//
// Пункт 3.5.3: токен больше не читается и не пишется через GM_*. Его кэш живёт в
// api/anilist.ts, поэтому здесь просто геттер и сеттер. Это важно именно здесь:
// токен сохраняется ровно перед серией авторизованных запросов, и если бы запись
// шла только в асинхронное хранилище, первый же запрос мог бы уйти без токена
// и весь экспорт упал бы на первом шаге.
//
// Пункт 3.7: точка входа переехала на AniList и на обеих платформах одна и та же.
// Отсюда два следствия в этом файле:
//
//   1. Логин Shikimori больше нельзя угадать по адресу страницы: адрес теперь всегда
//      anilist.co. Вместо угадывания берётся запомненный логин, причём тот же самый,
//      что у окна сравнения (ключ SHIKI_LOGIN). Заводить свой ключ было бы хуже: пользователь
//      один, и вводить один и тот же ник в двух окнах бессмысленно. Запись идёт через
//      scanner/compare.ts, а не напрямую в хранилище: там живёт кэш в памяти, и мимо него
//      запись оставила бы сканеру старое значение до конца сессии.
//
//   2. Режим теперь всегда 'import' и больше не зависит от домена.
//
// Этап 4: отказ токена разбирается отдельной веткой. anilistQuery() на любой код
// вне 200 бросает `Error <код>`, и общий catch показывал «Ошибка: Error 401» — текст,
// по которому невозможно догадаться, что просто протух токен. Токены AniList живут
// год, то есть встреча с этим сообщением гарантирована каждому, кто пользуется
// переносом достаточно долго. Заодно убран non-null на res.data!.Viewer: ответ без data
// давал TypeError вместо внятного сообщения.

import { computed, ref } from 'vue'
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
import { getSavedShikiLogin, loadScannerStorage, saveShikiLogin } from '../scanner/compare'
import { anilistQuery, getStoredAlToken, setAlToken } from '../../api/anilist'

/** Подпись кнопки в покое. В 1.9.1 было жёсткое 'Экспорт'. */
export const IDLE_LABEL = 'Экспорт'

/**
 * Режим работы модуля. По RM2 компонент один, а подписи зависят от среды.
 *
 * После 3.7 среда одна: окно открывается только на AniList и тянет данные со стороны,
 * то есть с точки зрения пользователя это импорт. Тип оставлен с двумя вариантами: он
 * описывает направление переноса, а не домен, и пригодится, если появится обратная выгрузка.
 */
export type SyncMode = 'export' | 'import'

export const syncMode: SyncMode = 'import'

/** Видимость модалки. В 1.9.1 оверлей создавался и удалялся через remove(). */
export const isSyncOpen = ref(false)

/** Идёт ли перенос. На время работы кнопка блокируется, как и раньше. */
export const isRunning = ref(false)

/** Текущая подпись кнопки: она же индикатор прогресса. */
export const buttonLabel = ref(IDLE_LABEL)

/**
 * То же самое для пилюли в панели действий: пусто в покое, текст во время работы.
 *
 * Пустая строка, а не IDLE_LABEL: в покое кнопка должна показывать иконку, а слово
 * «Экспорт» растянуло бы пилюлю и сломало равнение с остальными кнопками.
 */
export const pillProgress = computed(() =>
  buttonLabel.value === IDLE_LABEL ? '' : buttonLabel.value,
)

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

/**
 * Открывает окно переноса.
 *
 * Асинхронная: запомненный логин лежит в хранилище моста, а оно асинхронное. Сначала
 * прогревается кэш сканера, потом подставляются поля. Поле, в которое пользователь
 * уже что-то ввёл, не затирается.
 */
export async function openSyncModal(): Promise<void> {
  await loadScannerStorage()
  if (!shikiUser.value) shikiUser.value = getSavedShikiLogin()
  alToken.value = getStoredAlToken()
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
 * Отказался ли AniList принимать токен.
 *
 * anilistQuery() бросает обычный Error с текстом `Error <код>` либо с текстом
 * GraphQL-ошибки, отдельного типа там нет. Заводить его ради одной ветки здесь значило бы
 * трогать клиент, которым пользуется весь проект, ради одного сценария, поэтому
 * распознаём по тексту. AniList отвечает 401 на протухший или чужой токен и 400 с
 * GraphQL-ошибкой Invalid token — на синтаксически испорченный.
 */
function isAuthFailure(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return (
    message.includes('Error 401') ||
    message.includes('Error 403') ||
    message.toLowerCase().includes('invalid token')
  )
}

/** Текст для пользователя при отказе токена. */
const TOKEN_REJECTED_MESSAGE =
  'AniList отклонил токен: он неверный либо истёк. Токены действуют год, после чего ' +
  'его нужно выпустить заново: откройте окно переноса, создайте ссылку по Client ID ' +
  'и вставьте полученный токен в поле.'

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

  // Логин запоминается тем же ключом, что и в окне сравнения: на AniList его больше
  // неоткуда взять, а требовать ввода при каждом открытии окна невежливо.
  saveShikiLogin(user)

  setAlToken(token)
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

    // Первый авторизованный запрос — он же проверка токена. Разбираем его отказ
    // отдельно от остального переноса: дальше идти всё равно некуда, а причина
    // чинится ровно одним действием пользователя.
    let alUser: AniListUser
    try {
      const res = await anilistQuery<{ Viewer: AniListUser }>(
        'query{Viewer{id name mediaListOptions{scoreFormat}}}',
        {},
        true,
      )
      const viewer = res.data?.Viewer
      if (!viewer) {
        // Ответ 200 без Viewer — тоже отказ в авторизации: анониму AniList отдаёт null.
        throw new Error(TOKEN_REJECTED_MESSAGE)
      }
      alUser = viewer
    } catch (e) {
      if (isAuthFailure(e)) {
        Logger('ERROR', 'Перенос: AniList отклонил токен', e)
        throw new Error(TOKEN_REJECTED_MESSAGE)
      }
      throw e
    }

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
