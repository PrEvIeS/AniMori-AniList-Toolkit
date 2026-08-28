<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# media

## Purpose

Всё, что AniMori добавляет на страницу тайтла. `index.ts` — каркас: определяет открытый тайтл, грузит данные AniList и Shikimori, складывает их в `MediaContext` и вызывает зарегистрированные виджеты. Виджеты — пять независимых блоков сайдбара.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Каркас страницы: `registerMediaWidget()`, `ensureMediaWidgets()`, `refreshMediaPage()`, `initMedia()`. Кэширует соответствие AniList ↔ Shikimori в `malCache` |
| `types.ts` | `MediaContext`, `MediaWidget`, `MediaAniListData`, `MediaShikiData`, `ShikiScoreStat`. Вынесены отдельно, чтобы виджеты не импортировали друг друга ради одного интерфейса |
| `player.ts` | Плеер Kodik: overlay с iframe, список озвучек с избранным, сетка эпизодов. Кнопку запуска рисует Vue-панель, виджет только сообщает ей состояние |
| `ratings.ts` | Рейтинги Shikimori, MyAnimeList и AniList с гистограммой голосов |
| `franchise.ts` | Дерево хронологии франшизы по годам со статусом из списка пользователя. Требует двух запросов, а `mount()` синхронный — готовый блок кэшируется в модуле |
| `themes.ts` | Опенинги и эндинги с поиском трека в VK Музыке, YouTube Music, Spotify, SoundCloud |
| `extlinks.ts` | Внешние ссылки: встроенные сервисы (домены из настроек) плюс свои шаблоны пользователя |

## For AI Agents

### Working In This Directory

- **Виджеты ставятся не однократно, а по подписке `registerMutationHook()`** из `features/translator`. Причина: AniList на React пересобирает разметку и выкидывает вставленные узлы. Однократная вставка даёт симптом «перешёл на страницу, блока нет».
- **Порядок регистрации задаёт порядок блоков** в сайдбаре. Он зафиксирован в `main.ts`: плеер → рейтинги → франшиза → темы → ссылки.
- **`mount()` виджета синхронный.** Данные, требующие сети, грузятся заранее в каркасе или кэшируются в модуле виджета (как во `franchise.ts`).
- **Селекторы блоков специфичны намеренно.** `.animori-franchise:not(.animori-themes):not(.animori-extlinks)` — темы и ссылки переиспользуют тот же класс ради внешнего вида; упрощение селектора ломает все три блока разом.
- **Кнопка плеера — не узел виджета.** Посторонний элемент в Vue-разметке панели терялся бы при перерисовке, поэтому `player.ts` вызывает `showPlayerButton()` / `hidePlayerButton()` из `ui/action-panel-state.ts`. Крупный вариант кнопки под обложкой стилизован в `ui/player-hero.scss`.
- **Отказ источника и пустой результат — разные исходы.** Пустой список тем молчит; отказ пишет причину, взятую из `core/net-health.ts`. Совета про VPN в виджетах нет — это дело тоста.
- **Токен Kodik зашит в `player.ts`** и выдан владельцу проекта. В форке он продолжит работать, но это чужой ключ.

### Testing Requirements

Открыть страницу аниме и страницу манги, проверить каждый блок при включённом и выключенном тумблере (`enablePlayer`, `enableRatings`, `enableFranchise`, `enableThemes`, `extlinks`). Обязательный сценарий: переход со страницы тайтла на другой тайтл **без перезагрузки** — блоки должны пересобраться под новые данные.

### Common Patterns

- Каждый виджет — объект `MediaWidget` с единственным экспортом вида `export const xxxWidget: MediaWidget`.
- `amApplyAccentToDom()` вызывается после вставки разметки: без него блок не подхватит акцентный цвет.
- Тайтл без карточки на Shikimori — штатная ситуация: франшиза молчит, об этом уже сказали рейтинги.

## Dependencies

### Internal

- `../../api/anilist`, `../../api/shikimori`, `../../api/animethemes`
- `../../core/db`, `../../core/settings`, `../../core/accent`, `../../core/net-health`, `../../core/custom-links`
- `../translator` (`registerMutationHook`), `../ui/action-panel-state`
- `@/bridge` — плеер и темы (внешние ссылки, буфер обмена)

<!-- MANUAL: -->
