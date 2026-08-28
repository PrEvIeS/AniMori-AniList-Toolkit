<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# src-tauri

## Purpose

Десктопная оболочка на Rust + Tauri 2: окно, открытое на внешнем URL `anilist.co`, в которое инъектируется собранный фронтенд. Даёт то, чего юзерскрипт не может — запросы мимо страницы (без CORS), сетевую блокировку рекламы, прокси для канала окна, нативную навигацию и автообновление.

**Целевая платформа — только Windows.** Модули `adblock`, `proxy_auth` и часть `proxy` построены на COM-интерфейсах WebView2 и закрыты `#[cfg(windows)]`.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Зависимости с развёрнутым обоснованием каждой. Версии `webview2-com` 0.38 и `windows` 0.61 **подобраны под wry 0.55.1** — другая мажорная версия даст два несовместимых набора одних и тех же типов |
| `tauri.conf.json` | `productName`, `identifier`, `"version": "../package.json"`, эндпоинт и `pubkey` апдейтера, бандл NSIS. `windows: []` — окно создаётся в коде |
| `build.rs` | Объявляет собственные команды через `AppManifest::commands`. **Без объявления здесь разрешения не существует вовсе**, и вызов из JS падает с «not allowed. Plugin not found» |
| `Cargo.lock` | Зафиксирован в репозитории; поднимается вместе с версией |
| `tauri.macos.conf.json` | Оверлей для macOS: бандлы `app` + `dmg`, `icon.icns`, `createUpdaterArtifacts: false`. Tauri 2 подмешивает `tauri.<платформа>.conf.json` автоматически, поэтому Windows-релиз не затронут |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Rust-модули оболочки (см. `src/AGENTS.md`) |
| `capabilities/` | ACL окна `main` (см. `capabilities/AGENTS.md`) |
| `icons/` | Иконки приложения, сгенерированы `tauri icon`. Только бинарники, своего `AGENTS.md` нет |

## For AI Agents

### Working In This Directory

- **Окно живёт на чужом сайте.** Это определяющее ограничение всей оболочки: любое разрешение, выданное окну `main`, получает **любой скрипт `anilist.co`**. Отсюда правила: `updater` и `dialog` дёргаются только из Rust и разрешений не имеют вовсе; переключение блокировщика идёт через фиктивный домен, а не через `invoke`; системные запросы рисуются родными окошками, а не в странице (иначе страница могла бы их подделать).
- **Новая команда — три места:** реализация с `#[tauri::command]`, объявление в `build.rs`, разрешение `allow-<имя-в-kebab-case>` в `capabilities/default.json`. Пропуск любого — молчаливый отказ.
- **`#[cfg(windows)]` обязателен** для всего, что трогает WebView2: без него проект перестанет собираться везде, кроме Windows.
- **Версия здесь не хранится.** `tauri.conf.json` ссылается на `../package.json`; в `Cargo.toml` номер продублирован и поднимается вместе с ним.
- **`pubkey` в `tauri.conf.json` — единственная защита от подмены обновления.** Приватный ключ в репозитории отсутствует и лежит в секретах CI. **В форке апдейтер работать не будет,** пока не заведён свой ключ и свой эндпоинт `latest.json`.
- Файл `frontendDist: "../dist"` требует, чтобы фронтенд был собран **до** Rust: это делает `beforeBuildCommand: npm run build:tauri`.

### Сборка под macOS

Проект родом с Windows, но собирается и работает на macOS, и почти весь платформенный функционал воспроизведён — другими механизмами, потому что WKWebView устроен иначе, чем WebView2.

```bash
npm install
npm run tauri:build      # .app и .dmg в src-tauri/target/release/bundle/
npm run tauri:dev        # запуск без бандла
```

Конфигурация бандла лежит в `tauri.macos.conf.json` — Tauri подмешивает её сам, Windows-релиз не затронут. `createUpdaterArtifacts` там выключен, чтобы локальная сборка не требовала приватного ключа; в CI он включается флагом `--config` (см. `.github/workflows/AGENTS.md`).

