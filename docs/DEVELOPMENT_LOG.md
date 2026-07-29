# Журнал разработки AniMori Desktop

> Ветка: `desktop-dev`  
> Состояние на: 30 июля 2026 года  
> Базовая проверенная ревизия: `9efefe5`  
> Версия: `1.9.1`

## Назначение

Журнал фиксирует фактически выполненные работы по переходу от монолитного userscript к типизированной модульной кодовой базе для userscript и будущего Tauri-приложения.

Исходный план находится в [`docs/refactoring`](./refactoring/):

- [`MANIFEST.md`](./refactoring/MANIFEST.md) — цели AniMori 2.0;
- [`RM1.md`](./refactoring/RM1.md) — Vite, TypeScript и декомпозиция;
- [`RM2.md`](./refactoring/RM2.md) — Vue 3;
- [`RM3.md`](./refactoring/RM3.md) — Bridge/Adapter;
- [`RM4.md`](./refactoring/RM4.md) — Tauri 2;
- [`AUDITION.md`](./refactoring/AUDITION.md) — архитектурные риски.

## 1. Исходное состояние

До рефакторинга проект представлял собой рабочий `animori.user.js` версии 1.9.1:

- один IIFE-монолит примерно на 4658 строк;
- инлайновые стили через `GM_addStyle`;
- глобальное состояние;
- прямые вызовы `GM_*`, AniList GraphQL и Shikimori REST;
- IndexedDB, переводчик, логгер, сканер, экспортер и медиа-виджеты в одном файле;
- `@ts-nocheck` и JSDoc вместо строгой TypeScript-сборки.

До завершения этапа 1 монолит сохраняется как read-only источник истины.

## 2. Ветка и сборочный каркас

Создана ветка `desktop-dev` — Git не допускает пробел в имени `desktop dev`.

### `eb00d25` — Vite + TypeScript

Созданы:

- Vite 5 и `vite-plugin-monkey`;
- TypeScript strict mode и `noUncheckedIndexedAccess`;
- SCSS;
- структура `src/core`, `src/utils`, `src/api`, `src/features`;
- режим userscript и задел под режим Tauri;
- асинхронный `bootstrap()`;
- конфигурация userscript metadata в `vite.config.ts`.

## 3. Ядро и инфраструктура

### `47595c9`

Из монолита вынесены:

- `src/core/constants.ts` — окружение, домены, TTL, БД, даты и regex;
- `src/core/settings.ts` — типизированные настройки;
- `src/core/accent.ts` — акцентные темы;
- `src/utils/logger.ts` — Logger, `safeCall`, error handlers, `registerLogSink()`;
- `src/utils/dom.ts` — escapeHTML, безопасные templates, marquee, clipboard, plural helpers;
- декларации Greasemonkey API.

UI логгера отложен до `LoggerModal.vue` на этапе 2.

## 4. Защита монолита от форматирования

Общий запуск Prettier (`6e2f560`) случайно переформатировал рабочий монолит и создал неприемлемый diff.

- `267e522` — добавлены `.prettierignore` и `.gitattributes`;
- `b08f753` — монолит восстановлен;
- `animori.user.js`, `dictionary.json`, `package-lock.json` исключены из форматирования;
- для монолита отключено преобразование переводов строк Git.

## 5. Стили

### `972803c`

Инлайновый `GM_addStyle` перенесён в `src/style.scss`. Сохранены классы модалок, сканера, экспортера, плеера, рейтингов, франшизы, тем, логгера и словаря. Стили подключаются через Vite.

## 6. Типы, IndexedDB и API

### `cb6d9f5`

Добавлены:

- `src/core/types.ts` — TypeScript-интерфейсы вместо JSDoc typedef;
- `src/core/db.ts` — IndexedDB migrations, get/set, clear, GC и статистика;
- `src/api/anilist.ts` — GraphQL и токен;
- `src/api/shikimori.ts` — REST и зеркала;
- `src/api/anime365.ts` — API, backoff и session-disable;
- `src/api/animethemes.ts`;
- `src/api/titles.ts` — выбор источника названия.

Rate-limit counters и экземпляр IndexedDB стали приватными состояниями модулей.

