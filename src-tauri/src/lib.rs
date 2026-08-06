// Инъекция собранного бандла в WebView, открытый на внешнем URL.
// Окно создаётся здесь, а не в tauri.conf.json: initialization_script есть только
// у WebviewWindowBuilder. Метка остаётся "main" — на неё ссылается capabilities.

use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Сетевой блокировщик. Только Windows: он построен на событиях WebView2.
#[cfg(windows)]
mod adblock;

mod updater;

// Прокси для трафика окна. Без cfg сознательно: чтение настроек одинаково везде,
// разница в применении спрятана внутри модуля — на Linux будет внятное
// предупреждение в журнале, а не пропавшая настройка.
mod proxy;
mod proxy_guard;

// Не корень домена: на anilist.co/ лендинг для гостей, авторизованного уносит на /home.
const ANILIST_URL: &str = "https://anilist.co/home";

// Имена файлов зафиксированы в vite.config.ts без хешей ради этих двух макросов.
// include_str! читает файлы при компиляции, поэтому `npm run build:tauri` обязан
// отработать до cargo; cargo check по пустому dist падает ожидаемо.
const ANIMORI_JS: &str = include_str!("../../dist/animori.tauri.js");
const ANIMORI_CSS: &str = include_str!("../../dist/animori.tauri.css");

/// Что запоминается между запусками. Не StateFlags::all(): сохранённый VISIBLE даёт
/// запуск без единого окна, а из FULLSCREEN в окне без меню нечем выйти.
/// Флаги общие и на сохранение, и на восстановление: это один параметр плагина.
fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

// В режиме tauri плагин monkey отключён, вместе с ним пропал и инжект стилей:
// CSS вставляет бэкенд первым скриптом инициализации, без ещё одной зависимости.
// serde_json::to_string даёт корректный JS-литерал: в SCSS есть кавычки, слеши и переводы
// строк; ручное экранирование — готовая дыра. Скрипт идёт до создания DOM, поэтому
// есть запасной путь через DOMContentLoaded.
//
// Обратные слеши в конце строк — продолжение литерала Rust: они съедают перевод
// строки и отступ. Удвоенный слеш здесь — SyntaxError вместо вставки стилей.
fn css_injection_script() -> String {
    let css = serde_json::to_string(ANIMORI_CSS).expect("CSS bundle is not serializable");

    format!(
        "(function(){{var css={css};var add=function(){{\
         if(document.getElementById('animori-style'))return;\
         var s=document.createElement('style');s.id='animori-style';s.textContent=css;\
         (document.head||document.documentElement).appendChild(s);}};\
         if(document.head){{add();}}else{{document.addEventListener('DOMContentLoaded',add);}}}})();"
    )
}