| Возможность | Windows | macOS |
|---|---|---|
| Сетевой блокировщик | `WebResourceRequested` (`adblock.rs`) | `WKContentRuleList` (`adblock_macos.rs`) |
| Список рекламных адресов | общий `adblock_rules.rs` | общий `adblock_rules.rs` |
| Переключение блокировщика | запрос на `adblock.animori.invalid` | обработчик сообщений `animoriAdblock` |
| Прокси окна | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | `nw_proxy_config` + `proxyConfigurations` (`proxy_macos.rs`) |
| Авторизация у прокси | `BasicAuthenticationRequested` (`proxy_auth.rs`) | `nw_proxy_config_set_username_and_password` |
| Список исключений прокси | `--proxy-bypass-list` | `nw_proxy_config_add_excluded_domain` |
| User-Agent | WebView2 подставляет сам | задаётся явно, иначе Cloudflare режет капчу |

**Чего на macOS нет и не будет:**

- **Счётчик заблокированного в журнале.** `WKContentRuleList` декларативный: правила исполняет движок, колбэка на срабатывание нет вовсе. Блокировка работает, а доклад `window.__animoriNetBlocked` — нет. Обойти нечем: перехват https-запросов WKWebView не даёт никому.
- **Автообновление.** Требует своей пары ключей minisign и macOS-целей в `latest.json`; в апстримном манифесте только Windows.

**Требования версий.** `proxyConfigurations` появилось в macOS 14, а в бандле стоит `minimumSystemVersion` 10.15 — поэтому доступность проверяется в рантайме через `respondsToSelector`, а не отсекается на сборке. На macOS 13 и старше прокси не применится, о чём будет запись в журнале.

**Порядок вызовов критичен.** И User-Agent, и прокси ставятся строго **до** `build()`: движок читает их при создании вебвью, поздняя правка на открытое окно не подействует. Это то же ограничение, что и на Windows, — отсюда общее требование перезапуска при смене прокси.

**Бандл не подписан** учёткой Apple Developer: локально собранное приложение запускается, скачанное упрётся в Gatekeeper.

### Проверка macOS-специфичного

```bash
cargo test --lib        # правила блокировщика: разбор JSON + порядок + экранирование
```

Тест выгружает `target/adblock-rules.json`. Компиляция правил в рантайме асинхронная, а в релизе плагин логов не поднят — **битый список провалился бы молча**, поэтому список стоит скармливать живому `WKContentRuleListStore` (небольшая программа на Swift, см. историю правок) при любом изменении `adblock_rules.rs`.

Прокси проверяется локальным прокси-сервером, который отвечает `407`: в его логе должны появиться `CONNECT anilist.co:443` и повтор с заголовком `Proxy-Authorization`.

### Testing Requirements

```bash
npm run tauri:dev      # сборка фронта + запуск окна
npm run tauri:build    # установщик NSIS в src-tauri/target/release/bundle/
```

Собирается только на Windows. Обязательные ручные сценарии после правок: окно открывается и AniMori в нём работает, `Alt+←`/`Alt+→` и F5, внешняя ссылка уходит в системный браузер, настройки переживают перезапуск, при включённом прокси окно грузится или срабатывает аварийный выход.

## Dependencies

### Internal

- `../dist/animori.tauri.js` и `../dist/animori.tauri.css` — вшиваются через `include_str!` в `src/lib.rs`, поэтому имена файлов зафиксированы в `vite.config.ts` жёстко, без хешей
- `../src/core/proxy.ts` и `../src/bridge/TauriBridge.ts` — делят с Rust имя файла настроек `animori-settings.json` и ключи прокси

### External

`tauri` 2.11, плагины `http` / `store` / `clipboard-manager` / `opener` / `window-state` / `updater` / `dialog` / `log`; под Windows — `webview2-com`, `windows`.

<!-- MANUAL: -->
