<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# core

## Purpose

Ядро приложения: состояние и инфраструктура, от которых зависят `api/` и `features/`, но которые сами не знают ни о фичах, ни о Vue, ни о конкретных хостах. Настройки, константы, кэш IndexedDB, словарь, привязка к SPA-навигации, учёт доступности источников и общие типы данных.

## Key Files

| File | Description |
|------|-------------|
| `settings.ts` | `AniMoriSettings`, дефолты, `loadSettings()`, `saveSetting()`. Объект `settings` — единственный носитель пользовательских настроек |
| `constants.ts` | Неизменяемые значения: `IS_ANILIST`/`IS_SHIKI`, `DICT_URL`, списки зеркал `SHIKI_DOMAINS`/`ANIME365_DOMAINS`, `CACHE_TIME` (90 дней), `DB_NAME`/`DB_VERSION`, месяцы/дни/сезоны и ~25 регэкспов переводчика (`rx*`) |
| `types.ts` | Формы данных AniList и Shikimori: `AniListMedia`, `ShikiMedia`, `ShikiStatus`, записи кэша, `CmpListEntry` для сканера |
| `db.ts` | IndexedDB `AniMoriSuperDB` v5: `openDB()`, `dbGet()`, `dbSet()`, `clearCache()`, `runGarbageCollector()`, `getDbStats()`. Хранилища: `shikiCache`, `malCache`, `franchiseCache` |
| `dictionary.ts` | Итоговый словарь = удалённая база + правки пользователя. Синхронное чтение, `rebuildDictionary()`, `upsertUserDictEntry()`, коллбэк ре-перевода DOM |
| `lifecycle.ts` | SPA-навигация: перехват History API плюс страховочный пулинг адреса. `registerRouteTask()`, `registerShutdownTask()`, `initLifecycle()` |
| `net-health.ts` | Учёт исходов запросов по источникам: `reportStatus()`, `reportError()`, `listHealth()`, `looksLikeOutage()`, подписка. Состояния: `ok` / `unreachable` / `forbidden` / `serverError` |
| `accent.ts` | Акцентные темы тулкита: 8 пресетов + свой цвет, переопределение `--am-accent` на `documentElement` |
| `custom-links.ts` | Свои внешние ссылки пользователя: `{ name, url, color }`, шаблоны `{ru}` / `{romaji}` / `{query}` |
| `proxy.ts` | Конфигурация прокси WebView2 (только десктоп): `ProxyConfig`, `PROXY_KEYS`, `proxyUrl()`, `proxyBypassList()`. Чистый модуль без импорта моста |

## For AI Agents

### Working In This Directory

- **`settings.x` читается в момент использования, а не копируется при импорте.** Импорты выполняются до `loadSettings()`, там всегда лежат дефолты. Это же правило заставило `api/titles.ts` читать настройки внутри функции.
- **`utils/logger` импортирует `core/settings`,** поэтому в самом `settings.ts` логгер недоступен — иначе цикл.
- **`core/proxy.ts` не имеет права импортировать `@/bridge`:** его тянет и мост, и прикладной код. Ключи прокси лежат там, а не в `settings.ts`, именно поэтому.
- **`net-health.ts` не знает ни одного имени хоста.** Такой список устаревает за неделю. Идентификатор и человекочитаемый ярлык источника задаёт вызывающий клиент из `api/`.
- **Поднятие `DB_VERSION`** требует новой миграции в `db.ts`; старые версии базы у пользователей живут годами.
- **Правка регэкспов в `constants.ts`** меняет поведение `features/translator/rules.ts` — порядок проверок там значим, решает первое совпадение.

### Testing Requirements

`npm run typecheck`. Правки `db.ts` проверяются на **существующей** базе (открыть приложение со старым профилем), правки `lifecycle.ts` — переходами между разнотипными страницами AniList без перезагрузки.

### Common Patterns

- Отказ подсистемы ядра не фатален: `openDB()` возвращает `null`, и потребители кэша работают без него.
- Асинхронное хранилище + синхронный геттер: кэш в памяти (`userDictCache`, список своих ссылок, токен в `api/anilist.ts`). Иначе UI пришлось бы строить асинхронно.
- Задачи роута регистрируются по имени и выполняются в порядке регистрации; задачи выключения — в обратном.

## Dependencies

### Internal

- `@/bridge` — хранилище для `settings`, `dictionary`, `custom-links`
- `../utils/logger` — везде, кроме `settings.ts`

### External

Нет. Ядро намеренно свободно от Vue и от платформенных пакетов.

<!-- MANUAL: -->
