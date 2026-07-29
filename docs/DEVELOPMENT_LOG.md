# Журнал разработки AniMori Desktop

> Ветка: `desktop-dev`  
> Состояние на: 30 июля 2026 года  
> Базовая проверенная ревизия перед документацией: `e2cc891`  
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

## 12. Финальная проверка

После `e2cc891`:

```text
npm run typecheck — 0 ошибок
npm run build — успешно
Vite: 10 modules transformed
dist/animori.meta.js: 1.07 kB
dist/animori.user.js: 99.16 kB (gzip 24.29 kB)
```

До подключения features Vite обрабатывал 2 модуля, а bundle был 38.02 kB. Рост до 99.16 kB подтверждает реальное включение scanner/exporter.

## 13. Инструментальные решения

- Prettier: `semi: false`, `singleQuote: true`, `printWidth: 100`.
- Монолит и крупные data files исключены из форматирования.
- `npm audit fix --force` не применялся из-за риска неконтролируемого major upgrade.
- Из-за отсутствия DNS в sandbox часть build-проверок выполнялась на машине разработчика.
- Временная GitHub Actions automation аудита не запускалась от push интеграции и была полностью удалена вместе с payload.

## 14. Состояние этапа 1

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
- [x] clean typecheck/build.

### Осталось

- [ ] `src/features/translator/`;
- [ ] `src/features/media/`;
- [ ] `src/features/search/` и dictionary capture;
- [ ] UI logger через `registerLogSink()`;
- [ ] полноценный bootstrap: settings, IndexedDB, translator, SPA lifecycle;
- [ ] удалить `GM_addStyle` grant после проверки runtime dependencies;
- [ ] проверить `src/_extracted_style.css`;
- [ ] удалить лишние `.gitkeep`;
- [ ] исправить `THEMES_` против `THEMES2_`;
- [ ] browser smoke-tests scanner/exporter.

## 15. Обязательные риски

Подробности: [`AUDITION.md`](./refactoring/AUDITION.md).

1. Асинхронное Tauri storage: UI ждёт `await bridge.storage.getAll()`.
2. Rust HTTP не получает cookies WebView автоматически.
3. React может уничтожать Vue widgets: нужен `unmount()` и remount.
4. Vue roots исключаются из MutationObserver translator.
5. Linux WebKitGTK может требовать GStreamer H.264/AAC codecs.
6. Desktop logger требует ring buffer и streaming в файл.

## 16. Следующий шаг

Продолжить этап 1 с `src/features/translator/`:

1. извлечь `initTranslator()` и связанные функции;
2. сохранить `.am-notr` guard;
3. использовать `core/dictionary.ts`;
4. отделить translation logic от observer/lifecycle;
5. типизировать DOM traversal без `any`;
6. подключить к bootstrap после чистого typecheck/build;
7. зафиксировать отдельным атомарным commit.

---

Журнал обновляется после каждого завершённого блока: коммиты, решения, риски, проверки и следующий шаг.
