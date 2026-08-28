<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-28 | Updated: 2026-08-28 -->

# src-tauri/src

## Purpose

Rust-код десктопной оболочки: создание окна с инъекцией бандла, собственные команды, сетевой блокировщик, прокси с авторизацией и аварийным выходом, автообновление.

## Key Files

| File | Description |
|------|-------------|
| `main.rs` | Шесть строк: `windows_subsystem = "windows"` в релизе и вызов `animori_lib::run()` |
| `lib.rs` | Ядро: `WebviewWindowBuilder` с `initialization_script`, `include_str!` бандла и стилей, `NET_PROBE_SCRIPT`, `on_navigation`, регистрация плагинов и состояний, команды `animori_reload`, `animori_toggle_fullscreen`, `animori_open_external` |
| `adblock.rs` | Сетевая блокировка через событие `WebResourceRequested` WebView2 — единственное место, где видны запросы чужого кадра плеера. Список рекламных доменов, счётчик, `install()` |
| `proxy.rs` | Прокси для канала **самого окна**: `ProxyConfig` из `animori-settings.json`, TCP-щуп, `apply_to_webview()`, команды `animori_proxy_status` и `animori_proxy_probe` |
| `proxy_auth.rs` | Авторизация окна у прокси через `BasicAuthenticationRequested`: своего диалога у движка нет, без обработчика запрос отменяется молча |
| `proxy_guard.rs` | Аварийный выход: прокси принят, но страница не грузится. Команда `animori_page_ready`, состояние `PageReady`, сторож со сбросом настройки и родным диалогом |
| `updater.rs` | Автообновление. Весь процесс ведётся из Rust и **ни одной строкой не выходит в JS** |
| `adblock_rules.rs` | Общий для обеих платформ список: `ALLOW_HOSTS`, `AD_HOSTS`, `AD_PATTERNS`. Без `cfg` — одни константы |
| `adblock_macos.rs` | Блокировщик для macOS на `WKContentRuleList`: сборка JSON-правил, компиляция в WebKit, обработчик сообщений `animoriAdblock` для тумблера |
| `proxy_macos.rs` | Прокси окна на macOS: `nw_proxy_config` из Network.framework в `WKWebsiteDataStore.proxyConfigurations`, вместе с логином, паролем и списком исключений |

## For AI Agents

### Working In This Directory

- **Окно создаётся в коде, а не в `tauri.conf.json`:** `initialization_script` есть только у `WebviewWindowBuilder`. Метка окна остаётся `"main"` — на неё ссылается `capabilities/default.json`.
- **Ни `updater`, ни `dialog` не имеют разрешений в capabilities, и это не упущение.** Окно живёт на `anilist.co`; `updater:default` там означал бы право любого скрипта чужого сайта запустить загрузку и установку файла. Перезапуск делает `app.restart()` — метод ядра, отдельный плагин `process` не нужен.
- **Прокси не применяется на ходу — на обеих платформах.** WebView2 читает адрес один раз при поднятии окружения; WKWebView читает хранилище данных при создании вебвью. Отсюда вызов `apply_to_webview()` и `proxy_macos::webview_configuration()` только **до** `build()` в `lib.rs` и требование перезапуска при смене канала.
- **На macOS `decide()` и применение разнесены во времени:** первое идёт в `setup()`, второе при создании окна. Разобранные настройки передаются через `proxy::pending()`. Не убирай `.take()` — повторное применение к уже созданному окну ничего не даст.
- **Сырой FFI к Network.framework** в `proxy_macos.rs` объявлен вручную: обёрток `nw_proxy_config` в objc2 нет. `proxyConfigurations` требует macOS 14, поэтому доступность проверяется через `respondsToSelector` — без проверки вызов уронил бы приложение на macOS 13.
- **Прокси окна и прокси наших запросов — разные вещи.** Здесь настраивается канал окна; запросы к API идут мимо, через `plugin-http` в `src/bridge/TauriBridge.ts` (там же `basicAuth`).
- **Три места с одними и теми же ключами не должны разойтись:** `proxy.rs`, `proxy_guard.rs` и `src/core/proxy.ts` — имя файла `animori-settings.json` и ключи вроде `set_proxy_on`. Сериализатор в Rust настроен на camelCase, чтобы совпасть с TS.
- **`proxy_guard.rs` существует потому, что панель настроек живёт внутри незагрузившейся страницы.** TCP-щуп не отличает прокси, который принимает соединение, но наружу не выпускает; выключить прокси изнутри было бы нечем. Сторож ждёт отметки `animori_page_ready` (её ставит `reportPageAlive()` в `src/main.ts`, опрашивая `#app`) и по таймауту в 12 секунд предлагает выключить прокси.
- **`on_navigation` на macOS ничего не отменяет, и это не оплошность.** wry зовёт его из `decidePolicyForNavigationAction` и передаёт наружу только адрес: поле `targetFrame.isMainFrame` у `WKNavigationAction` есть, но wry его не читает (`wry-0.55.1/src/wkwebview/navigation.rs`). Обработчик срабатывает на **каждый** фрейм, поэтому запрет чужого хоста убивал вложенные кадры — капча Turnstile оставалась на `about:blank` с origin родителя и падала с «Unable to post message to challenges.cloudflare.com», а кадр плеера не грузился вовсе. На Windows проблемы нет: `NavigationStarting` у WebView2 только для верхнего уровня. Сторож ухода окна на чужой сайт переехал в `src/main.ts` — бандл идёт `initialization_script`'ом и выполняется в главном фрейме любой страницы.
- **Первый IPC-вызов на macOS теряется.** Окно на `https`, а канал Tauri — на схеме `ipc://`; движок режет её как небезопасное содержимое, Tauri переключается на postMessage, но вызов, на котором он это понял, уже потерян. Первым в приложении идёт чтение настроек, поэтому в `TauriBridge` у него есть один повтор. Не убирай его, не проверив запуск: без повтора настройки читаются тридцатью вызовами вместо одного.
- **Новая команда — три места:** `#[tauri::command]` здесь, `AppManifest::commands` в `build.rs`, `allow-<kebab-case>` в capabilities.
- **Версии `webview2-com` / `windows` берутся из `Cargo.lock` wry**, не «поновее».

### Testing Requirements

Только Windows: `npm run tauri:dev`, `npm run tauri:build`. Сценарии по модулям — блокировщик (тумблер + логгер), прокси (валидный, неверный порт, требующий логина, «принимает но не выпускает» → аварийный выход), обновление (проверяется только против настоящего релиза с подписью).

## Dependencies

### Internal

- `../../dist/animori.tauri.js`, `../../dist/animori.tauri.css` — через `include_str!`
- `src/features/adblock/net-block.ts` — управляющий домен `adblock.animori.invalid`
- `src/features/adblock/net-probe.ts` — парная половина `NET_PROBE_SCRIPT`
- `src/bridge/TauriProxyDiagnostics.ts` — потребитель `animori_proxy_status` / `animori_proxy_probe`

<!-- MANUAL: -->
