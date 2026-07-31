// Пункт 1.4 плана: поиск персонажей и авторов Shikimori (строки 1953-2083 монолита).
//
// Отдельно от shikimori.ts, потому что это не транспорт, а стратегия поиска:
// три REST-запроса, фоллбэк на GraphQL, дозагрузка деталей и гард тёзок.
//
// Почему так сложно: API Shikimori ищет только по точному порядку слов, а AniList
// даёт имена в западном порядке. Оттуда вариант с reversedName и два разных
// REST-эндпоинта (/search и ?search) — они ведут себя по-разному на одних и тех же данных.
//
// Гард тёзок: если совпадение не кандзи-точное (score < 90), требуем пересечения
// по MAL id тайтлов. Без этого однофамильцы подменяли описания персонажей.
//
// Пункт 3.5.2: транспорт переведён с GM_xmlhttpRequest на Bridge.http. Изменена
// ровно одна функция — локальная обёртка request(); вся стратегия поиска, пороги
// совпадения, гард тёзок и кэш ролей остались нетронутыми.
//
// Пункт 3.8 — главное исправление этого файла.
//
// При переходе на мост здесь появился второй, неучтённый канал в тот же домен:
// шлюз темпа жил внутри shikimori.ts и обслуживал только fetchShiki(), а request()
// ниже шёл напрямую. На одну персону — до пяти запросов (три поиска, GraphQL,
// детали), при пачке в десять штук — до пятидесяти обращений мимо счётчика,
// без минимального интервала и без уважения к штрафной паузе после 429. Именно
// поэтому перевод визуально ускорился, а счётчик окна при этом не заполнялся.
//
// Теперь request() берёт слот у того же shikiLimiter, что и fetchShiki: один бюджет
// на весь источник, включая оба зеркала и оба канала.
//
// Там же выровнены уровни логов. Раньше было наоборот: битый JSON одного из трёх
// поисков кричал ERROR, хотя остальные два ещё могли найти персону, а полный
// транспортный сбой глотался молча через `catch { return { status: 0 } }`.

import { Bridge } from '@/bridge'
import { SHIKI_DOMAINS } from '../core/constants'
import { Logger } from '../utils/logger'
import { scoreNameMatch } from '../utils/name-match'
import type { NameCandidate, NameTarget } from '../utils/name-match'
import { shikiLimiter } from './rate-limit'
import { fetchShiki } from './shikimori'

/** Коллекция Shikimori: имя совпадает у REST-пути и у поля GraphQL. */
export type PersonEndpoint = 'characters' | 'people'

/** Штрафная пауза, когда 429 пришёл именно на поиске персон. */
const PERSON_RATE_PAUSE_MS = 6000

export interface ShikiPerson {
  id: number
  russian: string | null
  description: string | null
  url: string | null
  /** Зеркало, на котором нашлась персона — нужно для сборки абсолютной ссылки. */
  domain: string
}

export interface ShikiPersonResult {
  /** 200 — найдено, 404 — нет или отклонён гардом, 429 — рейт-лимит. */
  status: number
  data: ShikiPerson | null
}

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

interface RawResponse {
  status: number
  responseText: string
}

/**
 * Обёртка над Bridge.http, которая никогда не реджектит.
 * Форма результата (status + responseText) сохранена намеренно: на неё завязаны
 * все три шага поиска ниже. status 0 = транспортный сбой.
 *
 * Пункт 3.8: слот у общего ограничителя, куки не шлём, транспортный сбой больше
 * не пропадает из лога, а 429 сразу тормозит весь источник, а не только текущую
 * ветку поиска: соседние запросы пачки уже стоят в очереди шлюза.
 */
