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
//
// Часть четвёртая (по живому случаю): перед передачей адреса движку проверяем,
// отвечает ли прокси вообще. Причина важнее, чем аккуратность: панель настроек
// живёт ВНУТРИ страницы. Если из-за мёртвого прокси страница не загрузилась,
// выключить прокси человеку уже нечем: один опечатанный порт превращает приложение
// в кирпич, который лечится только правкой файла настроек руками.
//
// Пункт 5.3.6: исход применения больше не пропадает в журнале.
//
// Прежде о том, что прокси не отвечает, знал только журнал — то есть никто: журнал
// пишется лишь в отладочной сборке, а человек видел молча включённый тумблер и
// страницу, которая почему-то идёт напрямую. Теперь исход складывается в состояние
// приложения и отдаётся панели настроек командой animori_proxy_status. Отдельная
// команда animori_proxy_probe перечитывает файл настроек и щупает адрес заново —
// это ответ на вопрос «а сейчас-то он жив?» без перезапуска приложения.
//
// Важно не перепутать два разных вопроса, на которые они отвечают:
//   status — что случилось ПРИ ЗАПУСКЕ и что действует в окне прямо сейчас;
//   probe  — что записано в настройках СЕЙЧАС и отвечает ли этот адрес.
// После правки настроек они законно расходятся, и панель обязана показывать это
// как «применится после перезапуска», а не как противоречие.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

/// Файл настроек. То же имя, что у LazyStore в src/bridge/TauriBridge.ts: файл один,
/// и читают его обе стороны.
const STORE_FILE: &str = "animori-settings.json";

/// Сколько ждём ответа от прокси на старте.
///
/// Полсекунды — компромисс. Проверка идёт в setup(), то есть задерживает появление
/// окна, и больше тратить на неё нельзя. Для местного прокси (а почти всегда это
/// он) за глаза достаточно.
const PROBE_TIMEOUT_MS: u64 = 500;

/// Сколько ждём ответа при проверке по кнопке.
///
/// Здесь можно быть щедрее: человек нажал сам, видит надпись «проверяю» и ждёт
/// ответа. Полсекунды на этом месте были бы вредны — удалённый прокси в другой
/// стране успевает ответить за секунду и был бы объявлен мёртвым зря.
const PROBE_TIMEOUT_MANUAL_MS: u64 = 2000;

/// Сколько ждём разбора имени в адрес.
///
/// Дефект, найденный при разборе этого модуля: PROBE_TIMEOUT_MS ограничивает только
/// само соединение, а to_socket_addrs() ходит к системному резолверу и своего
/// таймаута не имеет вовсе. При мёртвом DNS (обычное дело, когда сеть поднята через
/// тот самый прокси, который сейчас не работает) разбор имени висит десятки секунд,
/// и всё это время приложение стоит в setup() БЕЗ ЕДИНОГО ОКНА на экране. Со стороны
/// это выглядит как «не запускается».
const RESOLVE_TIMEOUT_MS: u64 = 700;

// Ключи хранилища. Объявлены в src/core/proxy.ts (PROXY_KEYS) и повторены здесь:
// сторона Rust к модулям TypeScript доступа не имеет. Разойтись они не должны.
const KEY_ENABLED: &str = "set_proxy_on";
const KEY_KIND: &str = "set_proxy_kind";
const KEY_HOST: &str = "set_proxy_host";
const KEY_PORT: &str = "set_proxy_port";
const KEY_LOGIN: &str = "set_proxy_login";
const KEY_BYPASS: &str = "set_proxy_bypass";

/// Исключения по умолчанию.
///
/// Второй дефект того же разбора. DEFAULT_PROXY.bypass в src/core/proxy.ts равен
/// "localhost, 127.0.0.1", а здесь отсутствующий ключ читался как пустая строка —
/// то есть до первого сохранения настроек два канала расходились: наш ходил на
/// местные адреса напрямую, а окно гнало и их через прокси. Для прокси, поднятого
/// на этой же машине, это петля.
///
/// Подставляется ТОЛЬКО когда ключа нет вовсе. Пустая строка в файле — это уже
/// осознанный выбор человека, стереть исключения, и перебивать его нельзя.
const DEFAULT_BYPASS: &str = "localhost, 127.0.0.1";

