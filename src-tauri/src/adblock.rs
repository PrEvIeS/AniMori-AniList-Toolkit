// Блокировка рекламных ЗАПРОСОВ в движке окна: событие WebResourceRequested —
// единственное место, где видны запросы чужого кадра плеера (kodikplayer.com).
// Модуль features/adblock в юзерскрипте остаётся: он прячет баннеры через CSS.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Environment, ICoreWebView2WebResourceRequestedEventArgs,
    ICoreWebView2_2, ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
};
use webview2_com::WebResourceRequestedEventHandler;
use windows::core::{w, Interface, PCWSTR, PWSTR};
use windows::Win32::System::Com::CoTaskMemFree;

/// Тумблер страницы ходит сюда: перехваченный запрос вместо новой команды и
/// разрешения в capabilities. Домен .invalid в сети не разрешается никогда.
const CONTROL_HOST: &str = "adblock.animori.invalid";

/// По умолчанию выключен: блокировка лишает источники рекламных денег, и такое
/// решение принимает человек, а не установщик. Цена решения известна: у тех, кто
/// тумблер включил, первые запросы кадра плеера пройдут до прихода команды со
/// страницы.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Сколько запросов отбито за сессию — второй аргумент в записи журнала.
static TOTAL: AtomicU64 = AtomicU64::new(0);

/// Счётчики по доменам: нужны только чтобы писать в журнал один раз на домен.
fn hosts() -> &'static Mutex<HashMap<String, u64>> {
    static HOSTS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Проверяется первым и всегда побеждает приметы. localhost обязателен:
/// на нём живёт ipc.localhost, его блокировка убьёт приложение целиком.
const ALLOW_HOSTS: &[&str] = &[
    "localhost",
    "anilist.co",
    "kodikplayer.com",
    "kodikres.com",
    "kodik-api.com",
    "solodcdn.com",
    "shikimori.one",
    "shikimori.io",
    "shikimori.rip",
    "anime365.ru",
    "smotret-anime.online",
    "animethemes.moe",
    "githubusercontent.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "gstatic.com",
    "jsdelivr.net",
];

/// Собрано живой охотой 02.08.2026, не из чужих списков. Сравнение — целиком
/// или поддомен.
const AD_HOSTS: &[&str] = &[
    // — цепочка плеера
    "buzzoola.com",
    "bracdn.online",
    "snsv.ru",
    "sapfir.tv",
    "moviead55.ru",
    "21wiz.com",
    "bidster.net",
    "vidalak.com",
    "traffmovie.com",
    "flyroll.ru",
    "surfy.space",
    "punchmedia.ru",
    "moe.video",
    "xcec.ru",
    "adseedtech.com",
    "betweendigital.com",
    "ufouxbwn.com",
    "adstag0102.xyz",
    "ctrltech.ai",
    "agenteimmobiliare.info",
    "voxexchange.io",
    "mc.yandex.ru",
    "mc.yandex.md",
    "an.yandex.ru",
    "adfox.ru",
    // — биржи самого AniList
    "vntsm.com",
    "vntsm.io",
    "venatusmedia.com",
    "rapidedge.io",
    "doubleclick.net",
    "googlesyndication.com",
    "fundingchoicesmessages.google.com",
    "google-analytics.com",
    "googletagmanager.com",
    "ccgateway.net",
    "atmtd.com",
    "fastclick.net",
    "amazon-adsystem.com",
    "criteo.com",
    "rubiconproject.com",
    "pubmatic.com",
    "3lift.com",
    "adnxs.com",
    "openx.net",
    "smartadserver.com",
    "sharethrough.com",
    "bidswitch.net",
    "yellowblue.io",
    "onetag-sys.com",
    "tappx.com",
    "presage.io",
    "aniview.com",
    "id5-sync.com",
    "rlcdn.com",
    "casalemedia.com",
    "media.net",
    "adform.net",
    "360yield.com",
    "gumgum.com",
    "the-ozone-project.com",
    "bids.ws",
    "smilewanted.com",
    "richaudience.com",
    "inmobi.com",
    "loopme.me",
    "admanmedia.com",
    "creativecdn.com",
    "adsrvr.org",
    "stackadapt.com",
    "quantserve.com",
    "crwdcntrl.net",
    "everesttech.net",
    "bidr.io",
    "dotomi.com",
    "outbrain.com",
    "zemanta.com",
    "yieldmo.com",
    "1rx.io",
    "contextweb.com",
    "lijit.com",
    "sonobi.com",
    "smaato.net",
    "bidmatic.io",
    "hadronid.net",
    "ad-delivery.net",
    "dnacdn.net",
    "script.ac",
    "clean.gg",
    "4dex.io",
    "amxrtb.com",
    "a-mx.com",
    "a-mo.net",
    "amx1.net",
    "deepintent.com",
    "ipredictive.com",
    "socdm.com",
    "eskimi.com",
    "chocolateplatform.com",
    "ymmobi.com",
    "syncingbridge.com",
    "measureadv.com",
    "company-target.com",
    "mediagotechnology.com",
    "lunamedia.live",
    "adx.opera.com",
    "fwmrm.net",
    "analytics.yahoo.com",
    "omnitagjs.com",
    "ssp.disqus.com",
];

/// Второй слой: домен победителя аукциона меняет и номер, и поддомен от запуска
/// к запуску, а стандарты видеорекламы в адресе — нет.
const AD_PATTERNS: &[&str] = &[
    "/vast",
    "vast.php",
    "vast?",
    "vpaid",
    "/ads/adfox",
    "/openrtb",
    "/prebid",
    "usersync",
    "user-sync",
    "user_sync",
    "cookie_sync",
    "cookie-sync",
    "/cksync",
    "/getuid",
    "/setuid",
];