### Ошибка сборки URL

При переносе шаблонные URL получили лишние фигурные скобки.

- `1306f00` — введён `mirrorUrl()` и безопасная конкатенация;
- `1b6d52d` — форматирование после исправления.

## 7. Матчинг имён и Shikimori People

### `5abc6fc`

- `src/utils/name-match.ts` — нормализация и score matching;
- `src/api/shikimori-people.ts` — поиск персон и сопоставление внутри тайтла.

Сохранены пороги исходного алгоритма и защита от тёзок. Обработка 429 приведена к безопасным исключениям.

### `3551a83`

Применён Prettier.

## 8. Словарь и custom links

### `dd4dede`

- `src/core/dictionary.ts` — remote/user dictionary, merge, CRUD и callback повторного перевода;
- `src/core/custom-links.ts` — пользовательские ссылки и палитра.

Глобальные переменные IIFE стали приватным состоянием модулей.

### `479bc01`

Применён Prettier. Базовое ядро этапа 1 завершено.

## 9. Scanner

### `b2cddff`

Создан `src/features/scanner/index.ts`:

- anime/manga списки Shikimori и AniList;
- избранное;
- нормализация статусов/оценок;
- сравнение по MAL ID;
- категории расхождений и глубокая проверка каталогов;
- приблизительный name matching персонажей и staff;
- ignore-list;
- compare modal;
- read-only режим.

После Prettier обнаружилось 23 strict TypeScript errors. Исправление прошло итерациями `23 → 4 → 1 → 0`.

Основные исправления:

- `ShikiStatus` и типизированный `AL_STATUS_MAP`;
- guards для отсутствующего `media`;
- generic `ShikiRateItem<T>`;
- отдельные diff item types;
- безопасная индексация при `noUncheckedIndexedAccess`;
- generic ignore filtering;
- безопасное чтение `Viewer`;
- замена проблемного reduce над union-массивами.

Коммиты:

- `891fb34` — Prettier;
- `4c4824c` — 0 ошибок типизации.

## 10. Exporter Shikimori → AniList

### `b3d919e`

Создан `src/features/exporter/index.ts`:

- anime/manga list export;
- MAL ID → AniList ID;
- статусы и score formats;
- progress, volumes, repeats и notes;
- частичная конвертация BBCode → Markdown;
- даты из Shikimori history;
- favorites anime/manga/characters/staff;
- export modal и URL авторизации AniList.

При строгой типизации исправлены 15 ошибок, затем одна оставшаяся ошибка `noUncheckedIndexedAccess`.

## 11. Повторный аудит Scanner и Exporter

Code review показал, что чистый `tsc` не гарантировал корректное runtime-поведение.

В `4b9550a` и `e2cc891` реализованы:

- GraphQL `errors` AniList отклоняются даже при HTTP 200;
- полный сбой зеркал Shikimori не маскируется под пустой ответ;
- exporter считает failed mutations и показывает partial completion;
- `progressVolumes = 0` отправляется и очищает старое значение;
- history keys разделены как `anime:malId` / `manga:malId`;
- Shikimori login проходит `encodeURIComponent`;
- exporter защищён от повторной инициализации;
- scanner ignore keys разделены: positive для anime, negative для manga;
- scanner/exporter подключены к `main.ts` и production bundle;
- добавлен launcher compare modal на AniList;
- Vite настроен на alias `@`;
- добавлены `@types/node` и Node types для Vite config.

## 12. Translator

Переводчик интерфейса вынесен из монолита (строки 2502-3060) и разделён на три файла, чтобы правила перевода, работа с DOM и lifecycle не были связаны между собой.

### `6d1bfee` — rate-limit getters

В `src/api/anilist.ts` и `src/api/shikimori.ts` добавлены `isAniListRateLimited()`, `pauseAniList()`, `isShikimoriRateLimited()` и `pauseShikimori()`. Сами счётчики остались приватными: очередь перевода читает состояние через функции, а не через глобальные переменные.

### `dc5349e` — bootstrap