async function request(opts: {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  data?: string
}): Promise<RawResponse> {
  try {
    await shikiLimiter.acquireSlot()

    const r = await Bridge.http.request({
      method: opts.method,
      url: opts.url,
      headers: opts.headers,
      body: opts.data,
      credentials: 'omit',
    })

    if (r.status === 429) {
      shikiLimiter.pause(PERSON_RATE_PAUSE_MS)
      Logger('WARN', `Shikimori 429 на поиске персоны: пауза ${PERSON_RATE_PAUSE_MS}мс`, {
        url: opts.url,
      })
    }

    return { status: r.status, responseText: r.text }
  } catch (e) {
    // Транспортный сбой (BridgeHttpError). Поиск персон не должен ронять перевод
    // страницы, поэтому отдаём status 0 — но теперь хотя бы с записью в журнал.
    Logger('WARN', `Shikimori: запрос поиска персоны не ушёл: ${opts.url}`, e)
    return { status: 0, responseText: '' }
  }
}

/** Кандидат из списка поиска. */
interface PersonCandidate extends NameCandidate {
  id?: number
}

/** Детали персоны. Связи с тайтлами лежат в четырёх разных полях. */
interface PersonDetails {
  id?: number
  russian?: string | null
  description?: string | null
  url?: string | null
  animes?: Array<{ id?: number } | null>
  mangas?: Array<{ id?: number } | null>
  works?: Array<{ anime?: { id?: number } | null } | null>
  roles?: Array<{ animes?: Array<{ id?: number } | null> } | null>
}

/** Собирает MAL id всех тайтлов, с которыми связан кандидат. */
function collectCandidateMalIds(details: PersonDetails): number[] {
  const ids: number[] = []
  if (Array.isArray(details.animes)) {
    details.animes.forEach((a) => {
      if (a?.id) ids.push(a.id)
    })
  }
  if (Array.isArray(details.mangas)) {
    details.mangas.forEach((m) => {
      if (m?.id) ids.push(m.id)
    })
  }
  if (Array.isArray(details.works)) {
    details.works.forEach((w) => {
      if (w?.anime?.id) ids.push(w.anime.id)
    })
  }
  if (Array.isArray(details.roles)) {
    details.roles.forEach((rr) => {
      ;(rr?.animes ?? []).forEach((a) => {
        if (a?.id) ids.push(a.id)
      })
    })
  }
  return ids
}

/** Выбирает лучшего кандидата из списка по баллу совпадения. */
function pickBest(
  list: PersonCandidate[],
  target: NameTarget,
): { cand: PersonCandidate; score: number } | null {
  let best: PersonCandidate | null = null
  let bestScore = 0
  for (const c of list) {
    const sc = scoreNameMatch(c, target)
    if (sc > bestScore) {
      bestScore = sc
      best = c
    }
  }
  return best && bestScore >= 80 ? { cand: best, score: bestScore } : null
}

/**
 * Ищет персонажа или автора на Shikimori по имени с AniList.
 * @param endpointStr Коллекция: characters или people.
 * @param searchName Имя ромадзи (подчёркивания и дефисы будут заменены на пробелы).
 * @param nativeName Имя на кандзи, если известно — главный признак точного совпадения.
 * @param targetMalIds MAL id тайтлов цели для гарда тёзок.
 */