/// Чем кончилось применение настройки.
///
/// Ровно четыре исхода, и каждый требует от панели своих слов:
///   Off         — прокси выключен, окно идёт напрямую. Это норма, не отказ.
///   Invalid     — включён, но адрес или порт заданы негодно.
///   Unreachable — включён и задан, но не ответил. Сработала страховка от кирпича.
///   Applied     — адрес отдан движку окна.
///
/// Applied означает лишь «движок получил адрес». Живой прокси, который принимает
/// соединение, но наружу не пускает, тоже даст Applied — TCP-щуп такого не отличит.
/// Поэтому в панели рядом стоит боевой запрос: только он отвечает на вопрос,
/// доходит ли трафик до цели.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyOutcome {
    Off,
    Invalid,
    Unreachable,
    Applied,
}

/// Что действует в окне прямо сейчас. Снимок делается один раз, при запуске.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    outcome: ProxyOutcome,
    /// Адрес, отданный движку. Пусто для всех исходов, кроме Applied.
    server: String,
    /// Задан ли у прокси логин. Панель по этому полю объясняет, почему страница
    /// может спросить пароль отдельно от наших запросов.
    has_credentials: bool,
}

/// Результат проверки по кнопке. Отвечает про то, что записано в настройках СЕЙЧАС.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProbe {
    /// Здесь Applied читается как «отвечает и был бы применён при следующем запуске».
    outcome: ProxyOutcome,
    server: String,
    has_credentials: bool,
    /// Сколько заняло соединение. Ноль, когда до щупа дело не дошло.
    latency_ms: u64,
}

/// Состояние живёт в самом приложении: команда status вызывается из окна, а окно
/// про setup() ничего не знает. Mutex, а не просто значение, — требование Tauri к
/// разделяемому состоянию; переписывается оно всё равно только один раз.
pub struct ProxyState(Mutex<ProxyStatus>);

/// Разобранная настройка в том виде, в каком её принимает движок окна.
struct ProxyArgs {
    /// Адрес без схемы и порт отдельно: только в таком виде их принимает проверка связи.
    host: String,
    port: u16,
    /// Значение для --proxy-server, например http://10.0.0.1:8080 или socks5://127.0.0.1:1080.
    server: String,
    /// Значение для --proxy-bypass-list. Пусто, если исключений нет.
    bypass: String,
    /// Заданы ли учётные данные. Влияет только на предупреждение в журнале, см. ниже.
    has_credentials: bool,
}

/// Три состояния файла настроек. Раньше здесь был Option, и «выключен» не отличался
/// от «включён, но задан негодно» — а панели надо сказать про них разное.
enum Config {
    Off,
    Invalid,
    On(Box<ProxyArgs>),
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

/// Разбирает имя в адреса, но не дольше отведённого срока.
///
/// Своего таймаута у to_socket_addrs() нет, и навязать его нельзя — поэтому разбор
/// уезжает в отдельный поток, а ждём мы канал. Брошенный поток при этом допустим:
/// он ничего не держит и завершится сам, когда резолвер наконец ответит. Плата за
/// такую страховку — один поток на неудачную попытку, что несравнимо дешевле
/// приложения, зависшего до появления окна.
fn resolve_with_timeout(target: &str, timeout: Duration) -> Option<Vec<SocketAddr>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let owned = target.to_string();

    std::thread::spawn(move || {
        let resolved = owned.to_socket_addrs().map(|it| it.collect::<Vec<_>>());
        // Ошибку отправки глушим осознанно: она означает лишь, что ожидающая сторона
        // уже сдалась по таймауту и получателя больше нет.
        let _ = tx.send(resolved);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(addrs)) => Some(addrs),
        Ok(Err(e)) => {
            log::warn!("Прокси: не удалось разобрать адрес {target}: {e}");
            None
        }
        Err(_) => {
            log::warn!("Прокси: разбор адреса {target} не уложился в отведённое время");
            None
        }
    }
}

