// Пункт 5.3, часть вторая: прокси для канала САМОГО ОКНА.
//
// Разделение каналов, о котором надо помнить при разборе любого сетевого отказа:
//
//   1. Наши запросы к API уходят из процесса оболочки через tauri-plugin-http.
//      Прокси для них задаётся на стороне JS, в src/bridge/TauriBridge.ts.
//   2. Страница anilist.co, её картинки, шрифты и кадр плеера уходят из WebView2.
//      На них настройка из пункта 1 не влияет вообще, и именно этим занят этот модуль.
//
// Почему аргументом командной строки, а не вызовом метода. У WebView2 нет способа
// поменять прокси у живого окна: адрес читается один раз, когда создаётся окружение
// движка, то есть при появлении первого окна процесса. Единственная точка входа —
// переменная окружения WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, которую движок читает
// в тот же момент. Отсюда следует главное ограничение всего пункта 5.3: смена адреса
// прокси требует ПЕРЕЗАПУСКА приложения, и панель настроек обязана сказать это прямо.
//
// Отсюда же требование к месту вызова: apply_to_webview() обязан отработать ДО
// WebviewWindowBuilder::build() в lib.rs. Вызов после создания окна не даст ничего
// и, что хуже, не даст никакой ошибки.

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// Файл настроек. То же имя, что у LazyStore в src/bridge/TauriBridge.ts: файл один,
/// и читают его обе стороны.
const STORE_FILE: &str = "animori-settings.json";

// Ключи хранилища. Объявлены в src/core/proxy.ts (PROXY_KEYS) и повторены здесь:
// сторона Rust к модулям TypeScript доступа не имеет. Разойтись они не должны.
const KEY_ENABLED: &str = "set_proxy_on";
const KEY_KIND: &str = "set_proxy_kind";
const KEY_HOST: &str = "set_proxy_host";
const KEY_PORT: &str = "set_proxy_port";
const KEY_LOGIN: &str = "set_proxy_login";
const KEY_BYPASS: &str = "set_proxy_bypass";

/// Разобранная настройка в том виде, в каком её принимает движок окна.
struct ProxyArgs {
    /// Значение для --proxy-server, например http://10.0.0.1:8080 или socks5://127.0.0.1:1080.
    server: String,
    /// Значение для --proxy-bypass-list. Пусто, если исключений нет.
    bypass: String,
    /// Заданы ли учётные данные. Влияет только на предупреждение в журнале, см. ниже.
    has_credentials: bool,
}

/// Строка из хранилища. Числа тоже принимаются: файл настроек правится руками, и
/// порт там запросто окажется строкой, а адрес — числом.
fn read_string(value: Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Порт как целое в допустимом диапазоне. Ноль означает «значения нет»: ровно так же
/// поступает normalizeProxyPort() в src/core/proxy.ts, и трактовка обязана совпадать.
fn read_port(value: Option<serde_json::Value>) -> u16 {
    let parsed = match value {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    };

    if parsed == 0 || parsed > 65535 {
        0
    } else {
        parsed as u16
    }
}

/// Читает настройку прокси из файла настроек.
///
/// None означает «прокси не применяется»: выключен, не настроен или файла ещё нет.
/// Это не ошибка и в журнал не пишется: свежая установка выглядит именно так.
fn read_config(app: &AppHandle) -> Option<ProxyArgs> {
    // Ошибку открытия файла глушить нельзя (инвариант 4), но и падать из-за неё незачем:
    // без файла настроек приложение работает на значениях по умолчанию, то есть напрямую.
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            log::warn!("Не удалось открыть файл настроек для чтения прокси: {e}");
            return None;
        }
    };

    let enabled = matches!(store.get(KEY_ENABLED), Some(serde_json::Value::Bool(true)));
    if !enabled {
        return None;
    }

    let host = read_string(store.get(KEY_HOST));
    let port = read_port(store.get(KEY_PORT));

    if host.is_empty() || port == 0 {
        // Включён, но настроен негодно. Тот же случай разбирается и на стороне JS,
        // и молчать о нём нельзя: человек видит включённый тумблер и считает, что
        // трафик идёт через прокси.
        log::warn!("Прокси включён, но адрес или порт заданы неверно — окно идёт напрямую");
        return None;
    }

    // Неизвестное значение трактуется как http, как и normalizeProxyKind() в TypeScript.
    let scheme = if read_string(store.get(KEY_KIND)) == "socks5" {
        "socks5"
    } else {
        "http"
    };

    // Chromium ждёт список исключений через точку с запятой. Пользователь пишет их как
    // придётся, поэтому разделителями считаем и запятую, и перевод строки. Пробелы внутри
    // записи отбрасываем вместе с записью: в имени хоста их быть не может, а пробел
    // в аргументе командной строки разорвал бы саму строку аргументов.
    let bypass = read_string(store.get(KEY_BYPASS))
        .split(|c| c == ',' || c == ';' || c == '\n' || c == '\r')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty() && !item.contains(' '))
        .collect::<Vec<_>>()
        .join(";");

    Some(ProxyArgs {
        server: format!("{scheme}://{host}:{port}"),
        bypass,
        has_credentials: !read_string(store.get(KEY_LOGIN)).is_empty(),
    })
}

/// Передаёт настройку прокси движку окна.
///
/// Вызывается ОДИН раз, в начале setup() и до создания окна. Подробности про момент —
/// в шапке модуля.
pub fn apply_to_webview(app: &AppHandle) {
    let Some(args) = read_config(app) else {
        return;
    };

    // Учётные данные командной строкой не передаются вовсе: такого аргумента у движка нет.
    // Прокси с паролем будет обслуживать наш канал (там пароль уходит отдельным полем),
    // а страница получит запрос авторизации от самого движка. Предупреждение в журнале
    // нужно, чтобы этот перекос не выглядел случайной поломкой.
    if args.has_credentials {
        log::warn!(
            "У прокси задан логин: наши запросы к API пройдут с ним, \
             а страница будет спрашивать авторизацию средствами движка окна"
        );
    }

    let mut value = format!("--proxy-server={}", args.server);
    if !args.bypass.is_empty() {
        value.push_str(&format!(" --proxy-bypass-list={}", args.bypass));
    }

    // Только Windows: переменную читает WebView2, которого больше нигде нет. Под Linux
    // окно рисует WebKitGTK, и прокси там задаётся своим способом — это отдельная работа
    // ветки linux-dev, а не молчаливое бездействие здесь.
    #[cfg(windows)]
    {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &value);
        log::info!("Прокси для окна: {}", args.server);
    }

    #[cfg(not(windows))]
    {
        let _ = &value;
        log::warn!("Прокси для окна на этой платформе пока не поддержан — страница идёт напрямую");
    }
}
