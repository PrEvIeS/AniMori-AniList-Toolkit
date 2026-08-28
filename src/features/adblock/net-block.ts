// Связь между страницей и сетевым блокировщиком из src-tauri/src/adblock.rs:
// приём докладов о заблокированных доменах и переключение тумблером из настроек.
//
// Почему не invoke: вызов команды потребовал бы выдачи нового разрешения контексту
// anilist.co, то есть ЛЮБОМУ скрипту чужого сайта. Вместо этого страница дёргает
// адрес на несуществующем домене, а блокировщик видит этот запрос и переключается.
// Зона .invalid зарезервирована стандартом и никогда не разрешается в сети: если
// блокировщика нет (браузер, другая ОС), запрос просто тихо умирает.

import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

const CONTROL_ORIGIN = 'https://adblock.animori.invalid'

declare global {
  interface Window {
    __animoriNetBlocked?: (host: string, total: number) => void
    /** Канал в оболочку macOS; на Windows и в браузере его нет. */
    webkit?: {
      messageHandlers?: Record<string, { postMessage: (body: unknown) => void } | undefined>
    }
  }
}

/** Имя обработчика в src-tauri/src/adblock_macos.rs. Разойтись эти два места не должны. */
const MAC_MESSAGE_NAME = 'animoriAdblock'

/**
 * Принимает доклад оболочки о первой блокировке домена.
 *
 * Запись идёт обычным типом INFO, а не своим новым: типа вне фильтров логгера
 * в окне просто не видно.
 */
export function initNetBlockReporter(): void {
  if (Bridge.platform !== 'tauri') return

  window.__animoriNetBlocked = (host, total) => {
    Logger('INFO', `Адблок: заблокирован источник ${host}`, {
      всего_за_сессию: total,
    })
  }
}

export function destroyNetBlockReporter(): void {
  delete window.__animoriNetBlocked
}

/**
 * Включает или выключает сетевой блокировщик в оболочке.
 *
 * Каналов два, потому что движки разные.
 *
 * macOS: у WKWebView перехвата https-запросов нет вовсе, поэтому оболочка
 * заводит свой обработчик сообщений. Уровень доступа тот же, что и у запроса
 * ниже: и то и другое доступно любому скрипту anilist.co, — но команды Tauri
 * с разрешением в capabilities по-прежнему не требуется.
 *
 * Windows: запрос на несуществующий домен, который видит перехватчик.
 * mode: 'no-cors' обязателен: без него движок сначала спросит разрешение
 * у чужого домена (preflight), а отвечать на него некому.
 *
 * Ошибка глотается молча: если перехвата нет, запрос упадёт — и это нормально,
 * красная запись в журнале только напугала бы без повода.
 */
export function setShellAdBlock(on: boolean): void {
  if (Bridge.platform !== 'tauri') return

  const mac = window.webkit?.messageHandlers?.[MAC_MESSAGE_NAME]
  if (mac) {
    mac.postMessage(on ? 'on' : 'off')
    return
  }

  void fetch(`${CONTROL_ORIGIN}/${on ? 'on' : 'off'}`, {
    mode: 'no-cors',
    cache: 'no-store',
  }).catch(() => {})
}
