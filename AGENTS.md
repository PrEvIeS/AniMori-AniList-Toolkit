<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# AniMori — Toolkit for AniList

## Purpose

Русификатор и набор инструментов для [AniList](https://anilist.co): перевод интерфейса, русские названия и описания, встроенный плеер, рейтинги MAL/Shikimori, дерево франшизы, музыкальные темы, русский поиск, перенос и сверка списков с Shikimori.

Начиная с 2.0.0 из **одной кодовой базы** собираются **два продукта**:

| Продукт | Сборка | Что это |
|---|---|---|
| Юзерскрипт для Tampermonkey | `npm run build` (`--mode userscript`) → `dist/animori.user.js` | Скрипт, работающий на `anilist.co` в браузере |
| Десктоп для Windows | `npm run tauri:build` (`--mode tauri`) → `dist/animori.tauri.js` + `.css`, вшиваемые в Rust | Приложение Tauri 2 с окном на `anilist.co` |

Вся прикладная логика общая. Различия платформ спрятаны за **мостом** (`src/bridge/`) и разводятся **на этапе сборки** через псевдопути-алиасы, а не проверками в рантайме.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Зависимости и скрипты; **единственный источник номера версии** (его читают и `vite.config.ts`, и `src-tauri/tauri.conf.json`) |
| `vite.config.ts` | Два таргета из одного входа `src/main.ts`; алиасы `@bridge-impl` / `@adblock-impl` / `@`; шапка юзерскрипта (`vite-plugin-monkey`) |
| `tsconfig.json` | `strict` + `noUncheckedIndexedAccess`; `paths` дублирует алиасы Vite фиксированной целью для тайпчекера; `src-tauri` исключён |
| `dictionary.json` | Общая база переводов интерфейса (~185 КБ). Раздаётся с `raw.githubusercontent.com`, грузится в рантайме, **в бандл не входит** |
| `README.md` | Пользовательская документация (русский): возможности, установка, источники данных, сборка |
| `CHANGELOG.md` | История версий |
| `.prettierrc.json` / `.prettierignore` | Формат кода: `npm run format` |
| `.gitattributes` | Все исходники в LF |
| `LICENSE` | MIT |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Общая кодовая база обеих сборок: TypeScript + Vue 3 + SCSS (см. `src/AGENTS.md`) |
| `src-tauri/` | Десктопная оболочка на Rust/Tauri 2, Windows и macOS (см. `src-tauri/AGENTS.md`) |
| `.github/` | CI, релиз, сторожевые прогоны, шаблоны задач (см. `.github/AGENTS.md`) |
| `assets/screenshots/` | Скриншоты для README (`home.webp`, `media.webp`, `player.webp`). Только бинарники, своего `AGENTS.md` нет |

## Форк

Этот рабочий экземпляр — **форк**:

| | |
|---|---|
| `origin` | `git@github.com:PrEvIeS/AniMori-AniList-Toolkit.git` |
| Апстрим | `foulnike/AniMori-AniList-Toolkit` |

Что из-за этого работает не так, как в апстриме, — проверь прежде, чем чинить «баг»:

- **Автообновление настроено на форк:** эндпоинт `latest.json` и `pubkey` в `src-tauri/tauri.conf.json` — ваши, релизный прогон собирает Windows и macOS. Осталось положить приватный ключ в секреты репозитория: `TAURI_SIGNING_PRIVATE_KEY` (содержимое `~/.tauri/animori.key`) и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Без них `release.yml` упадёт на шаге подписи. Приватный ключ в репозиторий не попадает никогда.
- **Ссылки внутри продукта — литералы и ведут в апстрим:** `dictionary.json` грузится с `raw.githubusercontent.com/foulnike/...` (`DICT_URL` в `src/core/constants.ts`), кнопки GitHub, GreasyFork и «отправить в общую базу» — из `src/features/ui/settings-state.ts`, шапка юзерскрипта с `downloadURL`/`updateURL` GreasyFork — из `vite.config.ts`. Меняй их осознанно и все сразу.
- **`watch-dataset.yml`** продолжит следить за апстримным `foulnike/animori-data`, но заводить задачи будет в форке.
- **`probe-titles.yml`** требует ветку `app-3.0-dev` — в форке её может не быть.
- Токен Kodik в `src/features/media/player.ts` выдан владельцу апстрима.

Апстрим как второй remote не подключён; при необходимости: `git remote add upstream git@github.com:foulnike/AniMori-AniList-Toolkit.git`.

## For AI Agents

### Working In This Directory

- **Язык.** Весь проект — комментарии, UI, README, сообщения коммитов — на русском. Пиши так же.
- **Версия поднимается только в `package.json`.** `vite.config.ts` читает её оттуда, `tauri.conf.json` ссылается через `"version": "../package.json"`. Второй источник номера заводить нельзя: GreasyFork смотрит на шапку скрипта и со старым номером молча не обновит установленные копии.
- **`docs/DECISIONS.md` в репозитории отсутствует.** Десятки комментариев ссылаются на него («РИСК №1», «дефект A2», «пункт 4.3»). Ссылки исторические — не пытайся его открыть и не переписывай комментарии из-за битой ссылки.
- **Комментарии-шапки файлов ценны.** Почти каждый модуль начинается с 3-15 строк «почему сделано именно так». Читай их перед правкой и обновляй, если меняешь причину. Не удаляй.
- **Ничего не добавляй «на всякий случай» в шапку юзерскрипта.** Лишние `@match`/`@grant`/`@connect` ломают ревю GreasyFork.
- **Правки `.gitignore` делай только UTF-8 без BOM.** В нём уже был фрагмент в UTF-16LE (`src-tauri/permissions/`, дописанный из PowerShell): NUL-байты делали файл бинарным, правило не работало ни в git, ни в индексаторе CodeGraph. Исправлено 2026-08-28; не повторяй дозапись через `echo >>` из PowerShell.

### Testing Requirements

Автоматических тестов в проекте **нет**. Проверка — тайпчек, сборка и ручной прогон:

```bash
npm run typecheck        # vue-tsc --noEmit — обязательный минимум перед любым коммитом
npm run build            # typecheck + сборка юзерскрипта в dist/animori.user.js
npm run build:tauri      # typecheck + сборка бандла для десктопа
npm run tauri:dev        # десктоп с пересборкой фронта (только Windows)
npm run format           # prettier
```

`cargo` вызывается через `npm run tauri:build`; ручной `cargo check` из `src-tauri/` тоже работает, но требует Windows-целей для `cfg(windows)`-модулей.

### Common Patterns

- **Мост, а не платформенные ветвления.** Любой доступ к хранилищу, HTTP, буферу обмена, внешним ссылкам идёт через `Bridge` из `@/bridge`. Прямых `GM_*`, `fetch()` к внешним API и `invoke()` вне `src/bridge/` быть не должно.
- **Разведение сборкой.** Модуль, который тянет платформенные пакеты или тяжёлые побочные эффекты, подставляется алиасом (`@bridge-impl`, `@adblock-impl`), потому что Rollup вправе сохранить побочный эффект даже из недостижимой ветки `if`.
- **Слои и направление зависимостей.** `utils` → `core` → `api` → `features` → `main.ts`. Ядро не знает о фичах; обратный импорт означает цикл (именно поэтому существуют `*-state.ts` рядом с точками монтирования).
- **Vue монтируется только через `mountApp()`** из `src/utils/vue-mounter.ts`. Прямой `createApp().mount()` даёт рекурсию мутаций с переводчиком и zombie-компоненты после перерисовки React'а AniList.
- **Настройки читаются в момент использования** (`settings.x`), а не копируются при импорте: импорты выполняются до `loadSettings()`.

## Dependencies

### External

- **Vue 3.5** (только Composition API; `__VUE_OPTIONS_API__: false`) — виджеты, модалки, панели
- **Vite 5** + `vite-plugin-monkey` 4 — сборка обоих таргетов и шапка юзерскрипта
- **TypeScript 5.6** + `vue-tsc` — единственная автоматическая проверка в проекте
- **Tauri 2** (`@tauri-apps/api`, плагины `http`, `store`, `clipboard-manager`) — десктоп
- **Sass** — `src/style.scss`
- **`@types/greasemonkey`** — типы GM-окружения (`GM_*` доописаны вручную в `src/vite-env.d.ts`)

### Внешние сервисы

| Хост | Назначение |
|---|---|
| `graphql.anilist.co` | Данные и списки AniList |
| `shikimori.io`, `shikimori.rip` | Русские названия, описания, персонажи, франшизы (`.rip` — зеркало) |
| `smotret-anime.online`, `anime365.ru` | Альтернативный источник тайтлов/описаний |
| `api.animethemes.moe` | Опенинги и эндинги |
| `kodik-api.com` | Плеер |
| `raw.githubusercontent.com` | `dictionary.json` |
| `github.com/foulnike/...` | Манифест автообновления (только десктоп) |

<!-- MANUAL: заметки ниже этой строки сохраняются при перегенерации -->

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