`src/main.ts` пересобран в строгом порядке: `loadSettings()` → exporter на Shikimori → выход вне AniList → scanner launcher → проверка необходимости переводчика → `openDB()` → загрузка словаря → `rebuildDictionary()` → `initTranslator()`.

Добавлен `loadInterfaceDictionary()`, который никогда не отклоняется: недоступный remote dictionary логируется, но не блокирует запуск остального скрипта.

### `8cd3b9f` — сам переводчик

- `src/features/translator/rules.ts` (319 строк) — чистые правила перевода строк: единственный экспорт `translateAdvanced()`, без DOM и без сети;
- `src/features/translator/dom.ts` (144 строки) — `translateNode()`, `safelySetText()`, `setupVueInputInterceptor()`, `cleanShikiBB()` и константа `am-notr`;
- `src/features/translator/index.ts` (638 строк) — очередь, кэш IndexedDB, batching AniList/Shikimori и MutationObserver.

### Отличия от монолита

Все отличия сознательные. В нормальном сценарии поведение совпадает с 1.9.1; большинство правок затрагивает только аварийные ветки, которые в монолите не были покрыты.

1. Каждый элемент batch обрабатывается в `try/catch`. Одна ошибка сети больше не останавливает всю очередь перевода.
2. Неизвестные ключи месяцев, дней, сезонов и единиц времени возвращают оригинальный текст вместо `undefined` в вёрстке.
3. Оригинальное описание AniList внутри `<details>` помечено `am-notr` и не переводится повторно.
4. `window.ensureWidgets` заменён на `registerMutationHook()`, `globalPendingQueues` — на `getPendingQueueSizes()`, флаг `activeRound` стал переменной модуля. Глобальных точек связи больше нет.
5. Сборка ссылки на страницу персоны исправлена: в монолите был тот же дефект шаблонного URL, что чинил `1306f00`.
6. `pending.CHR2` и `pending.STF3` упрощены с `Map` до `Set<number>`.

### Проверка правил

До push правила прогнаны через изолированный smoke-скрипт на 29 реальных строках AniList, например `"Ep 5 airing in 2 days"` → `"5 серия выйдет через 2 дня"`, `"Mon Jan 15 2024"` → `"Пн, 15 января 2024 г."`, `"8.5"` → `null`. Скрипт оставлен вне репозитория: он требует заглушек для `core/*` и не является полноценным тестовым каркасом.

### Инцидент неполного push

Два первых пакетных push довезли только часть файлов без какой-либо ошибки. В результате `main.ts` некоторое время ссылался на несуществующий `./features/translator`, и ветка временно не собиралась.

Правило на будущее: крупные файлы отправлять по одному за вызов и после push проверять содержимое каталога на ветке.

## 13. Медиа-страница

Медиа-виджеты монолита (строки 3061-3733) переносятся тремя частями, чтобы каждый push оставался проверяемым:

1. каркас и подписка на изменения DOM;
2. плеер Kodik;
3. рейтинги, франшиза, музыкальные темы и внешние ссылки.

### `a83f595` и `6efaf4f` — часть 1 из 3

- `src/features/media/types.ts` (61 строка) — `MediaAniListData`, `MediaShikiData`, `MediaContext` и контракт `MediaWidget`. Только типы: виджеты не импортируют друг друга ради общих интерфейсов.
- `src/features/media/index.ts` (223 строки) — жизненный цикл страницы: разбор роута, очистка при смене тайтла, однократная загрузка данных AniList и Shikimori через кэш, реестр виджетов и `ensureMediaWidgets()`.

Экспорты: `registerMediaWidget()`, `ensureMediaWidgets()`, `initMedia()`.

Файлы намеренно не подключены к `main.ts`: каркас без виджетов не выполняет работы. Wiring выполняется в части 2 вместе с плеером, поэтому bundle остался на 19 модулях и 144.91 kB. Typecheck при этом покрывает новые файлы, так как корневой `tsconfig.json` включает весь `src`.

### Отличия от монолита — каркас