export async function fetchShikiPersonREST(
  endpointStr: PersonEndpoint,
  searchName: string | null | undefined,
  nativeName?: string | null,
  targetMalIds: number[] = [],
): Promise<ShikiPersonResult> {
  if (!searchName) return { status: 404, data: null }

  const cleanStr = searchName.replace(/_/g, ' ').replace(/-/g, ' ').trim()
  const nameParts = cleanStr.split(' ')
  const reversedName = nameParts.length > 1 ? [...nameParts].reverse().join(' ') : cleanStr
  const target: NameTarget = { full: cleanStr, native: nativeName ?? null }

  Logger('API', `Поиск персоны на Shiki: ${cleanStr}`)

  /** Считаем транспортные сбои: от них зависит уровень итогового сообщения. */
  let transportFailures = 0

  for (const domain of SHIKI_DOMAINS) {
    try {
      let item: PersonCandidate | null = null
      let itemScore = 0
      let rateLimited = false

      // Шаг 1: три варианта REST-поиска. Прямой порядок, обратный, другой эндпоинт.
      const searchUrls = [
        mirrorUrl(domain, `/api/${endpointStr}/search?search=${encodeURIComponent(cleanStr)}`),
        ...(nameParts.length > 1
          ? [
              mirrorUrl(
                domain,
                `/api/${endpointStr}/search?search=${encodeURIComponent(reversedName)}`,
              ),
            ]
          : []),
        mirrorUrl(domain, `/api/${endpointStr}?search=${encodeURIComponent(cleanStr)}`),
      ]

      for (const url of searchUrls) {
        const r = await request({ method: 'GET', url })
        if (r.status === 429) {
          rateLimited = true
          break
        }
        if (r.status === 0) transportFailures++
        if (r.status === 200) {
          try {
            const list = JSON.parse(r.responseText) as PersonCandidate[]
            if (Array.isArray(list) && list.length > 0) {
              const m = pickBest(list, target)
              if (m && m.score > itemScore) {
                item = m.cand
                itemScore = m.score
              }
            }
          } catch (e) {
            // Один из трёх поисков отдал мусор — остальные ещё могут сработать.
            Logger('WARN', `Shikimori: неразборчивый ответ поиска персоны (${domain})`, e)
          }
        }
        if (itemScore >= 100) break // точный кандзи, дальше искать нечего
      }

      if (rateLimited) return { status: 429, data: null }

      // Шаг 2: фоллбэк на GraphQL — иногда находит то, что REST не отдаёт.
      if (!item) {
        const gqlQuery =
          `query($search: String) { ${endpointStr}(search: $search, limit: 5) ` +
          '{ id name russian japanese } }'
        const r = await request({
          method: 'POST',
          url: mirrorUrl(domain, '/api/graphql'),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          data: JSON.stringify({ query: gqlQuery, variables: { search: cleanStr } }),
        })
        if (r.status === 429) return { status: 429, data: null }
        if (r.status === 0) transportFailures++
        if (r.status === 200) {
          try {
            const res = JSON.parse(r.responseText) as {
              data?: Record<string, PersonCandidate[] | undefined>
            }
            const list = res.data?.[endpointStr] ?? []
            const m = pickBest(list, target)
            if (m) {
              item = m.cand
              itemScore = m.score
            }
          } catch (e) {
            Logger('WARN', `Shikimori: неразборчивый ответ GraphQL поиска (${domain})`, e)
          }
        }
      }

      // Шаг 3: дозагрузка деталей — в списке поиска нет ни описания, ни связей.
      if (item?.id) {
        const rDetails = await request({
          method: 'GET',
          url: mirrorUrl(domain, `/api/${endpointStr}/${item.id}`),
        })
        if (rDetails.status === 429) return { status: 429, data: null }
        if (rDetails.status === 0) transportFailures++

        let detailsRes: PersonDetails | null = null
        if (rDetails.status === 200) {
          try {
            detailsRes = JSON.parse(rDetails.responseText) as PersonDetails
          } catch (e) {
            Logger('WARN', `Shikimori: неразборчивые детали персоны (${domain})`, e)
          }
        }

        // Гард тёзок: при неточном совпадении требуем общий тайтл.
        if (targetMalIds.length && itemScore < 90 && detailsRes) {
          const candMal = collectCandidateMalIds(detailsRes)
          if (candMal.length && !candMal.some((id) => targetMalIds.includes(id))) {
            Logger(
              'WARN',
              `Отклонён вероятный тёзка: ${cleanStr} (нет общих тайтлов, score=${itemScore})`,
            )
            return { status: 404, data: null }
          }
        }

        if (detailsRes) {
          return {
            status: 200,
            data: {
              id: detailsRes.id ?? item.id,
              russian: detailsRes.russian ?? item.russian ?? null,
              description: detailsRes.description ?? null,
              url: detailsRes.url ?? null,
              domain,
            },
          }
        }

        return {
          status: 200,
          data: {
            id: item.id,
            russian: item.russian ?? null,
            description: null,
            url: null,
            domain,
          },
        }
      }
    } catch (e) {
      transportFailures++
      Logger('WARN', `Сбой поиска персоны "${cleanStr}" на зеркале ${domain}`, e)
    }
  }

  // Разводим два разных исхода, которые раньше выглядели одинаково:
  //   - источник ответил, но такой персоны у него нет — штатно, WARN;
  //   - до источника вообще не достучались — это уже ошибка.
  if (transportFailures > 0) {
    Logger('ERROR', `Поиск персоны сорвался на всех зеркалах: ${cleanStr}`, {
      transportFailures,
    })
    return { status: 0, data: null }
  }

  Logger('WARN', `Персона не найдена на Shikimori: ${cleanStr}`)
  return { status: 404, data: null }
}

