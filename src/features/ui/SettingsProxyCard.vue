<!--
  Пункт 5.3, часть третья: раздел прокси в панели настроек.

  Карточка только для десктопной сборки (v-if по Bridge.platform). В юзерскрипте прокси
  задаёт браузер или система, и наши настройки там не влияют ни на что: запросы идут
  через GM_xmlhttpRequest, у которого своего прокси нет вовсе. Показывать там неработающие
  поля было бы обманом.

  Почему состояние живёт здесь, а не в settings-state.ts. Ключи прокси сознательно не входят
  в AniMoriSettings: те настройки читаются одним снимком на старте страницы и нужны
  прикладным модулям постоянно, а прокси нужен ровно двум местам — мосту и стороне Rust,
  и оба читают его сами один раз за запуск. Добавлять семь полей в общий снимок ради
  одного экрана незачем.

  Главное, что обязана сказать эта карточка человеку: настройка вступает в силу после
  перезапуска приложения. Это не наша лень, а устройство движка окна: WebView2 читает
  адрес прокси один раз, при создании своего окружения (подробности — в src-tauri/src/proxy.rs).

  Поля работают по @change, а не v-model — та же схема, что у остальных текстовых полей
  панели: записывать адрес прокси на каждое нажатие клавиши — это десятки записей
  в файл на одну строку.

  Пункт 5.3.6 добавил сюда две вещи: строку состояния и кнопку проверки. До них
  единственным способом узнать, работает ли прокси, было перезапустить приложение
  и посмотреть, загрузится ли страница — а если не загрузится, то вместе с ней пропадала
  и эта панель, ибо она живёт внутри страницы.
