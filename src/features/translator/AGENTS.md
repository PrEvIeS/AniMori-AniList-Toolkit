<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# translator

## Purpose

Перевод интерфейса AniList на русский: строки сайта по словарю, названия и описания тайтлов из внешних источников, имена персонажей и персонала. Самый крупный модуль проекта и его сердце — здесь живут очередь запросов, кэш, наблюдатель мутаций DOM и вся защита от рекурсии.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Конвейер: очереди `MED2` / `CHR2` / `STF3`, кэш, наблюдатель мутаций, `initTranslator()`, `registerMutationHook()`, `getPendingQueueSizes()`, `resetTranslatorRetries()` (~980 строк) |
| `rules.ts` | Чистые правила перевода без DOM, сети и кэша. Единственный экспорт — `translateAdvanced()`: даты, счётчики, сезоны, дни рождения, рейтинги, «N minutes ago», роли, единицы |
| `dom.ts` | Применение перевода к живым узлам: `translateNode()`, `safelySetText()`, `setupVueInputInterceptor()`, `cleanShikiBB()`. Константы `NO_TRANSLATE_CLASS` и `TRANSLATABLE_ATTRS` |

## For AI Agents

### Working In This Directory

- **`am-notr` — это иммунитет, а не стиль.** Всё внутри узла с этим классом переводчик не трогает. Без него Vue возвращает свой текст, переводчик снова переводит — цикл мутаций не заканчивается. Любая новая собственная разметка обязана его получить.
- **Порядок проверок в `rules.ts` менять нельзя:** правила пересекаются, решает первое совпадение. `null` означает «перевода нет, оставляем оригинал» — это не ошибка.
- **`SKIP_TAGS`** (`SCRIPT`, `STYLE`, `NOSCRIPT`, `SVG`) исключены намеренно: там текст — это код или разметка, перевод только сломает страницу.
- **Регэкспы правил живут не здесь, а в `core/constants.ts`** (`rxAgo`, `rxSeason`, `rxAct`, …). Правка правила часто означает правку двух файлов.
- **`registerMutationHook()` — единственный публичный способ подписаться на пересборку DOM.** Им пользуется `features/media`, потому что React AniList выкидывает вставленные узлы, и виджеты приходится ставить повторно, а не однократно.
- **Очередь тормозится состоянием источников:** `isAniListRateLimited()`, `isShikimoriRateLimited()`, `isAnime365RateLimited()` проверяются перед отправкой. Размеры очередей видны в логгере по фильтру `QUEUE`.
- Устройство конвейера и разбор дефектов комментарии адресуют к `docs/DECISIONS.md` — **этого файла в репозитории нет**, ссылки исторические.

### Testing Requirements

Проверяется руками и в четырёх положениях настроек: `translateInterface`, `translateTitles`, `translateCharacters`, `translateStaff` — каждая включается независимо. Обязательный сценарий регрессии: несколько переходов между страницами тайтлов подряд (проверка, что очередь не растёт бесконечно и переводы не двоятся) и страница персонажа с тёзками.

### Common Patterns

- Кэш переводов тайтлов и персон лежит в IndexedDB (`shikiCache`) с TTL `CACHE_TIME` = 90 дней.
- Повторы ограничены и сбрасываются на смене роута через `resetTranslatorRetries()` — задача зарегистрирована в `main.ts`.
- `cleanShikiBB()` чистит BB-разметку описаний Shikimori и подставляет подпись источника со ссылкой.

## Dependencies

### Internal

- `../../api/anilist`, `../../api/shikimori`, `../../api/shikimori-people`, `../../api/titles`, `../../api/anime365`
- `../../core/constants` (регэкспы, `CACHE_TIME`, `SHIKI_DOMAINS`), `../../core/db`, `../../core/dictionary`, `../../core/settings`
- `../../utils/dom`, `../../utils/logger`

### Внешние потребители

`features/media` — через `registerMutationHook()`; `main.ts` — через `initTranslator()` и `resetTranslatorRetries()`.

<!-- MANUAL: -->