/// Хост без схемы, логина и порта. Свой разбор вместо url::Url: выделение
/// памяти на каждый из сотен запросов в минуту не по задаче.
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

/// Целиком или как поддомен, а не contains: иначе под "media.net" попало бы
/// "socialmedia.network", а под "anilist.co" — "anilist.co.evil.example".
fn host_matches(host: &str, rule: &str) -> bool {
    if host == rule {
        return true;
    }
    host.len() > rule.len()
        && host.ends_with(rule)
        && host.as_bytes()[host.len() - rule.len() - 1] == b'.'
}

fn is_allowed(host: &str) -> bool {
    ALLOW_HOSTS.iter().any(|rule| host_matches(host, rule))
}

fn is_ad(host: &str, lowered_url: &str) -> bool {
    if AD_HOSTS.iter().any(|rule| host_matches(host, rule)) {
        return true;
    }
    AD_PATTERNS.iter().any(|p| lowered_url.contains(p))
}

/// Ошибка не валит приложение: без блокировщика программа работает, просто
/// с рекламой.
pub fn install(window: &WebviewWindow) {
    let reporter = window.clone();

    let outcome = window.with_webview(move |platform| {
        if let Err(e) = unsafe { attach(platform.controller(), reporter) } {
            log::warn!("Блокировщик рекламы не запустился: {e}");
        }
    });

    if let Err(e) = outcome {
        log::warn!("Не удалось добраться до движка окна для блокировщика: {e}");
    }
}

/// Фильтр "*" с контекстом ALL: реклама ходит и за скриптами, и за XHR, и за
/// видеофайлом. Сузить нельзя.
unsafe fn attach(
    controller: ICoreWebView2Controller,
    window: WebviewWindow,
) -> windows::core::Result<()> {
    let core = controller.CoreWebView2()?;
    let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;

    // Без параметра об источниках событие поднимает только главный документ,
    // а реклама плеера живёт во вложенном кадре — промах проверки 02.08.2026.
    match core.cast::<ICoreWebView2_22>() {
        Ok(core22) => {
            core22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                w!("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?;
        }
        Err(_) => {
            log::warn!(
                "Блокировщик: старый рантайм WebView2, реклама внутри плеера резаться не будет"
            );
            core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?;
        }
    }

    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else { return Ok(()) };
        // Ошибка разбора одного запроса не должна ломать всё окно: пропускаем его.
        if let Err(e) = unsafe { on_request(&environment, &window, &args) } {
            log::warn!("Блокировщик: запрос не разобран: {e}");
        }
        Ok(())
    }));

    // Имя типа токена писать руками нельзя: в разных версиях привязок оно лежит
    // в разных местах, и сборка ломается при обновлении зависимостей.
    let mut token = Default::default();
    core.add_WebResourceRequested(&handler, &mut token)?;

    log::info!("Блокировщик рекламы подключён к движку окна");
    Ok(())
}

unsafe fn on_request(
    environment: &ICoreWebView2Environment,
    window: &WebviewWindow,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
) -> windows::core::Result<()> {
    let request = args.Request()?;

    // COM-память освобождает вызывающий: без CoTaskMemFree это утечка на каждый
    // запрос окна.
    let mut raw = PWSTR::null();
    request.Uri(&mut raw)?;
    let url = raw.to_string().unwrap_or_default();
    CoTaskMemFree(Some(raw.0 as *const c_void));

    if url.is_empty() {
        return Ok(());
    }

    let lowered = url.to_ascii_lowercase();
    let host = host_of(&lowered);

    // Команда со стороны страницы. Отвечаем пустотой, чтобы запрос не висел.
    if host == CONTROL_HOST {
        let on = lowered.contains("/on");
        ENABLED.store(on, Ordering::Relaxed);
        log::info!("Блокировщик рекламы: {}", if on { "включён" } else { "выключен" });
        return respond(environment, args, 204, w!("AniMori"));
    }

    if !ENABLED.load(Ordering::Relaxed) {
        return Ok(());
    }

    if is_allowed(host) || !is_ad(host, &lowered) {
        return Ok(());
    }

    respond(environment, args, 403, w!("Blocked by AniMori"))?;

    let total = TOTAL.fetch_add(1, Ordering::Relaxed) + 1;
    let first_time = match hosts().lock() {
        Ok(mut map) => {
            let counter = map.entry(host.to_string()).or_insert(0);
            *counter += 1;
            *counter == 1
        }
        // Отравленный замок — не причина пропускать рекламу, просто молчим.
        Err(_) => false,
    };

    if first_time {
        report(window, host, total);
    }

    Ok(())
}

/// Подмена ответа — это и есть отмена запроса. Заголовок CORS обязателен: без
/// него плеер получает ошибку, а не отказ, и уходит в вечное ожидание.
unsafe fn respond(
    environment: &ICoreWebView2Environment,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    status: i32,
    reason: PCWSTR,
) -> windows::core::Result<()> {
    let response = environment.CreateWebResourceResponse(
        None,
        status,
        reason,
        w!("Access-Control-Allow-Origin: *"),
    )?;
    args.SetResponse(&response)
}

/// Первая блокировка домена уходит в журнал страницы: причина отказа плеера
/// будет видна сразу. Имя хоста экранируется — оно приходит снаружи.
fn report(window: &WebviewWindow, host: &str, total: u64) {
    let Ok(host_literal) = serde_json::to_string(host) else {
        return;
    };

    let script = format!(
        "window.__animoriNetBlocked&&window.__animoriNetBlocked({host_literal},{total})"
    );

    if let Err(e) = window.eval(script.as_str()) {
        log::warn!("Блокировщик: не удалось сообщить странице: {e}");
    }
}