/// Разведчик адресов кадра плеера: реклама живёт в чужом iframe (Kodik),
/// куда код со стороны anilist.co доступа не имеет. Список собран и переехал
/// в adblock.rs, но разведчик оставлен: домены меняются пачками, охоту придётся
/// повторять тем же Ctrl+Shift+S. Спящий он не стоит ничего.
///
/// Скрипт идёт во ВСЕ фреймы: обычный initialization_script попадает только в главный,
/// а весь интерес во вложенных. Бандл туда не идёт: это целый Vue в каждом iframe.
///
/// Правка после первой охоты: главный кадр дал триста источников рекламных бирж
/// и выбрал потолок до кадра плеера. Поэтому теперь в главном кадре он не работает
/// вовсе, а во вложенных молчит до команды __animoriNetProbeArm.
///
/// Собирается только сводка по источникам: полный список URL затопил бы журнал
/// сегментами видео. Канал наверх — postMessage, единственный легальный между доменами.
const NET_PROBE_SCRIPT: &str = r#"(function () {
  try {
    // Главный кадр слушает сводки, но сам ничего не собирает.
    if (window.top === window) return;
    if (window.__animoriNetProbe) return;
    window.__animoriNetProbe = true;

    var armed = false;
    var started = false;
    var timer = null;
    var seen = {};
    var dirty = false;

    function note(raw, kind) {
      if (!armed) return;
      try {
        var u = new URL(String(raw), location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        var key = kind + ' ' + u.origin;
        var rec = seen[key];
        if (!rec) {
          rec = seen[key] = { origin: u.origin, kind: kind, count: 0, sample: u.href };
          dirty = true;
        }
        rec.count++;
      } catch (e) {}
    }

    // Resource Timing видит все ресурсы кадра и надёжнее подмены fetch/XHR: подмена
    // ломается, если чужой код сохранил оригинал раньше нас. buffered: true отдаёт
    // и то, что загрузилось до подписки.
    function start() {
      if (started) return;
      started = true;
      try {
        var po = new PerformanceObserver(function (list) {
          var items = list.getEntries();
          for (var i = 0; i < items.length; i++) note(items[i].name, 'res');
        });
        po.observe({ type: 'resource', buffered: true });
      } catch (e) {}

      // Попытки открыть окно — отдельный вид, чтобы не тонули среди запросов.
      try {
        var openOriginal = window.open;
        window.open = function (target) {
          note(target || '', 'open');
          return openOriginal.apply(window, arguments);
        };
      } catch (e) {}

      if (!timer) timer = setInterval(send, 2000);
    }

    function send() {
      if (!armed || !dirty) return;
      dirty = false;
      var list = [];
      for (var key in seen) {
        if (Object.prototype.hasOwnProperty.call(seen, key)) list.push(seen[key]);
      }
      try {
        window.top.postMessage(
          { __animoriNetProbe: 1, frame: location.href, items: list },
          '*'
        );
      } catch (e) {}
    }

    // Команда повторяется каждые две секунды: кадр рекламы рождается позже
    // начала охоты и одиночную команду не застал бы.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.__animoriNetProbeArm === 1) {
        if (!armed) {
          armed = true;
          seen = {};
          dirty = false;
          start();
        }
      } else if (d.__animoriNetProbeArm === 0) {
        armed = false;
      }
    });
  } catch (e) {}
})();
"#;

/// Домен, который живёт внутри окна. Сравнение по хосту целиком или по суффиксу
/// с точкой, а не через contains: иначе подошло бы anilist.co.evil.example.
fn is_internal_host(host: &str) -> bool {
    host == "anilist.co" || host.ends_with(".anilist.co")
}

/// Перезагружает окно, из которого пришёл вызов: фронтенд сам этого не может —
/// location.reload() на внешнем URL не даёт ничего, а в JS-API метода нет вовсе.
/// Окно приходит параметром, а не ищется по метке: второе окно не сломает команду.
#[tauri::command]
fn animori_reload(window: WebviewWindow) -> Result<(), String> {
    window.reload().map_err(|e| e.to_string())
}