1. Вместо глобальной `window.ensureWidgets` используется подписка `registerMutationHook()` из translator. Внешний код больше не может перезаписать точку восстановления виджетов.
2. Каждый виджет монтируется в собственном `try/catch`. Ошибка одного блока не убирает со страницы остальные, как это происходило в монолите.
3. Добавлен флаг `isLoading`: параллельные загрузки по одному тайтлу больше не наслаиваются, данные предыдущего тайтла не попадают на страницу следующего.
4. Очистка виджетов декларативна: селекторы объявляет сам виджет в `cleanupSelectors`, а не хардкод-список в функции загрузки.
5. Уход со страницы тайтла теперь тоже обрабатывается: состояние сбрасывается, отложенные виджеты не всплывают на списках и профиле.
6. `MediaContext.sidebar` перечитывается при каждом монтировании, так как React заменяет узел сайдбара при переходах.

### `2c5820d` и `9efefe5` — часть 2 из 3: плеер Kodik

- `src/features/media/player.ts` (428 строк) — кнопка `#ru-player-btn`, overlay `#ru-player-overlay`, панель озвучек с избранными, сетка эпизодов с подсветкой просмотренных, бегущая строка заголовка и fallback на `find-player`.
- `src/main.ts` — после `initTranslator()` вызываются `registerMediaWidget(playerWidget)` и `initMedia()`. Медиа-модуль живёт на наблюдателе translator, поэтому порядок жёсткий.

Ответ Kodik `/search` типизирован без `any`: `KodikSearchItem`, `KodikSearchResponse` и нормализованный `Translation`.

### Отличия от монолита — плеер

1. Контейнер `#animori-actions` в монолите создавался UI настроек (строка 4213), который ещё не вынесен. Плеер создаёт контейнер сам, если его нет; будущий UI настроек переиспользует тот же узел.
2. Проверка `getAlToken()` заменена безусловным запросом прогресса в `try/catch`. Без авторизации плеер открывается как обычно, только без подсветки просмотренных серий.
3. Слушатель событий плеера больше не хранится в `window.__amKodikSync`: это переменная модуля, слушатель всегда ровно один.
4. Обработчик кнопки перевешивается только при смене тайтла (`dataset.amMediaId`), а не на каждом вызове `mount()`.
5. Номера эпизодов из `seasons` сортируются числово и фильтруются от мусора; озвучки дедуплицируются через `Map` по названию.
6. Seamless-смена серии через `postMessage` сохранена и дополнительно обёрнута в `try/catch`.

РИСК №5 из AUDITION.md остаётся открытым: в Tauri на Linux (WebKitGTK) плеер может дать чёрный экран без GStreamer H.264/AAC. В userscript-режиме проблема не проявляется.

## 14. Финальная проверка

После `e2cc891`:

```text
npm run typecheck — 0 ошибок
npm run build — успешно
Vite: 10 modules transformed
dist/animori.meta.js: 1.07 kB
dist/animori.user.js: 99.16 kB (gzip 24.29 kB)
```

После `8cd3b9f`, проверено на машине разработчика:

```text
npm run typecheck — 0 ошибок
npm run build — успешно
Vite: 19 modules transformed
dist/animori.meta.js: 1.07 kB
dist/animori.user.js: 144.91 kB (gzip 37.14 kB)
npm run format — все файлы unchanged
```

Рост 10 → 19 модулей и 99.16 → 144.91 kB подтверждает реальное включение translator в bundle.

После `6efaf4f`, проверено на машине разработчика:

```text
npm run typecheck — 0 ошибок
npm run build — успешно
Vite: 19 modules transformed
dist/animori.user.js: 144.91 kB (gzip 37.14 kB)
```

Неизменный размер ожидаем: каркас медиа-модуля ещё не подключён к точке входа.

После `9efefe5`, проверено на машине разработчика:

```text
npm run typecheck — 0 ошибок
npm run build — успешно
Vite: 22 modules transformed
dist/animori.meta.js: 1.07 kB
dist/animori.user.js: 162.08 kB (gzip 41.88 kB)
git status — working tree clean
```

Рост 19 → 22 модулей и 144.91 → 162.08 kB подтверждает, что медиа-модуль и плеер реально попали в bundle.

## 15. Инструментальные решения

