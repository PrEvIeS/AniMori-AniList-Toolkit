<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# bridge

## Purpose

Абстракция платформы: **что** умеет среда, но не **как**. Единственное место в проекте, где встречаются `GM_*` и `@tauri-apps/*`. Весь остальной код импортирует только `@/bridge` и получает объект `Bridge`, реализующий `IBridge`.

Подсистемы контракта ровно пять: `storage`, `http`, `clipboard`, `shell`, `proxyDiagnostics`. Расширять список без нужды нельзя — каждая новая подсистема требует двух реализаций.

## Key Files

| File | Description |
|------|-------------|
| `IBridge.ts` | Контракт: `IStorage`, `IHttp`, `IClipboard`, `IShell`, `IProxyDiagnostics`, типы запроса/ответа и класс `BridgeHttpError`. Единственный исполняемый код здесь — этот класс: обе реализации бросают одно и то же |
| `MonkeyBridge.ts` | Реализация поверх API менеджера юзерскриптов. `parseRawHeaders()`, обёртки `GM_xmlhttpRequest`/`GM_setValue`/`GM_getValue`/`GM_setClipboard` |
| `TauriBridge.ts` | Реализация для десктопа: `LazyStore` (`animori-settings.json`), `plugin-http` с прокси и `basicAuth`, `plugin-clipboard-manager`, `invoke` собственных команд |
| `TauriProxyDiagnostics.ts` | `IProxyDiagnostics` для десктопа. Вынесен из `TauriBridge.ts` ради размера; импортируется только оттуда |
| `index.ts` | Единственная публичная точка: реэкспорт типов и `export { platformBridge as Bridge } from '@bridge-impl'` |

## For AI Agents

### Working In This Directory

- **Инвариант 1: код вне `src/bridge/` импортирует только `'@/bridge'`.** Прямой импорт `TauriBridge` утащил бы пакеты `@tauri-apps/*` в бандл юзерскрипта.
- **Выбор реализации делает сборка, а не рантайм.** Ветвление по `__ANIMORI_PLATFORM__` не годится: `TauriBridge` создаёт `LazyStore` на верхнем уровне модуля, и Rollup вправе сохранить этот побочный эффект даже из недостижимой ветки. Разводит алиас `@bridge-impl` в `vite.config.ts`.
- **Тайпчекеру нужна одна фиксированная цель:** `tsconfig.json` указывает `@bridge-impl` на `MonkeyBridge`. На проверку это не влияет — обе реализации объявлены как `IBridge` и проверяются по отдельности.
- **Прикладной логики здесь быть не должно.** Зеркала, повторы, ограничитель темпа, трактовка HTTP-кодов («403 — блокировка, а не пустота») живут в `src/api/`. Мост знает только про HTTP.
- **`storage` асинхронный всегда, включая браузер.** `GM_getValue` синхронен, но контракт приведён к худшему случаю. К моменту разрешения промиса значение обязано быть на диске, а не в отложенной записи.

### Testing Requirements

Правка контракта требует прогона обеих сборок: `npm run build` и `npm run build:tauri`. Расхождение сигнатур реализаций ловится тайпчеком, а вот расхождение *поведения* — нет; проверяй руками сценарий, который правил.

### Common Patterns

- `BridgeHttpError` с `kind: 'network' | 'timeout' | 'abort'` — единственный способ отличить сорт сетевого отказа; HTTP-статус ошибкой не считается и приходит обычным `HttpResponse`.
- `credentials: 'omit'` в юзерскрипте реализуется полем `anonymous` GM-запроса. Greasemonkey 4 его игнорирует и шлёт куки — предупреждение об этом есть в `MonkeyBridge`.
- `proxyDiagnostics` в юзерскрипте — заглушки: прокси есть только у десктопа.

## Dependencies

### Internal

- `@/core/proxy` — `TauriBridge` берёт оттуда `PROXY_KEYS`, `DEFAULT_PROXY`, `proxyUrl()`, `proxyBypassList()`. `core/proxy.ts` намеренно не импортирует `@/bridge`, иначе вышел бы цикл.

### External

- `@tauri-apps/api/core`, `@tauri-apps/plugin-http`, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-clipboard-manager` — только в `TauriBridge.ts` / `TauriProxyDiagnostics.ts`
- GM-API — только в `MonkeyBridge.ts`

<!-- MANUAL: -->
