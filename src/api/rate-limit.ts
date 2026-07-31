// Пункт 3.8 плана: общий ограничитель темпа обращений к внешним источникам.
//
// Зачем отдельный модуль. До этой итерации шлюз acquireSlot() жил внутри
// shikimori.ts и обслуживал ровно одну функцию — fetchShiki(). Поиск персон
// (shikimori-people.ts) после перевода транспорта на мост в пункте 3.5.2 ходил
// в тот же домен собственной локальной обёрткой, минуя шлюз: до пяти запросов
// на персону при пачке в десять штук. Счётчик окна их не видел, минимальный
// интервал на них не действовал, штрафная пауза после 429 ими игнорировалась.
// Отсюда наблюдение «перевод летает, а в лимит не упираемся»: тормозилась
// меньшая часть трафика, и считалась ровно она же.
//
// Ограничитель создаётся ОДИН НА ИСТОЧНИК, а не на домен. Зеркала одного
// источника делят общий бюджет: лимит Shikimori считается по IP, и shikimori.rip
// не выдаёт второй бюджет — уход на зеркало не должен удваивать темп. То же для
// пары smotret-anime.online / anime365.ru.
//
// Модуль намеренно не знает ни про HTTP, ни про мост, ни про коды ответа: он
// выдаёт разрешение на отправку и хранит паузу. Трактовка ответов остаётся
// в клиентах, как и договаривались при выносе транспорта.

/**
 * Сколько раз повторяем запрос, упершийся в 429, прежде чем отдать ошибку.
 * Без потолка повтор был рекурсивным и бесконечным: при устойчивом лимите
 * клиент крутился по пять секунд на итерацию до закрытия вкладки.
 */
export const MAX_RATE_RETRIES = 3

/**
 * Единый режим темпа для всех источников: пять запросов в секунду по пиковому
 * интервалу и шестьдесят в минуту по окну. Значения ниже потолков обоих API
 * (Shikimori: 5/сек и 90/мин), поэтому запас держится сознательно.
 */
export const API_MIN_INTERVAL_MS = 300
export const API_WINDOW_MS = 60000
export const API_MAX_PER_WINDOW = 60

/**
 * Отказ по исчерпанию повторов на 429.
 *
 * Отдельный тип нужен, чтобы перебор зеркал не проглотил его своим catch:
 * «источник просит подождать» и «это зеркало не ответило» — разные события,
 * и второе не должно маскировать первое.
 */
export class RateLimitError extends Error {
  constructor(source: string, target: string) {
    super(`${source}: лимит запросов не отпустил за ${MAX_RATE_RETRIES} попытки (${target})`)
    this.name = 'RateLimitError'
  }
}

export interface RateLimiterOptions {
  /** Имя источника — попадает в текст ошибок. */
  name: string
  /** Минимальный промежуток между стартами двух запросов. */
  minIntervalMs: number
  /** Длина скользящего окна учёта. */
  windowMs: number
  /** Сколько запросов допускается внутри окна. */
  maxPerWindow: number
}

export interface RateLimiter {
  readonly name: string
  /** Ждёт своей очереди на отправку. Возврат = разрешение отправить один запрос. */
  acquireSlot: () => Promise<void>
  /** Ставит источник на паузу (обычно после 429). Паузы не сокращаются, только продлеваются. */
  pause: (ms: number) => void
  /** Активна ли пауза. Очередь перевода спрашивает это перед каждой пачкой. */
  isPaused: () => boolean
  /** Сколько миллисекунд осталось до конца паузы. */
  pauseRemaining: () => number
  /** Снимок состояния для инспектора логгера (только чтение). */
  stats: () => { inWindow: number; pauseRemaining: number }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Создаёт независимый ограничитель темпа для одного источника. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { name, minIntervalMs, windowMs, maxPerWindow } = options

  /** Unix-время, до которого запросы к источнику приостановлены. */
  let pausedUntil = 0
  /** Время последней выдачи слота. */
  let lastSentAt = 0
  /** Отметки выдач за последнее окно. */
  const recentSends: number[] = []
  /**
   * Очередь ожидающих: шлюз пропускает по одному, иначе два параллельных вызова
   * займут один и тот же слот. Ответа не ждём — иначе один медленный запрос
   * застопорит всех остальных.
   */
  let gate: Promise<void> = Promise.resolve()

  async function acquireSlot(): Promise<void> {
    const previous = gate
    let release: () => void = () => undefined
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      for (;;) {
        const now = Date.now()

        // Чистим отметки, вышедшие за окно.
        while (recentSends.length > 0 && now - (recentSends[0] ?? 0) >= windowMs) {
          recentSends.shift()
        }

        const waits: number[] = []
        const sinceLast = now - lastSentAt
        if (sinceLast < minIntervalMs) waits.push(minIntervalMs - sinceLast)
        if (now < pausedUntil) waits.push(pausedUntil - now)
        if (recentSends.length >= maxPerWindow) {
          waits.push(windowMs - (now - (recentSends[0] ?? now)) + 50)
        }

        if (waits.length === 0) {
          lastSentAt = Date.now()
          recentSends.push(lastSentAt)
          return
        }

        await sleep(Math.max(...waits))
      }
    } finally {
      release()
    }
  }

  return {
    name,
    acquireSlot,
    pause(ms: number): void {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms)
    },
    isPaused(): boolean {
      return Date.now() < pausedUntil
    },
    pauseRemaining(): number {
      return Math.max(0, pausedUntil - Date.now())
    },
    stats() {
      return {
        inWindow: recentSends.length,
        pauseRemaining: Math.max(0, pausedUntil - Date.now()),
      }
    },
  }
}

/**
 * Ограничитель Shikimori. Общий для REST-клиента (shikimori.ts) и для поиска
 * персон (shikimori-people.ts) — именно ради этого модуль и появился.
 * Приватные запросы пользователя (shikimori-user.ts) идут мимо: это единичные
 * обращения по кнопке, а не поток очереди перевода.
 */
export const shikiLimiter = createRateLimiter({
  name: 'Shikimori',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/**
 * Ограничитель anime365. Режим тот же, что у Shikimori: источники стоят в одной
 * цепочке резолва названий, и разный темп означал бы, что фоллбэк обгоняет
 * основной источник и первым ловит блокировку.
 */
export const anime365Limiter = createRateLimiter({
  name: 'anime365',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})
