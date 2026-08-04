// Этап 5, итерация 5.1: учёт доступности внешних источников.
//
// Зачем модуль. Часть источников недоступна из некоторых сетей, и до сих пор
// пользователь видел от этого лишь пустое место вместо виджета: все причины
// уходили в логгер, куда обычный человек не заглядывает. Модуль собирает
// исходы запросов от клиентов `src/api/*` и отдаёт интерфейсу ответ на два
// вопроса: что именно молчит и стоит ли говорить человеку про VPN.
//
// Главное ограничение, и оно же требование владельца (4 августа): ЗДЕСЬ НЕТ
// НИ ОДНОГО ИМЕНИ ХОСТА и ни одного суждения о том, что где заблокировано.
// Замеры доступности живут неделю: список заблокированного, зашитый в код,
// через месяц будет уверенно врать и при этом требовать сопровождения.
// Состояние всегда следствие того, что сеть ответила прямо сейчас.
//
// Модуль также не знает ни про Vue, ни про DOM: он в ядре, а его читают и
// виджеты, и настройки, и тост. Подписка сделана обычными коллбэками: слой
// интерфейса сам оборачивает их в реактивное состояние.

import { BridgeHttpError } from '@/bridge'
import { Logger } from '../utils/logger'

/**
 * Состояние источника. Разница между `unreachable` и `forbidden` прикладная,
 * а не косметическая: совет включить VPN уместен только в первом случае.
 * Во втором связь есть и туннель ничего не исправит, а может и ухудшить:
 * замер 4 августа показал 403 на api.github.com именно через общий адрес VPN.
 */
export type NetState = 'unknown' | 'ok' | 'unreachable' | 'forbidden' | 'serverError'

/** Запись об одном источнике. `label` задаёт сам клиент — он же показывается в таблице. */
export interface NetSourceHealth {
  id: string
  label: string
  state: NetState
  /** Когда состояние стало таким. Не обновляется при повторе того же исхода. */
  since: number
  /** Когда источник отвечал в последний раз, в любом смысле. */
  lastSeenAt: number
  /** Сколько неудач подряд. Любой успех обнуляет. */
  failStreak: number
  /** Код последнего ответа, если ответ вообще был. */
  lastStatus?: number
  /** Время последнего запроса в миллисекундах, если вызывающий его замерил. */
  lastLatencyMs?: number
  /** Короткая причина для таблицы: `timeout`, `network`, `HTTP 403` и так далее. */
  lastDetail?: string
}

/**
 * Сколько неудач подряд считается поводом говорить с пользователем.
 *
 * Одна ошибка ничего не значит: сеть моргнула, сервис перезагрузился,
 * карточка запросила данные в момент перехода. Две подряд — уже закономерность.
 */
export const FAIL_STREAK_THRESHOLD = 2

/**
 * Окно, в котором недоступность разных источников считается одним событием.
 * Отказ одного источника — дело его виджета. Два и больше за минуту — разговор
 * уже про сеть в целом, и это повод для общего тоста.
 */
export const OUTAGE_WINDOW_MS = 60000

/** Сколько разных недоступных источников в окне считается общей бедой. */
export const OUTAGE_SOURCE_THRESHOLD = 2

const sources = new Map<string, NetSourceHealth>()

type Listener = (snapshot: NetSourceHealth[]) => void
const listeners = new Set<Listener>()

function ensure(id: string, label: string): NetSourceHealth {
  const existing = sources.get(id)
  if (existing) {
    // Метка может уточниться позже: клиент мог отчитаться раньше, чем
    // проверка сети зарегистрировала человеческое название.
    if (label && existing.label !== label) existing.label = label
    return existing
  }

  const created: NetSourceHealth = {
    id,
    label: label || id,
    state: 'unknown',
    since: Date.now(),
    lastSeenAt: 0,
    failStreak: 0,
  }
  sources.set(id, created)
  return created
}

function notify(): void {
  if (listeners.size === 0) return
  const snapshot = listHealth()
  listeners.forEach((listener) => {
    try {
      listener(snapshot)
    } catch (e) {
      // Один сломанный подписчик не должен ломать учёт и остальных подписчиков,
      // но молчать о таком тоже нельзя.
      Logger('ERROR', 'Подписчик net-health упал', e)
    }
  })
}

/**
 * Применяет исход к записи источника.
 *
 * В журнал пишется только СМЕНА состояния, а не каждый отчёт. Иначе при
 * переборе карточек мы получили бы ту самую бомбардировку журнала, из-за
 * которой уже пришлось чинить виджет франшизы на этапе 2.
 */
function apply(
  id: string,
  label: string,
  state: Exclude<NetState, 'unknown'>,
  detail?: string,
  status?: number,
  latencyMs?: number,
): void {
  const record = ensure(id, label)
  const previous = record.state

  record.lastSeenAt = Date.now()
  record.lastDetail = detail
  record.lastStatus = status
  record.lastLatencyMs = latencyMs

  if (state === 'ok') record.failStreak = 0
  else record.failStreak += 1

  if (previous !== state) {
    record.state = state
    record.since = Date.now()

    if (state === 'ok') {
      if (previous !== 'unknown') {
        Logger('INFO', `Сеть: ${record.label} снова отвечает`)
      }
    } else {
      Logger('WARN', `Сеть: ${record.label} — ${describeState(state)}`, {
        detail: detail ?? null,
        status: status ?? null,
      })
    }
  }

  notify()
}

