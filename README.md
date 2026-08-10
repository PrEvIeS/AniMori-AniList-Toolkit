<div align="center">

<img src="https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/src-tauri/icons/128x128@2x.png" width="128" alt="AniMori">

# AniMori — Toolkit for AniList

**Русификатор и набор инструментов для [AniList](https://anilist.co) — перевод интерфейса, плеер, рейтинги, дерево франшиз, экспорт и сравнение списков с Shikimori.**

[![Релиз](https://img.shields.io/github/v/release/foulnike/AniMori-AniList-Toolkit?style=flat-square&logo=github&logoColor=white&label=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7&labelColor=0B1622&color=02A9FF)](https://github.com/foulnike/AniMori-AniList-Toolkit/releases/latest)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-%D1%83%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%B8%D1%82%D1%8C-02A9FF?style=flat-square&logo=javascript&logoColor=white&labelColor=0B1622)](https://greasyfork.org/ru/scripts/572948-animori-anilist-toolkit)
[![Windows](https://img.shields.io/badge/Windows-%D1%81%D0%BA%D0%B0%D1%87%D0%B0%D1%82%D1%8C-02A9FF?style=flat-square&logo=tauri&logoColor=white&labelColor=0B1622)](https://github.com/foulnike/AniMori-AniList-Toolkit/releases/latest)
[![Лицензия](https://img.shields.io/badge/%D0%BB%D0%B8%D1%86%D0%B5%D0%BD%D0%B7%D0%B8%D1%8F-MIT-02A9FF?style=flat-square&labelColor=0B1622)](LICENSE)

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-CE422B?style=flat-square&logo=rust&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue%203-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri%202-FFC131?style=flat-square&logo=tauri&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Sass](https://img.shields.io/badge/Sass-CC6699?style=flat-square&logo=sass&logoColor=white)

![Windows](https://img.shields.io/badge/Windows%2010%2F11-0078D4?style=flat-square&logo=windows&logoColor=white)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-00485B?style=flat-square&logo=tampermonkey&logoColor=white)

[Возможности](#возможности) · [Установка](#установка) · [Авторизация](#авторизация-для-экспорта-и-редактирования-списков) · [Сборка](#сборка-из-исходников)

</div>

---

**AniMori** превращает AniList в удобный для русскоязычного зрителя сервис: переводит интерфейс, подтягивает русские названия и описания с Shikimori и anime365, встраивает плеер, показывает рейтинги MAL и Shikimori, строит дерево хронологии франшизы, переносит списки из Shikimori в AniList и сравнивает списки двух площадок.

Начиная с версии **2.0.0** проект существует в двух видах, которые собираются из одной кодовой базы и делят всю логику целиком:

- **Пользовательский скрипт** для Tampermonkey — в вашем браузере.
- **Настольное приложение для Windows** — отдельная программа с окном AniList: ни браузер, ни менеджер скриптов не нужны.

AniMori — неофициальный проект и не связан с командой AniList.

## Как выглядит

<div align="center">

<img src="https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/assets/screenshots/home.webp" width="900" alt="Каталог AniList с переведённым интерфейсом и русскими названиями">

</div>

<details>
<summary><b>Страница аниме</b> — русское описание с указанием источника, рейтинги, музыкальные темы, дерево франшизы, внешние ссылки</summary>
<br>
<div align="center">
<img src="https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/assets/screenshots/media.webp" width="900" alt="Страница аниме с блоками AniMori">
</div>
</details>

<details>
<summary><b>Плеер</b> — выбор озвучки с избранным и переключение серий без перезагрузки страницы</summary>
<br>
<div align="center">
<img src="https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/assets/screenshots/player.webp" width="900" alt="Встроенный плеер с панелями озвучек и эпизодов">
</div>
</details>

## Что выбрать

| | Скрипт | Приложение |
| :--- | :---: | :---: |
| Все возможности тулкита | да | да |
| Работает в вашем браузере, рядом с остальными вкладками | да | нет |
| Автообновление | да | да |
| Запросы в обход ограничений браузера | нет | да |
| Блокировка рекламы в плеере | нет | да |
| Платформы | любой браузер с Tampermonkey | только Windows |

## Возможности

### На AniList (`anilist.co`)

- **Перевод интерфейса** — строки сайта переводятся по словарю `dictionary.json`.
- **Русские тайтлы и описания** — названия и синопсисы подтягиваются с Shikimori или anime365 с указанием источника и ссылкой на него; основной источник и фоллбэк выбираются в настройках.
- **Перевод персонажей и персонала** — имена с Shikimori, с сопоставлением записей с AniList.
- **Аниме-плеер** — встроенный плеер с выбором озвучки и серий (Kodik).
- **Рейтинги MAL и Shikimori** — оценки MyAnimeList и Shikimori рядом с оценкой AniList.
- **Дерево франшизы** — хронология связанных тайтлов (включая записи, которых нет на AniList, — со стороны Shikimori).
- **Музыкальные темы** — опенинги и эндинги с поиском в VK Музыке, YouTube Music, Spotify и SoundCloud.
- **Русский поиск** — поиск по русским названиям для аниме, манги, **персонажей и персонала**.
- **Внешние ссылки** — быстрый переход на RuTracker, YummyAnime, AnimeGO, MangaLib (домены настраиваются) плюс **свои ссылки** с URL-шаблонами и плейсхолдерами `{ru}` / `{romaji}` / `{query}`.
- **Сравнение списков Shikimori ⇄ AniList** — сканер расхождений: сводная статистика, поимённые различия по статусу, оценке, прогрессу, пересмотрам и заметкам, сравнение избранного (аниме, манга, персонажи, персонал), детект связанных сезонов и игнор-лист.
- **Импорт списка Shikimori → AniList** — перенос аниме, манги, избранного и точных дат просмотров в AniList (требуется токен AniList).

### Только в приложении

- **Запросы мимо страницы** — обращения к API идут через процесс программы, а не из вкладки: ограничения CORS их не касаются, и доступны источники, до которых браузер не дотягивался.
- **Блокировщик рекламы** — отключён по умолчанию и включается вручную. Один переключатель закрывает две задачи: баннеры самого AniList прячутся стилями, а рекламные запросы внутри кадра плеера отсекаются на уровне движка окна. Заблокированные домены видны в логгере.
- **Без всплывающих окон плеера** — клики по видео не открывают рекламные вкладки.
- **Автообновление** — при запуске программа сверяется с последним релизом и предлагает обновиться; загрузка, установка и перезапуск происходят сами. Пакет проверяется по цифровой подписи.
- **Нативная навигация** — стрелки «назад/вперёд» и сочетания `Alt+←` / `Alt+→`, перезагрузка страницы, внешние ссылки уходят в браузер по умолчанию.

### Прочее

- **Локальный словарь** — свои переводы поверх общей базы: добавляются вручную или выделением текста на странице, применяются сразу без перезагрузки; редактор с поиском, импортом/экспортом и отправкой предложений в общую базу.
- **Цветовые темы тулкита** — выбор акцентного цвета AniMori.
- **Локальный кэш (IndexedDB)** — данные Shikimori/MAL кэшируются на 90 дней, чтобы не дёргать API повторно.
- **Гибкие настройки** — модули включаются/отключаются во вкладочной панели «⚙» в левом нижнем углу.
- **Логгер** — встроенный инструмент отладки (по желанию).

## Установка

### Пользовательский скрипт

1. Установите менеджер пользовательских скриптов — [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox и др.).
2. Установите скрипт со страницы **[Greasy Fork](https://greasyfork.org/ru/scripts/572948-animori-anilist-toolkit)** — это рекомендуемый способ, он обеспечивает автообновления.
3. Откройте [AniList](https://anilist.co) — внизу слева появится кнопка **⚙**.

### Приложение для Windows

1. Скачайте установщик из раздела **[Releases](https://github.com/foulnike/AniMori-AniList-Toolkit/releases)** — это `AniMori_Setup.exe` либо тот же файл с полным именем вида `AniMori_2.0.1_x64-setup.exe`.
2. Запустите установщик и откройте AniMori из меню «Пуск».

Приложению нужен компонент **WebView2**: в Windows 11 и актуальной Windows 10 он уже установлен, иначе установщик предложит его загрузить. Дальше программа следит за обновлениями сама: при запуске она сверяется с последним релизом и предлагает установить новую версию, если та вышла.

В браузерной версии блокировщика рекламы нет намеренно: в браузере с этим лучше справится любое профильное расширение.

## Авторизация (для экспорта и редактирования списков)

Перевод, плеер и рейтинги работают без входа. Для экспорта списка из Shikimori и изменения своего списка на AniList нужен токен:

1. Откройте панель **⚙** → раздел «Авторизация AniList».
2. Создайте API-клиент на [anilist.co/settings/developer](https://anilist.co/settings/developer) (в поле redirect укажите `https://anilist.co/api/v2/oauth/pin`).
3. Вставьте Client ID, сгенерируйте ссылку, получите токен и вставьте его в поле.

В браузерной версии токен хранится в хранилище Tampermonkey, в приложении — в файле настроек программы. Наружу он не утекает ни в том, ни в другом случае.

## Источники данных

| Источник | Назначение |
| :--- | :--- |
| `raw.githubusercontent.com` | словарь перевода интерфейса (этот репозиторий) |
| `graphql.anilist.co` | данные и списки AniList |
| `shikimori.io`, `shikimori.rip` | русские названия, описания, персонажи, франшизы (`.rip` — запасное зеркало на случай недоступности основного домена) |
| `smotret-anime.online`, `anime365.ru` | тайтлы и описания (альтернативный источник/фоллбэк anime365) |
| `api.animethemes.moe` | музыка |
| `kodik-api.com` | видеоплеер |

Скрипт обращается к этим API прямо из браузера, приложение — через свой процесс. Ваши данные на сторонние серверы не отправляются: токен и настройки остаются на вашей машине, кэш — в локальной IndexedDB. Приложение дополнительно стучится на GitHub за манифестом обновлений.

## Словарь перевода

`dictionary.json` — набор пар `оригинал → перевод` для строк интерфейса AniList:

```json
{
  "Home": "Главная",
  "Browse": "Просмотр",
  "Settings": "Настройки"
}
```

Словарь подгружается напрямую из ветки `main`, поэтому правки применяются у всех пользователей без обновления скрипта или приложения. Нашли непереведённую или неточно переведённую строку — присылайте Pull Request или открывайте Issue.

## Сборка из исходников

Нужны Node.js и, для приложения, [окружение Rust и Tauri](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run build         # пользовательский скрипт → dist/animori.user.js
npm run build:tauri   # веб-часть приложения
npm run tauri:build   # установщик → src-tauri/target/release/bundle/nsis/
npm run typecheck     # проверка типов
```

Сборка установщика подписывает обновление, поэтому `npm run tauri:build` ждёт переменные окружения `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Свою пару ключей можно создать командой `npm run tauri signer generate`.

Исходный код общий: `src/` — логика и интерфейс на TypeScript и Vue 3, `src-tauri/` — оболочка на Rust. Какая версия собирается, определяет режим сборки.

## Лицензия

[MIT](LICENSE) © foulnike

Лицензия покрывает код проекта и переводы, сделанные участниками. Данные сторонних сервисов ею не покрываются: оригинальные строки интерфейса в ключах `dictionary.json` принадлежат AniList, русские названия, описания и имена — Shikimori и anime365, музыкальные метаданные — AnimeThemes. Всё это показывается со ссылкой на источник и не хранится в репозитории.

Сторонние сервисы (AniList, Shikimori, MyAnimeList, anime365, AnimeThemes, Kodik) принадлежат их владельцам и используются через их публичные API. Видео отдаёт сторонний плеер: проект не хранит и не раздаёт видео и не отвечает за содержимое источников.