-->
<template>
  <div class="amk-card" v-if="isDesktop">
    <div class="amk-card-title">Прокси</div>
    <div class="amk-row-hint" style="padding: 2px 2px 8px; line-height: 1.5">
      Через прокси пойдут и запросы AniMori к источникам, и трафик самого сайта. Настройка вступает
      в силу после перезапуска приложения.
    </div>

    <div class="amk-row">
      <span class="amk-row-label"><b>Использовать прокси</b></span>
      <label class="amk-switch">
        <input type="checkbox" id="set_proxy_on" v-model="enabled" @change="onEnabledChange()" />
        <span class="amk-track"></span><span class="amk-thumb"></span>
      </label>
    </div>

    <div class="amk-row" style="gap: 8px; border-top: none; padding-top: 0">
      <select
        class="amk-select"
        id="set_proxy_kind"
        style="flex: 0 0 110px"
        :value="kind"
        @change="onKindChange($event)"
      >
        <option value="http">HTTP</option>
        <option value="socks5">SOCKS5</option>
      </select>
      <input
        class="amk-input amk-mono"
        id="set_proxy_host"
        style="flex: 1"
        placeholder="127.0.0.1"
        title="Адрес прокси без схемы: 127.0.0.1 или proxy.local"
        :value="host"
        @change="onHostChange($event)"
      />
      <input
        class="amk-input amk-mono"
        id="set_proxy_port"
        style="flex: 0 0 92px"
        placeholder="порт"
        :value="portDraft"
        @change="onPortChange($event)"
      />
    </div>

    <div class="amk-row" style="gap: 8px; border-top: none; padding-top: 0">
      <input
        class="amk-input amk-mono"
        id="set_proxy_login"
        style="flex: 1"
        placeholder="логин"
        :value="login"
        @change="onLoginChange($event)"
      />
      <input
        class="amk-input amk-mono"
        id="set_proxy_pass"
        type="password"
        style="flex: 1"
        placeholder="пароль"
        :value="password"
        @change="onPasswordChange($event)"
      />
    </div>

    <div class="amk-row">
      <span class="amk-row-label"
        ><b>Без прокси</b
        ><span class="amk-row-hint">адреса через запятую — пойдут напрямую</span></span
      >
    </div>
    <div class="amk-row" style="border-top: none; padding-top: 0">
      <input
        class="amk-input amk-mono"
        id="set_proxy_bypass"
        style="flex: 1"
        placeholder="localhost, 127.0.0.1"
        :value="bypass"
        @change="onBypassChange($event)"
      />
    </div>

    <div
      v-if="showBadConfig"
      class="amk-row-hint"
      style="padding: 8px 2px 0; line-height: 1.5; color: rgb(var(--color-red, 243, 139, 168))"
    >
      Прокси включён, но адрес или порт заданы неверно — трафик пойдёт напрямую.
    </div>

    <div v-if="showPasswordNote" class="amk-row-hint" style="padding: 8px 2px 0; line-height: 1.5">
      Пароль хранится в файле настроек в открытом виде. Прокси с паролем примут запросы AniMori, а
      сам сайт спросит авторизацию отдельным окошком.
    </div>

    <div v-if="needsRestart" class="amk-row-hint" style="padding: 8px 2px 0; line-height: 1.5">
      Изменения сохранены и заработают после перезапуска приложения — кнопка «Применить и
      перезагрузить» здесь не поможет и обновит только страницу.
    </div>

    <!--
      Состояние и проверка. Две разные строки, потому что отвечают на разные вопросы:
      первая — «что произошло при запуске», вторая — «жив ли адрес сейчас».
    -->
    <div class="amk-row" style="padding-top: 10px">
      <span class="amk-row-label"
        ><b>Состояние</b><span class="amk-row-hint">{{ statusText }}</span></span
      >
    </div>

    <div class="amk-row" style="border-top: none; padding-top: 0">
      <button
        class="amk-btn amk-btn-block"
        id="am-proxy-check"
        :disabled="checking"
        @click="check()"
      >
        {{ checking ? 'Проверяем…' : 'Проверить сейчас' }}
      </button>
    </div>

    <div
      v-if="checkText"
      class="amk-row-hint"
      style="padding: 8px 2px 0; line-height: 1.5"
      :style="{
        color: checkOk
          ? 'rgb(var(--color-green, 166,227,161))'
          : 'rgb(var(--color-red, 243,139,168))',
      }"
    >
      {{ checkText }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import type { ProxyStatus } from '@/bridge'
import {
  DEFAULT_PROXY,
  PROXY_KEYS,
  isProxyUsable,
  normalizeProxyKind,
  normalizeProxyPort,
} from '../../core/proxy'
import type { ProxyKind } from '../../core/proxy'
import { Logger } from '../../utils/logger'

/**
 * Есть ли смысл в этой карточке в текущей сборке. Константа на всю сессию,
 * поэтому не ref и не computed — тот же приём, что у isAdblockAvailable.
 */
const isDesktop = Bridge.platform === 'tauri'

/**
 * Куда стучимся боевым запросом при проверке.
 *
 * Адрес взят из того же списка разрешённых в capabilities/default.json, что и у проверки
 * сети: новый домен потребовал бы правки ACL ради одной кнопки. Файл крошечный
 * и отдаётся без авторизации.
 */
const PROBE_URL =
  'https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/README.md'

/** Предел ожидания боевого запроса. Дольше человек всё равно считает кнопку зависшей. */
const CHECK_TIMEOUT_MS = 8000

const enabled = ref(DEFAULT_PROXY.enabled)
const kind = ref<ProxyKind>(DEFAULT_PROXY.kind)
const host = ref(DEFAULT_PROXY.host)
const login = ref(DEFAULT_PROXY.login)
const password = ref(DEFAULT_PROXY.password)
const bypass = ref(DEFAULT_PROXY.bypass)

/**
 * Порт держим строкой, а число пишем в хранилище. Иначе любая опечатка в поле
 * мгновенно превратилась бы в ноль и затёрла уже набранное человеком.
 */
const portDraft = ref(String(DEFAULT_PROXY.port))

/** Была ли хотя бы одна запись за время жизни панели. */
const needsRestart = ref(false)

/** Что произошло с прокси при запуске приложения. Наполняется со стороны Rust. */
const status = ref<ProxyStatus | null>(null)

const checking = ref(false)
const checkText = ref('')
const checkOk = ref(false)

const showBadConfig = computed(
  () =>
    enabled.value &&
    !isProxyUsable({
      enabled: enabled.value,
      kind: kind.value,
      host: host.value,
      port: normalizeProxyPort(portDraft.value),
      login: login.value,
      password: password.value,
      bypass: bypass.value,
    }),
)

const showPasswordNote = computed(() => password.value.length > 0)

/**
 * Строка состояния.
 *
 * Говорит только о прошедшем запуске, а не о том, что набрано в полях сейчас: это
 * разные вещи, пока приложение не перезапущено. Путать их нельзя: человек, видя
 * «применён» рядом с только что введённым адресом, решил бы, что тот уже работает.
 */
const statusText = computed(() => {
  const s = status.value
  if (!s) return 'читаем…'

  if (s.outcome === 'off') return 'при запуске прокси был выключен — трафик идёт напрямую'
  if (s.outcome === 'invalid')
    return 'при запуске прокси был включён, но адрес негоден — трафик идёт напрямую'
  if (s.outcome === 'unreachable')
    return `при запуске ${s.server} не ответил — трафик идёт напрямую`

  return `при запуске применён ${s.server}${s.hasCredentials ? ' (с логином)' : ''}`
})

/**
 * Проверка по кнопке.
 *
 * Два шага, потому что они ловят разные беды:
 *
 *   1. Щуп со стороны Rust — простое TCP-соединение с адресом из файла настроек.
 *      Отвечает на вопрос «а он вообще там есть?».
 *   2. Боевой запрос через мост — проходит тем же путём, что и все наши запросы
 *      к API. Отвечает на вопрос «а он пускает наружу?».
 *
 * Именно расхождение этих двух ответов — самый полезный случай: живой прокси,
 * который принимает соединение, но не выпускает в сеть, одним только щупом не ловится.
 *
 * Ограничителя темпа тут нет осознанно (в отличие от проверки сети): запрос один,
 * идёт на статику GitHub, а человек, подбирающий рабочий прокси, будет жать кнопку
 * подряд — и это нормальное поведение, а не злоупотребление.
 */
async function check(): Promise<void> {
  if (checking.value) return

  checking.value = true
  checkText.value = ''

  try {
    const probe = await Bridge.proxyDiagnostics.probe()

    // Прокси выключен или настроен негодно — проверять нечего, и боевой запрос
    // только запутал бы: он ушёл бы напрямую и успешно.
    if (probe.outcome === 'off') {
      checkOk.value = false
      checkText.value = 'Прокси выключен — проверять нечего.'
      return
    }

    if (probe.outcome === 'invalid') {
      checkOk.value = false
      checkText.value = 'Адрес или порт заданы неверно — проверять нечего.'
      return
    }

    // Боевой запрос делаем в любом случае, даже когда щуп молчит: прокси может
    // отказывать в голом TCP-соединении без запроса, но работать.
    let reached = false
    try {
      const res = await Bridge.http.request({
        url: PROBE_URL,
        method: 'GET',
        timeoutMs: CHECK_TIMEOUT_MS,
        credentials: 'omit',
      })
      reached = res.ok
    } catch (e) {
      Logger('WARN', 'Проверка прокси: боевой запрос не прошёл', e)
    }

    // Четыре сочетания. Каждое описано словами, а не галочкой: человеку нужно знать
    // не «хорошо/плохо», а что именно чинить. Про третий случай важно помнить:
    // наши запросы берут настройку прокси один раз за сеанс (proxyReady в TauriBridge),
    // поэтому прокси, включённый уже после запуска, для них ещё не существует.
    if (probe.reachable && reached) {
      checkOk.value = true
      checkText.value = `Прокси ${probe.server} ответил за ${probe.latencyMs} мс, запрос через него прошёл.`
    } else if (probe.reachable && !reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} ответил, но наружу не пустил: проверьте логин, пароль и вид прокси.`
    } else if (!probe.reachable && reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, а запрос всё равно прошёл — значит, он ушёл напрямую, мимо прокси. Так будет до перезапуска, если прокси включён только что.`
    } else {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, и запрос не прошёл.`
    }
  } catch (e) {
    checkOk.value = false
    checkText.value = 'Не удалось выполнить проверку — подробности в журнале.'
    Logger('ERROR', 'Не удалось проверить прокси', e)
  } finally {
    checking.value = false
  }
}

/**
 * Запись одного ключа.
 *
 * Обработчики событий синхронны, а хранилище асинхронное, поэтому результата не ждём.
 * Молчать об отказе нельзя (инвариант 4): незаписавшаяся настройка выглядит как
 * «прокси не работает» и без журнала не отличима от ошибки в адресе.
 */
function save(key: string, value: unknown): void {
  needsRestart.value = true
  void Bridge.storage.set(key, value).catch((e: unknown) => {
    Logger('ERROR', 'Не удалось сохранить настройку прокси: ' + key, e)
  })
}

function inputValue(e: Event): string {
  const el = e.target
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : ''
}

function onEnabledChange(): void {
  save(PROXY_KEYS.enabled, enabled.value)
}

function onKindChange(e: Event): void {
  kind.value = normalizeProxyKind(inputValue(e))
  save(PROXY_KEYS.kind, kind.value)
}

function onHostChange(e: Event): void {
  // Схема и хвостовой слеш отрезаются: человек по привычке вставляет адрес целиком,
  // а вид прокси задаётся соседним списком, и http:// в поле адреса дало бы
  // нерабочий http://http://… без единого внятного следа в журнале.
  host.value = inputValue(e)
    .trim()
    .replace(/^\w+:\/\//, '')
    .replace(/\/$/, '')
  save(PROXY_KEYS.host, host.value)
}

function onPortChange(e: Event): void {
  const raw = inputValue(e).trim()
  const port = normalizeProxyPort(raw)
  // В поле остаётся то, что набрано, даже если это не порт: иначе строка прыгала бы
  // в ноль на глазах. О негодном значении говорит красная строка ниже.
  portDraft.value = raw
  save(PROXY_KEYS.port, port)
}

function onLoginChange(e: Event): void {
  login.value = inputValue(e).trim()
  save(PROXY_KEYS.login, login.value)
}

function onPasswordChange(e: Event): void {
  // Пароль не подрезаем тримом целиком сознательно: пробел внутри пароля законен,
  // а тихая правка чужого пароля дала бы необъяснимый отказ авторизации.
  password.value = inputValue(e)
  save(PROXY_KEYS.password, password.value)
}

function onBypassChange(e: Event): void {
  bypass.value = inputValue(e)
  save(PROXY_KEYS.bypass, bypass.value)
}

/**
 * Чтение текущих значений при монтировании.
 *
 * Одним Promise.all: в десктопной сборке каждое чтение — вызов до бэкенда,
 * и семь последовательных ожиданий были бы заметной задержкой при открытии панели.
 */
async function load(): Promise<void> {
  try {
    const [rawEnabled, rawKind, rawHost, rawPort, rawLogin, rawPassword, rawBypass] =
      await Promise.all([
        Bridge.storage.get<boolean>(PROXY_KEYS.enabled, DEFAULT_PROXY.enabled),
        Bridge.storage.get<string>(PROXY_KEYS.kind, DEFAULT_PROXY.kind),
        Bridge.storage.get<string>(PROXY_KEYS.host, DEFAULT_PROXY.host),
        Bridge.storage.get<number>(PROXY_KEYS.port, DEFAULT_PROXY.port),
        Bridge.storage.get<string>(PROXY_KEYS.login, DEFAULT_PROXY.login),
        Bridge.storage.get<string>(PROXY_KEYS.password, DEFAULT_PROXY.password),
        Bridge.storage.get<string>(PROXY_KEYS.bypass, DEFAULT_PROXY.bypass),
      ])

    enabled.value = rawEnabled === true
    kind.value = normalizeProxyKind(rawKind)
    host.value = String(rawHost)
    portDraft.value = String(rawPort)
    login.value = String(rawLogin)
    password.value = String(rawPassword)
    bypass.value = String(rawBypass)

    // Загрузка — не правка: напоминание о перезапуске должно появляться только после
    // действий человека, а не сразу при открытии вкладки.
    needsRestart.value = false
  } catch (e) {
    Logger('ERROR', 'Не удалось прочитать настройки прокси', e)
  }
}

/**
 * Состояние запуска. Читается из памяти процесса оболочки, сеть не трогается.
 */
async function loadStatus(): Promise<void> {
  try {
    status.value = await Bridge.proxyDiagnostics.status()
  } catch (e) {
    Logger('ERROR', 'Не удалось прочитать состояние прокси', e)
  }
}

onMounted(() => {
  if (!isDesktop) return
  void load()
  void loadStatus()
})
</script>