/// Отвечает ли прокси вообще.
///
/// Проверка самая грубая из возможных: удалось ли открыть TCP-соединение. Она НЕ
/// отвечает на вопрос, работает ли прокси по сути: живой прокси может не пускать
/// наружу, требовать пароль или говорить на другом протоколе. Цель скромнее и важнее:
/// отсечь опечатки и выключенные клиенты прокси, из-за которых окно остаётся пустым
/// и неуправляемым.
///
/// Возвращает время соединения — панели есть что показать, а заодно это единственный
/// внятный признак «прокси отвечает, но еле-еле».
fn probe(host: &str, port: u16, timeout_ms: u64) -> (bool, u64) {
    let target = format!("{host}:{port}");
    let started = Instant::now();

    let Some(addrs) = resolve_with_timeout(&target, Duration::from_millis(RESOLVE_TIMEOUT_MS))
    else {
        return (false, started.elapsed().as_millis() as u64);
    };

    // Имя может развернуться в несколько адресов (IPv6 и IPv4): достаточно любого
    // ответившего, именно так поступит и сам движок.
    let ok = addrs
        .iter()
        .any(|addr| TcpStream::connect_timeout(addr, Duration::from_millis(timeout_ms)).is_ok());

    (ok, started.elapsed().as_millis() as u64)
}

/// Читает настройку прокси из файла настроек.
fn read_config(app: &AppHandle) -> Config {
    // Ошибку открытия файла глушить нельзя (инвариант 4), но и падать из-за неё незачем:
    // без файла настроек приложение работает на значениях по умолчанию, то есть напрямую.
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            log::warn!("Не удалось открыть файл настроек для чтения прокси: {e}");
            return Config::Off;
        }
    };

    let enabled = matches!(store.get(KEY_ENABLED), Some(serde_json::Value::Bool(true)));
    if !enabled {
        return Config::Off;
    }

    let host = read_string(store.get(KEY_HOST));
    let port = read_port(store.get(KEY_PORT));

    if host.is_empty() || port == 0 {
        // Включён, но настроен негодно. Тот же случай разбирается и на стороне JS,
        // и молчать о нём нельзя: человек видит включённый тумблер и считает, что
        // трафик идёт через прокси.
        log::warn!("Прокси включён, но адрес или порт заданы неверно — окно идёт напрямую");
        return Config::Invalid;
    }

    // Неизвестное значение трактуется как http, как и normalizeProxyKind() в TypeScript.
    let scheme = if read_string(store.get(KEY_KIND)) == "socks5" {
        "socks5"
    } else {
        "http"
    };

    // Отсутствие ключа и пустое значение — разные вещи, см. DEFAULT_BYPASS.
    let raw_bypass = match store.get(KEY_BYPASS) {
        None => DEFAULT_BYPASS.to_string(),
        Some(value) => read_string(Some(value)),
    };

    // Chromium ждёт список исключений через точку с запятой. Пользователь пишет их как
    // придётся, поэтому разделителями считаем и запятую, и перевод строки. Пробелы внутри
    // записи отбрасываем вместе с записью: в имени хоста их быть не может, а пробел
    // в аргументе командной строки разорвал бы саму строку аргументов.
    let bypass = raw_bypass
        .split(|c| c == ',' || c == ';' || c == '\n' || c == '\r')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty() && !item.contains(' '))
        .collect::<Vec<_>>()
        .join(";");

    Config::On(Box::new(ProxyArgs {
        server: format!("{scheme}://{host}:{port}"),
        host,
        port,
        bypass,
        has_credentials: !read_string(store.get(KEY_LOGIN)).is_empty(),
    }))
}

/// Передаёт настройку прокси движку окна и запоминает исход.
///
/// Вызывается ОДИН раз, в начале setup() и до создания окна. Подробности про момент —
/// в шапке модуля. Состояние кладётся здесь же: так его нельзя забыть завести, а
/// команда status гарантированно найдёт готовый ответ.
pub fn apply_to_webview(app: &AppHandle) {
    // app.restart() отдаёт потомку окружение родителя: без сноса старый --proxy-server
    // переживает выключение прокси.
    #[cfg(windows)]
    std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

    let status = decide(app);
    app.manage(ProxyState(Mutex::new(status)));
}