/// Открывает адрес в браузере по умолчанию. В WebView2 target="_blank" и window.open()
/// превращаются в запрос нового окна, и без обработчика он отбрасывается МОЛЧА:
/// ни окна, ни ошибки, ни события на стороне JS.
///
/// Схема проверяется здесь, а не только в мосте: вызов приходит из контекста
/// anilist.co, то есть от недоверенного кода. Без проверки чужой скрипт мог бы попросить
/// file:// или свою схему и запустить произвольное приложение.
#[tauri::command]
fn animori_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();

    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(format!("Схема адреса не разрешена: {trimmed}"));
    }

    // None во втором аргументе — «браузер по умолчанию».
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        // Плагин открывает адреса в системных приложениях и нужен только со стороны Rust:
        // opener:allow-open-url в окне на anilist.co открыл бы что угодно любому скрипту.
        .plugin(tauri_plugin_opener::init())
        // Память геометрии окна. Регистрация именно в цепочке Builder, а не в setup():
        // плагины оттуда поднимаются ДО setup, а окно создаётся внутри него. Плагин
        // восстановит геометрию сам; поменяешь порядок — перестанет без единой ошибки.
        // Разрешений в capabilities ему не выдано: из JS команды не вызываются.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        // Автообновление; обоснования — в updater.rs. Разрешений тоже нет, и здесь это
        // критичнее всего: updater:default означал бы право чужого скрипта запустить
        // загрузку и установку исполняемого файла.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Список команд дублируется в build.rs и capabilities/default.json: разрешено
        // ровно то, что перечислено в capability. Пропуск любого из трёх мест даёт отказ
        // вида "... not allowed. Plugin not found".
        //
        // Команды из модулей указываются с путём: generate_handler! обращается к функции
        // по имени, и без префикса сборка падает с E0425.
        .invoke_handler(tauri::generate_handler![
            proxy_guard::animori_page_ready,
            animori_reload,
            animori_open_external,
            proxy::animori_proxy_status,
            proxy::animori_proxy_probe
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Прокси — СТРОГО до создания окна: движок читает аргументы один раз, на первом
            // окне. Переставишь ниже build() — прокси тихо перестанет применяться.
            // Здесь же заводится ProxyState, без которого animori_proxy_status не ответит.
            proxy::apply_to_webview(app.handle());

            // Копия дескриптора для замыкания on_navigation: сам app взят по ссылке.
            let handle = app.handle().clone();

            // Порядок скриптов важен: стили раньше бандла, иначе первые Vue-приложения
            // мелькнут без оформления. inner_size и center — геометрия только первого запуска:
            // сохранённое состояние перекроет их, а min_inner_size страхует от непригодного размера.
            let main_window = WebviewWindowBuilder::new(
                app.handle(),
                "main",
                WebviewUrl::External(ANILIST_URL.parse()?),
            )
            .title("AniMori")
            .inner_size(1280.0, 800.0)
            .min_inner_size(1024.0, 600.0)
            .resizable(true)
            .center()
            .initialization_script(css_injection_script())
            .initialization_script(ANIMORI_JS)
            // Разведчик ставится ПОСЛЕ бандла: в главном фрейме скрипты идут по порядку
            // регистрации, и приёмник сводки должен быть готов раньше первого сообщения.
            .initialization_script_for_all_frames(NET_PROBE_SCRIPT)
            // Страховка на стороне оболочки. Перехватчик кликов в features/ui/links.ts
            // не ловит навигацию без клика: редирект с сервера, location.assign, баннер
            // в iframe плеера. Окно без тулбара стало бы ловушкой на чужом сайте.
            //
            // Схемы кроме http/https пропускаем: на первом шаге бывают about:blank и data:,
            // и отказ от них сломал бы загрузку самого окна.
            .on_navigation(move |url| {
                let scheme = url.scheme();
                if scheme != "http" && scheme != "https" {
                    return true;
                }

                match url.host_str() {
                    Some(host) if is_internal_host(host) => true,
                    Some(_) => {
                        // Ошибку только пишем в журнал: отказ браузера не повод впускать
                        // внешний сайт в окно приложения.
                        if let Err(e) = handle.opener().open_url(url.as_str(), None::<&str>) {
                            log::warn!("Не удалось открыть внешний адрес {url}: {e}");
                        }
                        false
                    }
                    None => true,
                }
            })
            .build()?;

            // Блокировщик — сразу после создания окна: подписка действует только на те
            // запросы, что уйдут после неё.
            #[cfg(windows)]
            adblock::install(&main_window);

            // На не-Windows окно больше нигде не нужно — глушим предупреждение.
            #[cfg(not(windows))]
            let _ = &main_window;

            proxy_guard::spawn(app.handle());

            // Проверка обновлений — последним шагом и только фоновой задачей: запрос
            // прямо здесь задержал бы окно на ответ GitHub, а при мёртвой сети — на весь таймаут.
            updater::spawn_check(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
