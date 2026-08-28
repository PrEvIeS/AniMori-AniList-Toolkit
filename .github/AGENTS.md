<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# .github

## Purpose

Инфраструктура GitHub: выпуск релизов, сторожевые прогоны и шаблоны задач. Собственных файлов на этом уровне нет.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `workflows/` | Три прогона Actions: релиз, сторож датасета, ручная проба Shikimori (см. `workflows/AGENTS.md`) |
| `ISSUE_TEMPLATE/` | Пять форм для задач (см. `ISSUE_TEMPLATE/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- **Это форк.** `origin` указывает на `git@github.com:PrEvIeS/AniMori-AniList-Toolkit.git`; апстрим — `foulnike/AniMori-AniList-Toolkit`. Прогоны и ссылки в шаблонах написаны под апстрим и в форке работают не все — подробности в `workflows/AGENTS.md`.
- **Расписания и кнопка «Run workflow» видны только из ветки по умолчанию** (здесь `main`). Файл прогона обязан лежать в `main`, иначе его в интерфейсе не будет вовсе.
- Ссылки на GreasyFork и на репозиторий продублированы в `src/features/ui/settings-state.ts` — при правке одного места сверяйся со вторым.

### Testing Requirements

Прогоны проверяются только запуском в GitHub Actions. `probe-titles` безопасен (ничего не меняет, права только на чтение); `release` необратим — он создаёт публичный релиз.

<!-- MANUAL: -->
