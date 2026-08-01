// Пункт 4.7, часть 2: блокировка рекламных ЗАПРОСОВ в самом движке окна.
//
// ПОЧЕМУ ЗДЕСЬ, А НЕ В ЮЗЕРСКРИПТЕ. Рекламный ролик поверх видео грузит сам плеер
// внутри своего кадра (kodikplayer.com). Это чужой домен: код со стороны anilist.co
// не видит ни его DOM, ни его запросов и отменить их не может ни при каких условиях.
// Единственная точка, где видны ВСЕ запросы окна сразу — событие WebResourceRequested
// самого WebView2. Модуль features/adblock в юзерскрипте остаётся на своём месте: он
// прячет баннеры самого AniList через CSS и работает также в браузере.
//
// ОТКУДА СПИСОК. Из живой охоты 02.08.2026: разведчик (net-probe) собрал всю цепочку
// от первого обращения плеера к биржам до самого ролика (adstag0102.xyz/video/0/901.mp4).
// Ничего в списке не взято «по памяти» или из чужих списков.
//
// ДВА СЛОЯ ПРАВИЛ. Одних доменов мало: победитель того аукциона жил на домене
// с номером в имени (adstag0102), причём даже поддомен меняется от запуска к запуску
// (r5, cdn2, v3…). Поэтому есть второй слой — приметы в самом адресе (vast, vpaid,
// cookie-sync и прочее): это стандарты видеорекламы, и новый домен попадётся на них
// без всяких правок списка.
//
// БЕЛЫЙ СПИСОК ПРОВЕРЯЕТСЯ ПЕРВЫМ и всегда побеждает. Без него приметы из второго
// слоя однажды совпадут с адресом самого видео или нашего же API, и человек увидит
// не «реклама пропала», а «плеер не запускается». Отдельно важен localhost: на нём живёт
// внутренняя связь с оболочкой (ipc.localhost) — его блокировка убьёт всё приложение.
//
// КАК ПРИЛОЖЕНИЕ УПРАВЛЯЕТ БЛОКИРОВЩИКОМ. Страница дёргает служебный адрес
// https://adblock.animori.invalid/on или /off, а блокировщик перехватывает этот запрос
// и переключается. Так тумблер в настройках управляет и сетевым блокировщиком тоже,
// и при этом не появляется ни новой команды, ни нового разрешения в capabilities — а значит
// и новой возможности для чужого кода сайта. Домен .invalid зарезервирован стандартом
// и не разрешается в сети никогда: даже если перехвата не случится, запрос просто
// никуда не уйдёт.
//
// КАК ЧЕЛОВЕК ВИДИТ РАБОТУ. Первая блокировка каждого домена уходит в страницу
// через window.__animoriNetBlocked, оттуда — в обычный журнал. Это не косметика:
// если когда-нибудь плеер перестанет запускаться, причина будет видна за минуту
// («заблокирован такой-то домен»), а не за вечер гаданий. Повторные блокировки того же
// домена только считаются: иначе один рекламный плеер затопит журнал за полминуты.

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

/// Служебный хост, через который страница включает и выключает блокировщик.
const CONTROL_HOST: &str = "adblock.animori.invalid";

/// Состояние блокировщика. По умолчанию включён: первые запросы кадра плеера
/// могут уйти раньше, чем страница успеет сообщить свою настройку, и лучше в этот
/// промежуток резать лишнее, чем пропустить ролик.
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Сколько запросов отбито за сессию — второй аргумент в записи журнала.
static TOTAL: AtomicU64 = AtomicU64::new(0);

/// Счётчики по доменам. Нужны только чтобы писать в журнал один раз на домен.
fn hosts() -> &'static Mutex<HashMap<String, u64>> {
    static HOSTS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Что не трогаем никогда. Проверяется первым.
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

/// Рекламные и следящие домены. Сравнение — совпадение целиком или поддомен.
///
/// Первый блок — цепочка плеера Kodik из охоты 02.08.2026.
/// Второй — биржи самого AniList: они не мешают смотреть, но качают трафик
/// и грузят страницу на пустом месте: CSS их всё равно прячет.
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

/// Приметы в адресе. Проверяются только после белого списка.
///
/// vast и vpaid — два стандарта видеорекламы; именно ими плеер запрашивал ролик
/// у всех четырнадцати посредников подряд. Остальное — синхронизация идентификаторов
/// между биржами (то, чем была забита первая охота).
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

/// Хост из адреса без схемы, логина и порта.
///
/// Свой разбор, а не url::Url: разбор полного адреса с выделением памяти на каждый
/// запрос окна — а их сотни в минуту только на сегментах видео — цена не по задаче.
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

/// Совпадение хоста с правилом: целиком или как поддомен.
///
/// Сравнение именно такое, а не contains: иначе под правило "media.net" попало бы
/// что-нибудь вроде "socialmedia.network", а под "anilist.co" — "anilist.co.evil.example".
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

/// Подключает блокировщик к окну. Ошибка не валит приложение: без блокировщика
/// программа остаётся работоспособной, просто с рекламой.
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

/// Подписка на событие запроса.
///
/// Фильтр "*" с контекстом ALL — это все виды ресурсов. Сузить его нельзя:
/// реклама ходит и за скриптами, и за XHR, и за видеофайлом.
///
/// ГЛАВНОЕ — ВТОРОЙ ПАРАМЕТР ОБ ИСТОЧНИКАХ ЗАПРОСА. Старый вызов
/// AddWebResourceRequestedFilter без него охватывает ТОЛЬКО главный документ:
/// запросы из вложенных кадров событие НЕ поднимают, и сам Microsoft пометил тот вызов
/// как устаревший именно из-за этого. Именно на этом блокировщик промахнулся в первой
/// живой проверке 02.08.2026: реклама плеера живёт ровно во вложенном кадре, то есть
/// в единственном месте, куда старый фильтр не смотрит.
///
/// Новый вызов живёт в более свежей версии интерфейса, поэтому есть отступление
/// на старый: на древнем рантайме WebView2 лучше резать хотя бы рекламу самого сайта,
/// чем отвалиться целиком.
unsafe fn attach(
    controller: ICoreWebView2Controller,
    window: WebviewWindow,
) -> windows::core::Result<()> {
    let core = controller.CoreWebView2()?;
    let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;

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

    // Тип токена подписки берётся из самой функции add_WebResourceRequested.
    // Писать его имя руками нельзя: в разных версиях привязок WebView2 он лежит
    // в разных местах, и сборка ломается на ровном месте при обновлении зависимостей.
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

    // Адрес отдаётся через COM-память, которую обязан освободить вызывающий.
    // Без CoTaskMemFree это утечка на КАЖДЫЙ запрос окна, а их сотни в минуту.
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

/// Подменяет ответ на свой — именно так WebView2 отменяет запрос.
///
/// Заголовок Access-Control-Allow-Origin обязателен: без него чужой код получит
/// не «отказ», а ошибку CORS, и некоторые плееры в таком случае уходят в вечное ожидание
/// вместо того, чтобы просто пропустить ролик.
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

/// Сообщает странице о первой блокировке домена.
///
/// Значения прогоняются через serde_json, а не подставляются в строку как есть:
/// имя хоста приходит снаружи, и кавычка в нём превратилась бы в чужой код в нашей
/// странице.
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