- Prettier: `semi: false`, `singleQuote: true`, `printWidth: 100`.
- Монолит и крупные data files исключены из форматирования.
- `npm audit fix --force` не применялся из-за риска неконтролируемого major upgrade.
- Из-за отсутствия DNS в sandbox часть build-проверок выполнялась на машине разработчика.
- Временная GitHub Actions automation аудита не запускалась от push интеграции и была полностью удалена вместе с payload.
- Sandbox TypeScript новее репозиторного `^5.6.2` и не принимает `baseUrl`. Корневой `tsconfig.json` не правился; обход делался только в черновом каталоге.
- Машина разработчика работает в Windows PowerShell: POSIX-флаги вида `ls -la` недоступны, в инструкциях используется `Get-ChildItem` или `dir`.

## 16. Состояние этапа 1

### Завершено

- [x] Vite/TypeScript/vite-plugin-monkey;
- [x] userscript metadata;
- [x] SCSS;
- [x] constants/settings/accent;
- [x] DOM utilities и logger core;
- [x] IndexedDB и types;
- [x] AniList/Shikimori/anime365/AnimeThemes API;
- [x] title resolver;
- [x] name matching и Shikimori people;
- [x] dictionary и custom links;
- [x] scanner;
- [x] exporter;
- [x] scanner/exporter wiring;
- [x] hardening audit;
- [x] `src/features/translator/`;
- [x] translator wiring в `main.ts`;
- [x] чистые typecheck/build с translator;
- [x] `src/features/media/` часть 1: каркас, типы и подписка;
- [x] `src/features/media/` часть 2: плеер Kodik;
- [x] media wiring в `main.ts` и подтверждённый рост bundle.

### Осталось

- [ ] `src/features/media/` часть 3: рейтинги, франшиза, темы, внешние ссылки;
- [ ] `src/features/search/` и dictionary capture;
- [ ] UI logger через `registerLogSink()`;
- [ ] полноценный bootstrap: SPA lifecycle, URL polling, garbage collector;
- [ ] удалить `GM_addStyle` grant после проверки runtime dependencies;
- [ ] проверить `src/_extracted_style.css`;
- [ ] удалить лишние `.gitkeep`, включая `src/features/translator/.gitkeep`;
- [ ] удалить случайно закоммиченные `exporter-block.txt` и `scanner-current.txt` (коммит `71fb01e`) и добавить их в `.gitignore`;
- [ ] исправить `THEMES_` против `THEMES2_`: `getDbStats` всегда показывает 0 тем;
- [ ] browser smoke-tests scanner/exporter/translator/плеера.

## 17. Обязательные риски

Подробности: [`AUDITION.md`](./refactoring/AUDITION.md).

1. Асинхронное Tauri storage: UI ждёт `await bridge.storage.getAll()`.
2. Rust HTTP не получает cookies WebView автоматически.
3. React может уничтожать Vue widgets: нужен `unmount()` и remount. Точка восстановления для userscript-режима — `ensureMediaWidgets()` в `features/media/index.ts`.
4. Vue roots исключаются из MutationObserver translator: константа `am-notr` теперь живёт в `translator/dom.ts` и должна использоваться всеми Vue-компонентами этапа 2.
5. Linux WebKitGTK может требовать GStreamer H.264/AAC codecs. Касается плеера Kodik из `media/player.ts`.
6. Desktop logger требует ring buffer и streaming в файл.

## 18. Следующий шаг

Часть 3 из 3 медиа-модуля (строки 3097-3530 монолита). Разбивается на четыре виджета, каждый со своими `cleanupSelectors` и отдельным файлом:

1. `ratings.ts` — бейджи Shikimori/MAL/AniList и гистограмма оценок;
2. `franchise.ts` — хронология франшизы со статусами списка и ветками Shiki-only;
3. `themes.ts` — музыкальные темы OP/ED и выбор музыкального сервиса, включая исправление префикса кэша `THEMES_`/`THEMES2_`;
4. `extlinks.ts` — внешние ссылки и пользовательские сервисы.

После каждого виджета — регистрация в `main.ts`, чистые typecheck/build на машине разработчика и отдельный атомарный commit.

---

Журнал обновляется после каждого завершённого блока: коммиты, решения, риски, проверки и следующий шаг.
