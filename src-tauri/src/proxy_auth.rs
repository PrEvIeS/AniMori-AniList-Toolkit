// Авторизация у прокси для канала САМОГО ОКНА: аргументом учётные данные
// движку не передать, а своего диалога у него нет: без обработчика запрос
// отменяется молча. Наши запросы к API идут мимо, через basicAuth в TauriBridge.ts.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2BasicAuthenticationRequestedEventArgs, ICoreWebView2Controller, ICoreWebView2_10,
};
use webview2_com::BasicAuthenticationRequestedEventHandler;
use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::proxy::{self, WindowAuth};

/// При верном пароле хватает одной подстановки: дальше движок держит учётные
/// данные сам. Запас на переподключения, потолок — против бесконечного круга
/// при неверном пароле.
const MAX_ATTEMPTS: u32 = 5;

/// Сколько раз учётные данные уже подставлялись за сеанс.
static ATTEMPTS: AtomicU32 = AtomicU32::new(0);

/// Хост без схемы, логина и порта. Свой разбор, как в adblock.rs: тянуть ради
/// одной строки общий модуль между двумя платформенными файлами не стоит.
fn host_of(url: &str) -> &str {
    let rest = match url.find("://") {
        Some(i) => &url[i + 3..],
        None => url,
    };
    let end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..end];
    let authority = match authority.rfind('@') {
        Some(i) => &authority[i + 1..],
        None => authority,
    };
    match authority.find(':') {
        Some(i) => &authority[..i],
        None => authority,
    }
}

/// Звёздочка и ведущая точка срезаются: человек пишет и *.local, и .local,
/// и local — для движка это одно и то же.
fn is_bypassed(host: &str, rules: &[String]) -> bool {
    rules.iter().any(|raw| {
        let rule = raw
            .trim()
            .trim_start_matches('*')
            .trim_start_matches('.')
            .to_ascii_lowercase();

        if rule.is_empty() {
            return false;
        }

        // Целиком или как поддомен, а не через contains: иначе под «local»
        // попало бы «evil-local.example».
        host == rule
            || (host.len() > rule.len()
                && host.ends_with(&rule)
                && host.as_bytes()[host.len() - rule.len() - 1] == b'.')
    })
}

/// Вешается сразу после создания окна и только при применённом прокси с логином.
/// Ошибка не валит приложение: без обработчика поведение прежнее.
pub fn install(app: &AppHandle, window: &WebviewWindow) {
    let Some(auth) = proxy::window_auth(app) else {
        return;
    };

    let outcome = window.with_webview(move |platform| {
        if let Err(e) = unsafe { attach(platform.controller(), auth) } {
            log::warn!("Авторизация у прокси не подключена: {e}");
        }
    });

    if let Err(e) = outcome {
        log::warn!("Не удалось добраться до движка окна для авторизации у прокси: {e}");
    }
}

unsafe fn attach(
    controller: ICoreWebView2Controller,
    auth: WindowAuth,
) -> windows::core::Result<()> {
    let core = controller.CoreWebView2()?;

    // Событие появилось в десятой ревизии интерфейса: старый рантайм его не знает,
    // и это не повод падать — без прокси с паролем окно работает как раньше.
    let Ok(core10) = core.cast::<ICoreWebView2_10>() else {
        log::warn!("Старый рантайм WebView2: окно не сможет авторизоваться у прокси");
        return Ok(());
    };

    let handler =
        BasicAuthenticationRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            // Ошибка на одном запросе не должна ломать всё окно: пропускаем его.
            if let Err(e) = unsafe { on_request(&auth, &args) } {
                log::warn!("Авторизация у прокси: запрос не разобран: {e}");
            }
            Ok(())
        }));

    // Имя типа токена писать руками нельзя: в разных версиях привязок оно лежит
    // в разных местах, и сборка ломается при обновлении зависимостей.
    let mut token = Default::default();
    core10.add_BasicAuthenticationRequested(&handler, &mut token)?;

    log::info!("Авторизация у прокси подключена к движку окна");
    Ok(())
}

/// Движок поднимает одно и то же событие и на 407 от прокси, и на 401 от сайта,
/// а в аргументах лежит адрес ресурса, а не адрес прокси: различить их надёжно
/// невозможно. Отсюда два предохранителя и запись каждой подстановки в журнал.
unsafe fn on_request(
    auth: &WindowAuth,
    args: &ICoreWebView2BasicAuthenticationRequestedEventArgs,
) -> windows::core::Result<()> {
    // COM-память освобождает вызывающий, как и в adblock.rs.
    let mut raw = PWSTR::null();
    args.Uri(&mut raw)?;
    let uri = raw.to_string().unwrap_or_default();
    CoTaskMemFree(Some(raw.0 as *const c_void));

    let lowered = uri.to_ascii_lowercase();
    let host = host_of(&lowered);

    // Сюда трафик идёт мимо прокси, значит авторизацию спросил сам сайт.
    if is_bypassed(host, &auth.bypass) {
        log::warn!("Авторизация запрошена на {host} мимо прокси — учётные данные не подставлены");
        return Ok(());
    }

    let attempt = ATTEMPTS.fetch_add(1, Ordering::Relaxed) + 1;
    if attempt > MAX_ATTEMPTS {
        log::warn!(
            "Запрос авторизации повторился больше {MAX_ATTEMPTS} раз — учётные данные \
             больше не подставляются: прокси их не принимает"
        );
        return Ok(());
    }

    let response = args.Response()?;

    // HSTRING живёт до конца функции: указатель на временную строку был бы висячим.
    let login = HSTRING::from(auth.login.as_str());
    let password = HSTRING::from(auth.password.as_str());

    response.SetUserName(PCWSTR(login.as_ptr()))?;
    response.SetPassword(PCWSTR(password.as_ptr()))?;

    // Адрес в журнале обязателен: так видно, если учётные данные ушли не туда.
    log::info!("Учётные данные прокси подставлены для {host}, попытка {attempt}");

    Ok(())
}
