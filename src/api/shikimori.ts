// Пункт 1.4 плана: REST-клиент Shikimori (строки 1680-1723 монолита).
//
// Перебор зеркал: 404 не считается ответом, потому что тайтл может быть удалён
// по требованию РКН на основном домене и жив на .rip. Поэтому 404 запоминается
// как lastNotFound и отдаётся только если все зеркала ответили так же.
//
// РИСК №2 из AUDITION.md: на Этапе 4 запросы к Shikimori из Rust не увидят куки
// WebView, и приватные эндпоинты (списки пользователя) начнут отдавать 401/403.
// Публичные карточки тайтлов, которые ходят через fetchShiki, от этого не страдают.
//
// Пункт 3.5.2: транспорт переведён с GM_xmlhttpRequest на Bridge.http. Перебор зеркал
// и трактовка кодов ответа остались ЗДЕСЬ и НЕ уехали в мост: мост знает только
// про HTTP и не обязан знать ни про лимиты Shikimori, ни про РКН. Код вне 2xx мост
// исключением не считает, поэтому 429 и 404 разбираются явными ветками до проверки
// на успех.
//
// Пункт 3.8, три изменения:
//
//   1. Ограничитель темпа уехал в rate-limit.ts и стал ОБЩИМ с поиском персон.
//      Раньше шлюз жил здесь и считал только вызовы fetchShiki, а shikimori-people.ts
//      после перехода на мост шёл в тот же домен мимо учёта. См. шапку rate-limit.ts.
//
//   2. Уровни логов сведены с anime365.ts. 429 и падение одного зеркала — это WARN:
//      источник жив, просто просит подождать или ответит вторым адресом. ERROR остаётся
//      только там, где данных так и не будет. До этого штатный перебор зеркал заливал
//      логгер красным при полностью исправной работе. Исход °везде 404° тоже стал
//      виден в логе: раньше он возвращался молча и выглядел как пропавший перевод.
//
//   3. Повтор после 429 ограничен MAX_RATE_RETRIES. Раньше было `return fetchShiki(path)`
//      без счётчика: при устойчивом лимите это вечный цикл по пять секунд на виток.
//
// Куки не шлём (credentials: 'omit'). Публичным карточкам они не нужны, а дефолтный
// 'include' у моста уже один раз привёл к HTTP 400 Request Header Or Cookie Too Large
// на graphql.anilist.co. Приватные запросы живут в shikimori-user.ts и сюда не ходят.

import { Bridge } from '@/bridge'
import { SHIKI_DOMAINS } from '../core/constants'
import { Logger } from '../utils/logger'
import { MAX_RATE_RETRIES, RateLimitError, shikiLimiter } from './rate-limit'

/** Штрафная пауза после 429. */
const RATE_PAUSE_MS = 5000
/** Таймаут одного зеркала: дольше ждать нет смысла, лучше уйти на следующее. */
const MIRROR_TIMEOUT_MS = 5000

/**
 * Активна ли сейчас пауза по лимиту Shikimori.
 * Очередь перевода проверяет это перед каждой пачкой.
 */
export function isShikimoriRateLimited(): boolean {
  return shikiLimiter.isPaused()
}

/** Ставит паузу вручную (например, 429 увидел поиск персон). */
export function pauseShikimori(ms: number): void {
  shikiLimiter.pause(ms)
}

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

export interface ShikiResponse<T = unknown> {
  /** null означает "не найдено" либо полный сбой всех зеркал. */
  data: T | null
  /** Домен зеркала, ответившего успешно. */
  domain: string | null
}

/**
 * GET к Shikimori REST с перебором зеркал и повтором при 429.
 * @param path Путь вида `/api/animes/123`, без домена.
 * @param attempt Номер попытки после 429, считая с нуля. Служебный параметр рекурсии.
 */
export async function fetchShiki<T = unknown>(
  path: string,
  attempt = 0,
): Promise<ShikiResponse<T>> {
  Logger('API', `Запрос к Shikimori API: ${path}`)
  let lastNotFound: ShikiResponse<T> | null = null
  let mirrorFailures = 0

  for (const domain of SHIKI_DOMAINS) {
    try {
      // Слот берём перед каждой реальной отправкой, включая перебор зеркал:
      // зеркала делят один бюджет, а не имеют по своему.
      await shikiLimiter.acquireSlot()

      const r = await Bridge.http.request({
        method: 'GET',
        url: mirrorUrl(domain, path),
        timeoutMs: MIRROR_TIMEOUT_MS,
        credentials: 'omit',
      })

      if (r.status === 429) {
        // Паузу ставим всегда: она притормозит и поиск персон, и очередь перевода.
        shikiLimiter.pause(RATE_PAUSE_MS)

        if (attempt + 1 >= MAX_RATE_RETRIES) {
          Logger('ERROR', `Shikimori: лимит 429 не отпустил, запрос отменён: ${path}`, {
            domain,
            attempts: attempt + 1,
          })
          throw new RateLimitError('Shikimori', path)
        }

        Logger(
          'WARN',
          `Shikimori 429 (${domain}): пауза ${RATE_PAUSE_MS}мс, ` +
            `повтор ${attempt + 2}/${MAX_RATE_RETRIES} — ${path}`,
        )
        // Повтор пойдёт через шлюз и сам дождётся конца паузы.
        return fetchShiki<T>(path, attempt + 1)
      }

      // 404: возможно удалён по РКН — пробуем следующее зеркало (напр. .rip).
      if (r.status === 404) {
        lastNotFound = { data: null, domain }
        continue
      }

      if (r.status !== 200) {
        throw new Error(`Shikimori HTTP ${r.status}`)
      }

      return { data: JSON.parse(r.text) as T, domain }
    } catch (e) {
      // Исчерпание повторов по 429 — не сбой зеркала: следующее так же упрётся в лимит,
      // потому что бюджет у них общий. Отдаём ошибку вызывающему.
      if (e instanceof RateLimitError) throw e

      // Сеть, таймаут (BridgeHttpError), неизвестный код или битый JSON — следующее зеркало.
      // Это WARN, а не ERROR: второе зеркало ещё может отдать данные.
      mirrorFailures++
      Logger('WARN', `Shikimori: зеркало ${domain} не ответило по ${path}`, e)
    }
  }

  if (lastNotFound) {
    // Данных нет нигде. Для вызывающего это штатный исход, но в логе он должен быть
    // виден: именно так выглядит «перевод не появился, и непонятно почему».
    Logger('WARN', `Shikimori: данных нет ни на одном зеркале (404): ${path}`)
    return lastNotFound
  }

  Logger('ERROR', `Все зеркала Shikimori недоступны для ${path}`, { mirrorFailures })
  throw new Error(`Все зеркала Shikimori недоступны для ${path}`)
}
