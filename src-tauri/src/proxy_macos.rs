// Прокси для канала САМОГО ОКНА на macOS.
//
// Почему отдельный модуль, а не ветка в proxy.rs. На Windows адрес прокси уходит
// движку строкой в переменной окружения WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS —
// одна строка и всё. У WKWebView такого входа нет: прокси задаётся объектом
// nw_proxy_config из Network.framework, который кладётся в свойство
// proxyConfigurations хранилища данных вебвью. Это другой механизм целиком,
// с обёртками ObjC и сырым FFI, и в общем файле он бы только мешал читать.
//
// Учётные данные здесь же: nw_proxy_config_set_username_and_password закрывает
// то, ради чего на Windows понадобился отдельный proxy_auth.rs с перехватом
// события BasicAuthenticationRequested. Диалога у пользователя не будет ни там,
// ни здесь — пара подставляется молча.
//
// ТРЕБОВАНИЕ ВЕРСИИ: proxyConfigurations появилось в macOS 14, а в бандле стоит
// minimumSystemVersion 10.15. Поэтому доступность проверяется в рантайме через
// respondsToSelector, а не отсекается на этапе сборки: на macOS 13 и старше
// прокси просто не применится, и об этом будет запись в журнале.

use std::ffi::{c_char, c_void, CString};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, sel};
use objc2_foundation::{MainThreadMarker, NSArray};
use objc2_web_kit::WKWebViewConfiguration;

use crate::proxy::ProxyArgs;

/// Объекты Network.framework — обычные объекты ObjC, поэтому их можно класть
/// в NSArray и отдавать WebKit как есть.
type NwObject = *mut c_void;

#[link(name = "Network", kind = "framework")]
extern "C" {
    fn nw_endpoint_create_host(hostname: *const c_char, port: *const c_char) -> NwObject;
    fn nw_proxy_config_create_http_connect(endpoint: NwObject, tls_options: NwObject) -> NwObject;
    fn nw_proxy_config_create_socksv5(endpoint: NwObject) -> NwObject;
    fn nw_proxy_config_set_username_and_password(
        config: NwObject,
        username: *const c_char,
        password: *const c_char,
    );
    fn nw_proxy_config_add_excluded_domain(config: NwObject, excluded_domain: *const c_char);
}

/// Собирает nw_proxy_config по разобранным настройкам.
///
/// Возвращает объект с единичной ссылкой (NW_RETURNS_RETAINED). Мы её не отдаём:
/// объект живёт столько же, сколько окно, и освобождать его на выходе некому.
fn make_proxy_config(args: &ProxyArgs) -> Option<NwObject> {
    let host = CString::new(args.host.as_str()).ok()?;
    let port = CString::new(args.port.to_string()).ok()?;

    let endpoint = unsafe { nw_endpoint_create_host(host.as_ptr(), port.as_ptr()) };
    if endpoint.is_null() {
        log::warn!("Прокси: не удалось описать адрес {}:{}", args.host, args.port);
        return None;
    }

    // socks5 или http — ровно та же развилка, что и в схеме server из proxy.rs.
    let config = unsafe {
        if args.server.starts_with("socks5://") {
            nw_proxy_config_create_socksv5(endpoint)
        } else {
            // Второй аргумент — TLS до самого прокси. Его у нас нет: и http,
            // и socks5 идут открытым каналом, как и на Windows.
            nw_proxy_config_create_http_connect(endpoint, std::ptr::null_mut())
        }
    };

    if config.is_null() {
        log::warn!("Прокси: движок отказался принять {}", args.server);
        return None;
    }

    if !args.login.is_empty() {
        if let (Ok(user), Ok(pass)) = (
            CString::new(args.login.as_str()),
            CString::new(args.password.as_str()),
        ) {
            unsafe { nw_proxy_config_set_username_and_password(config, user.as_ptr(), pass.as_ptr()) };
        } else {
            log::warn!("Прокси: в логине или пароле нулевой байт, авторизация пропущена");
        }
    }

    // Аналог --proxy-bypass-list. Разделитель ';' ставит сам proxyBypassList()
    // из src/core/proxy.ts, здесь список только разбирается.
    for domain in args.bypass.split(';').filter(|d| !d.is_empty()) {
        if let Ok(d) = CString::new(domain) {
            unsafe { nw_proxy_config_add_excluded_domain(config, d.as_ptr()) };
        }
    }

    Some(config)
}

/// Готовит конфигурацию вебвью с прописанным прокси.
///
/// Вызывать СТРОГО до создания окна: хранилище данных читается движком при
/// инициализации вебвью, и поздняя правка на уже открытое окно не подействует.
/// Это то же ограничение, что и на Windows, где переменная окружения читается
/// один раз, — отсюда и общее для платформ требование перезапуска.
///
/// None означает «ставить нечего»: прокси выключен, настройки битые или система
/// старше macOS 14. Во всех трёх случаях окно создаётся обычным путём.
pub fn webview_configuration(args: &ProxyArgs) -> Option<Retained<WKWebViewConfiguration>> {
    // setup() выполняется на главном потоке; проверка — страховка, а не формальность:
    // все объекты WebKit main-thread-only и с другого потока падают.
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("Прокси: сборка конфигурации не с главного потока, пропущена");
        return None;
    };

    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    let data_store: *mut AnyObject = unsafe { msg_send![&*configuration, websiteDataStore] };
    if data_store.is_null() {
        log::warn!("Прокси: у конфигурации нет хранилища данных");
        return None;
    }

    // macOS 14+. На более старых свойства просто нет, и вызов уронил бы приложение.
    let available: bool =
        unsafe { msg_send![data_store, respondsToSelector: sel!(setProxyConfigurations:)] };
    if !available {
        log::warn!(
            "Прокси: proxyConfigurations требует macOS 14 или новее — окно идёт напрямую"
        );
        return None;
    }

    let config = make_proxy_config(args)?;

    // NSArray удержит объект сам; наша ссылка из NW_RETURNS_RETAINED остаётся
    // висеть, и это осознанно — см. комментарий у make_proxy_config.
    let array: Retained<NSArray<AnyObject>> =
        unsafe { NSArray::from_slice(&[&*(config as *mut AnyObject)]) };

    unsafe {
        let _: () = msg_send![data_store, setProxyConfigurations: &*array];
    }

    log::info!("Прокси для окна: {}", args.server);
    Some(configuration)
}