/** Человеческое название состояния. Используется и в журнале, и в таблице проверки. */
export function describeState(state: NetState): string {
  switch (state) {
    case 'ok':
      return 'ответил'
    case 'unreachable':
      return 'не отвечает'
    case 'forbidden':
      return 'отклонил запрос'
    case 'serverError':
      return 'ошибка на стороне сервиса'
    default:
      return 'не проверялся'
  }
}

/**
 * Сообщает об ответе с кодом.
 *
 * Классификация собрана по замерам 4 августа и объясняется так:
 *
 *   403 и 451 — сервис на связи, но не пускает (у нас это Cloudflare перед
 *   AnimeThemes и лимит GitHub по адресу). Про VPN здесь говорить нельзя.
 *   5xx — чужая поломка, ни сеть пользователя, ни мы тут ни при чём.
 *   404 — ОТВЕТ, то есть связь есть. Моё первое измерение дало 404 на живом
 *   graphql.anilist.co только потому, что эндпоинт принимает только POST.
 *   429 — лимит темпа, им занимается api/rate-limit.ts; успешностью его тоже
 *   считать нельзя, иначе он будет сбрасывать чужой счётчик неудач.
 *   401 — истёкший токен; у него своё сообщение и своё лечение.
 *
 * Последние два случая не меняют состояние вовсе: вызов просто игнорируется.
 */
export function reportStatus(
  id: string,
  label: string,
  status: number,
  latencyMs?: number,
): void {
  if (status === 401 || status === 429) return

  if (status === 403 || status === 451) {
    apply(id, label, 'forbidden', `HTTP ${status}`, status, latencyMs)
    return
  }

  if (status >= 500) {
    apply(id, label, 'serverError', `HTTP ${status}`, status, latencyMs)
    return
  }

  apply(id, label, 'ok', `HTTP ${status}`, status, latencyMs)
}

/**
 * Сообщает о транспортном сбое. Принимает что угодно: в catch попадает
 * `unknown`, и заставлять каждый клиент разбирать его самостоятельно значит
 * получить девять разных разборов.
 *
 * Отмена (`abort`) игнорируется: это наше собственное поведение при уходе со
 * страницы, а не свойство сети. При SPA-навигации по AniList таких отмен много,
 * и считать их отказами значило бы регулярно показывать ложный тост.
 */
export function reportError(id: string, label: string, error: unknown, latencyMs?: number): void {
  if (error instanceof BridgeHttpError) {
    if (error.kind === 'abort') return
    apply(id, label, 'unreachable', error.kind, undefined, latencyMs)
    return
  }

  // Не ошибка транспорта — значит, ответ какой-то был, а сломался разбор или
  // прикладная логика. К доступности сети это отношения не имеет, состояние
  // не трогаем вовсе.
}

/** Явный успешный отчёт без кода ответа — для случаев вроде кэша или кадра. */
export function reportOk(id: string, label: string, latencyMs?: number): void {
  apply(id, label, 'ok', undefined, undefined, latencyMs)
}

/** Состояние одного источника или `undefined`, если о нём ещё никто не отчитывался. */
export function getHealth(id: string): NetSourceHealth | undefined {
  const record = sources.get(id)
  return record ? { ...record } : undefined
}

/** Копия всего состояния. Копия, а не ссылки: интерфейс не должен править учёт. */
export function listHealth(): NetSourceHealth[] {
  return Array.from(sources.values(), (record) => ({ ...record }))
}

/**
 * Пора ли говорить про конкретный источник. Спрашивает виджет, решая, показать
 * ли строку вместо пустоты.
 */
export function isTroubled(id: string): boolean {
  const record = sources.get(id)
  if (!record) return false
  return record.state !== 'ok' && record.state !== 'unknown' && record.failStreak >= FAIL_STREAK_THRESHOLD
}

/**
 * Похоже ли на общую беду с сетью: два и больше разных источников не ответили
 * в пределах одного окна.
 *
 * Считаются только `unreachable`. Отказы вида `forbidden` в общую беду не
 * складываются: два сервиса могут не пускать по совершенно разным причинам,
 * и VPN тут ни при чём.
 */
export function looksLikeOutage(now = Date.now()): boolean {
  let count = 0
  sources.forEach((record) => {
    if (record.state !== 'unreachable') return
    if (record.failStreak < FAIL_STREAK_THRESHOLD) return
    if (now - record.lastSeenAt > OUTAGE_WINDOW_MS) return
    count += 1
  })
  return count >= OUTAGE_SOURCE_THRESHOLD
}

/** Метки источников, из-за которых сработал `looksLikeOutage`. Для текста тоста. */
export function troubledLabels(now = Date.now()): string[] {
  const labels: string[] = []
  sources.forEach((record) => {
    if (record.state === 'ok' || record.state === 'unknown') return
    if (record.failStreak < FAIL_STREAK_THRESHOLD) return
    if (now - record.lastSeenAt > OUTAGE_WINDOW_MS) return
    labels.push(record.label)
  })
  return labels
}

/**
 * Подписка на изменения. Возвращает функцию отказа от подписки — её обязан
 * вызвать тот, кто подписался, в своей задаче выхода (registerShutdownTask),
 * иначе после демонтажа компонента коллбэк останется висеть на старом
 * реактивном состоянии.
 */
export function subscribeNetHealth(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