fn decide(app: &AppHandle) -> ProxyStatus {
    let args = match read_config(app) {
        Config::Off => {
            return ProxyStatus {
                outcome: ProxyOutcome::Off,
                server: String::new(),
                has_credentials: false,
            }
        }
        Config::Invalid => {
            return ProxyStatus {
                outcome: ProxyOutcome::Invalid,
                server: String::new(),
                has_credentials: false,
            }
        }
        Config::On(args) => args,
    };

    // Страховка от кирпича: мёртвый адрес движку не отдаём. Иначе вместо сайта
    // открывается страница ошибки движка, а вместе с сайтом пропадает и панель настроек,
    // то есть единственный способ выключить прокси обратно.
    let (reachable, _) = probe(&args.host, args.port, PROBE_TIMEOUT_MS);
    if !reachable {
        log::warn!(
            "Прокси {} не отвечает — окно идёт напрямую. \
             Настройка не сброшена: исправьте адрес или выключите прокси в настройках",
            args.server
        );
        return ProxyStatus {
            outcome: ProxyOutcome::Unreachable,
            server: args.server,
            has_credentials: args.has_credentials,
        };
    }

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

        ProxyStatus {
            outcome: ProxyOutcome::Applied,
            server: args.server,
            has_credentials: args.has_credentials,
        }
    }

    #[cfg(not(windows))]
    {
        let _ = &value;
        log::warn!("Прокси для окна на этой платформе пока не поддержан — страница идёт напрямую");

        // Не Applied: на этой платформе адрес движку никто не отдавал, и панель обязана
        // говорить об этом прямо, а не рисовать зелёную галочку.
        ProxyStatus {
            outcome: ProxyOutcome::Unreachable,
            server: args.server,
            has_credentials: args.has_credentials,
        }
    }
}

/// Что действует в окне прямо сейчас.
///
/// Ответ мгновенный: это снимок, сделанный при запуске, в сеть команда не ходит.
/// Меняться он не может по своей природе — движок читает прокси один раз.
#[tauri::command]
pub fn animori_proxy_status(state: State<'_, ProxyState>) -> ProxyStatus {
    // Отравленный мьютекс не повод отказывать: внутри обычная структура без
    // инвариантов, которые могла бы нарушить паника в другом потоке.
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.clone()
}

/// Исход и адрес прокси для сторожа страницы (пункт 5.3.7, proxy_guard.rs).
///
/// Отдельная функция, а не публичные поля ProxyStatus: наружу нужны ровно два
/// значения, а структура целиком — это ответ команде, и её форма подчинена
/// сериализации для страницы, а не удобству соседнего модуля.
///
/// None означает, что состояние ещё не заведено. В штатном порядке такого не бывает:
/// apply_to_webview() отрабатывает в начале setup(), задолго до создания окна. Но
/// падать из-за перестановки вызовов в lib.rs сторож не вправе — его дело второстепенное.
pub fn current_status(app: &AppHandle) -> Option<(ProxyOutcome, String)> {
    let state = app.try_state::<ProxyState>()?;
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    Some((guard.outcome, guard.server.clone()))
}

/// Проверить прокси прямо сейчас.
///
/// Перечитывает файл настроек ЗАНОВО, а не берёт снимок: смысл кнопки как раз в том,
/// чтобы проверить только что введённый адрес до перезапуска приложения.
///
/// Обязательно spawn_blocking: и чтение файла, и разбор имени, и соединение блокируют
/// поток целиком. В обычном асинхронном обработчике они бы встали поперёк цикла
/// событий, и интерфейс замер бы на всё время проверки — до двух с половиной секунд.
#[tauri::command]
pub async fn animori_proxy_probe(app: AppHandle) -> Result<ProxyProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = match read_config(&app) {
            Config::Off => {
                return ProxyProbe {
                    outcome: ProxyOutcome::Off,
                    server: String::new(),
                    has_credentials: false,
                    latency_ms: 0,
                }
            }
            Config::Invalid => {
                return ProxyProbe {
                    outcome: ProxyOutcome::Invalid,
                    server: String::new(),
                    has_credentials: false,
                    latency_ms: 0,
                }
            }
            Config::On(args) => args,
        };

        let (reachable, latency_ms) = probe(&args.host, args.port, PROBE_TIMEOUT_MANUAL_MS);

        ProxyProbe {
            outcome: if reachable {
                ProxyOutcome::Applied
            } else {
                ProxyOutcome::Unreachable
            },
            server: args.server,
            has_credentials: args.has_credentials,
            latency_ms,
        }
    })
    .await
    .map_err(|e| format!("Проверка прокси не завершилась: {e}"))
}