export interface AniListPersonRef {
  name: { full?: string | null; native?: string | null }
  media?: { nodes?: Array<{ idMal?: number | null; type?: string | null }> } | null
  staffMedia?: { nodes?: Array<{ idMal?: number | null; type?: string | null }> } | null
}

interface ShikiRoleEntry {
  character?: PersonCandidate | null
  person?: PersonCandidate | null
}

/**
 * Сколько тайтлов максимум проверяем при резолве через роли.
 * Без потолка персона с сорока тайтлами стоит сорока запросов, а совпадение
 * почти всегда находится на первых же: список AniList идёт по убыванию значимости.
 */
const MAX_MEDIA_PROBES = 5

/**
 * Кэш списков ролей на время сессии.
 *
 * АУДИТ (итерация 10): без кэша один и тот же /roles тянулся до 11 раз за минуту:
 * на странице десяток персонажей из одного аниме, и каждый независимо запрашивал
 * один и тот же список. Это давало 35% лишнего трафика и выбивало 429.
 *
 * Храним именно промис, а не результат: тогда параллельные вызовы дожидаются
 * одного запроса, а не стартуют свой каждый.
 */
const rolesCache = new Map<string, Promise<ShikiRoleEntry[] | null>>()

/** Загружает роли тайтла через кэш. */
function loadRoles(kind: string, id: number): Promise<ShikiRoleEntry[] | null> {
  const key = kind + '/' + String(id)
  const cached = rolesCache.get(key)
  if (cached) return cached

  const task = fetchShiki<ShikiRoleEntry[]>('/api/' + kind + '/' + String(id) + '/roles')
    .then((res) => res.data)
    .catch((e: unknown) => {
      // Сбой не кэшируем: зеркало могло лечь временно.
      rolesCache.delete(key)
      Logger('WARN', `Не удалось загрузить роли: ${key}`, e)
      return null
    })

  rolesCache.set(key, task)
  return task
}

/**
 * Резолвит персонажа/автора через роли в общих тайтлах, когда поиск по имени не сработал.
 * Кандидаты уже ограничены составом тайтла, поэтому порог мягче (55), но слабые
 * совпадения по подстроке (30) всё равно отсекаются.
 */
export async function resolveShikiPersonByMedia(
  personData: AniListPersonRef,
  type: 'characters' | 'staff',
): Promise<PersonCandidate | null> {
  const mediaNodes = (type === 'characters' ? personData.media : personData.staffMedia)?.nodes ?? []
  const mediaRefs = mediaNodes
    .filter((m) => m.idMal)
    .map((m) => ({ id: m.idMal as number, kind: m.type === 'MANGA' ? 'mangas' : 'animes' }))
    .slice(0, MAX_MEDIA_PROBES)
  if (mediaRefs.length === 0) return null

  const target: NameTarget = {
    full: personData.name.full ?? '',
    native: personData.name.native ?? '',
  }

  let best: PersonCandidate | null = null
  let bestScore = 0

  for (const ref of mediaRefs) {
    const roles = await loadRoles(ref.kind, ref.id)
    if (roles) {
      const items = roles
        .map((r) => (type === 'characters' ? r.character : r.person))
        .filter((x): x is PersonCandidate => Boolean(x))
      for (const c of items) {
        const sc = scoreNameMatch(c, target)
        if (sc > bestScore) {
          bestScore = sc
          best = c
        }
        if (bestScore >= 100) break
      }
    }
    if (bestScore >= 100) break
  }

  return bestScore >= 55 ? best : null
}
