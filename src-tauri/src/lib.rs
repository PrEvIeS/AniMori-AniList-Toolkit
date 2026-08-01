// Пункт 4.3: инъекция собранного бандла в WebView, который открыт на внешнем URL.
//
// Окно создаётся здесь, а не в tauri.conf.json: initialization_script есть только у
// WebviewWindowBuilder, и для окна, объявленного в конфиге, добавить его после
// создания невозможно. Метка остаётся "main" — на неё ссылается capabilities.

use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Пункт 4.7, часть 2: сетевой блокировщик рекламы. Только Windows: он целиком
// построен на событиях WebView2, которых на других платформах просто не существует.
#[cfg(windows)]
mod adblock;

// Стартовая страница. Не корень домена: на anilist.co/ стоит лендинг для гостей,
// а авторизованного пользователя всё равно уносит на /home.
const ANILIST_URL: &str = "https://anilist.co/home";

// Сборка режима tauri (пункт 4.6). Имена файлов зафиксированы в vite.config.ts
// без хешей именно ради этих двух макросов.
//
// include_str! читает файлы на этапе компиляции, поэтому `npm run build:tauri` обязан
// отработать до cargo. В релизной сборке это делает beforeBuildCommand; вручную
// cargo check по пустому dist упадёт — это ожидаемое поведение, не баг.
const ANIMORI_JS: &str = include_str!("../../dist/animori.tauri.js");
const ANIMORI_CSS: &str = include_str!("../../dist/animori.tauri.css");

/// Пункт 4.5: что именно запоминается между запусками.
///
/// Сознательно не StateFlags::all(): туда входят ещё VISIBLE, DECORATIONS и FULLSCREEN.
/// Сохранённый VISIBLE — прямая дорога к приложению, которое после неудачного
/// завершения запускается без единого окна: процесс в диспетчере есть, окна нет,
/// и пользователь ничего не может с этим сделать. Полноэкранный режим не храним по той
/// же причине: выйти из него в окне без меню нечем, кроме горячей клавиши.
///
/// Одни и те же флаги идут и на сохранение, и на восстановление: это один параметр
/// плагина, а не два разных списка.
fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

// В режиме tauri плагин monkey отключён, а вместе с ним пропал и его автоматический
// инжект стилей — CSS ложится отдельным файлом. Поднимать ради этого ещё одну
// npm-зависимость не стали: стили вставляет бэкенд первым скриптом инициализации.
//
// serde_json::to_string даёт корректный JS-литерал: в SCSS есть и кавычки, и обратные
// слеши, и переводы строк; ручное экранирование здесь — готовая дыра.
//
// Скрипт инициализации выполняется до создания DOM, поэтому document.head может
// ещё отсутствовать — тогда вставляем по DOMContentLoaded.
//
// Обратные слеши в конце строк — это продолжение строкового литерала Rust:
// они съедают перевод строки и отступ, чтобы в JS ушла одна строка. Удвоенный
// слеш здесь был бы ошибкой: в код попал бы литеральный бакслеш и WebView
// споткнулся бы на SyntaxError вместо вставки стилей.
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

/// Разведка к пункту 4.7: куда вообще ходит кадр плеера.
///
/// Зачем это нужно. Рекламный оверлей появляется внутри чужого iframe (Kodik),
/// куда код со стороны anilist.co не имеет доступа вообще. Чтобы потом блокировать
/// рекламу точечно, а не по догадкам, сначала надо увидеть список адресов, к которым
/// обращается плеер.
///
/// Статус на 02.08.2026: охота состоялась, список собран и переехал в adblock.rs.
/// Разведчик ОСТАВЛЕН сознательно: рекламные домены меняются пачками, и когда
/// реклама вернётся, охоту надо будет повторить тем же Ctrl+Shift+S. Спящий разведчик
/// не стоит ничего: без команды он не подписывается даже на события.
///
/// Скрипт вешается на ВСЕ фреймы (initialization_script_for_all_frames), потому что
/// обычный initialization_script попадает только в главный фрейм, а весь интерес
/// как раз во вложенных. Бандл туда не идёт и идти не должен: это полтора сотни
/// килобайт и целый Vue в каждом рекламном iframe.
///
/// ПРАВКА ПОСЛЕ ПЕРВОЙ ОХОТЫ. Первый заход собрал триста источников главной страницы
/// (AniList торгует рекламой через полторы сотни бирж) и до кадра плеера просто
/// не добрался: потолок выбрался за секунды. Поэтому теперь
///
///   1. в главном кадре разведчик не работает вовсе — там нечего ловить, рекламу
///      самого сайта режет CSS-блокировщик;
///   2. во вложенных кадрах он молчит, пока из приложения не придёт команда
///      __animoriNetProbeArm. Охота начинается по Ctrl+Shift+S, и в улов попадает
///      только то, что случилось после нажатия.
///
/// Что собирается: только сводка по источникам (схема + хост) с одним примером
/// адреса и счётчиком. Полный список URL собирать нельзя: видео едет сотнями
/// сегментов в минуту и затопит любой журнал. Сводка уходит в главный фрейм
/// через postMessage — единственный легальный канал между чужими доменами.
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

    // Resource Timing видит все подгружаемые ресурсы кадра: скрипты, картинки,
    // fetch, XHR, медиа. Это надёжнее подмены fetch/XMLHttpRequest: подмена
    // ломается, если чужой код сохранил ссылку на оригинал раньше нас.
    // buffered: true отдаёт и то, что успело загрузиться до подписки, поэтому
    // поздний старт охоты не теряет историю кадра.
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

      // Попытки открыть окно фиксируются отдельным видом: если они всё же есть,
      // это сразу видно в отчёте, а не тонет среди обычных запросов.
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

    // Команда приходит сверху и повторяется каждые две секунды: кадр рекламы
    // рождается позже начала охоты, и одиночную команду он бы не застал.
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

/// Домен, который живёт внутри окна. Всё остальное — внешние ресурсы.
///
/// Сравнение идёт по хосту целиком или по суффиксу с точкой, а не через contains:
/// иначе подошла бы и строка вида anilist.co.evil.example.
fn is_internal_host(host: &str) -> bool {
    host == "anilist.co" || host.ends_with(".anilist.co")
}

/// Перезагружает окно, из которого пришёл вызов.
///
/// Пункт 4.3, правка по итогам первого живого запуска. Фронтенд не может перезагрузить
/// себя сам: location.reload() в окне на внешнем URL не даёт ничего, а в JS-API Tauri
/// метода перезагрузки у класса Webview нет вовсе. На стороне Rust такой метод есть.
///
/// Окно приходит параметром, а не ищется по метке "main": если на пункте 4.7 появятся
/// дополнительные окна, команда останется верной без правок.
///
/// Ошибка превращается в строку: tauri::Error не сериализуема, а мост на стороне JS
/// пишет текст отказа в журнал.
#[tauri::command]
fn animori_reload(window: WebviewWindow) -> Result<(), String> {
    window.reload().map_err(|e| e.to_string())
}

/// Открывает адрес в браузере по умолчанию.
///
/// Пункт 4.5. В браузере внешнюю ссылку открывает сама вкладка: target="_blank"
/// и window.open() работают без участия кода. В WebView2 то и другое превращается в
/// запрос создать новое окно, и без обработчика запрос отбрасывается МОЛЧА: ни нового
/// окна, ни ошибки, ни события на стороне JS — именно поэтому ссылка «здесь» во вкладке
/// «Аккаунт» не оставляла даже записи в логгере.
///
/// Схема проверяется здесь, а не только в мосте: вызов приходит из контекста anilist.co,
/// а это недоверенный код с чужого сайта. Без проверки любой скрипт на странице мог бы
/// попросить открыть file:// или свою схему — то есть запустить произвольное приложение
/// на машине пользователя. Разрешены только http и https.
#[tauri::command]
fn animori_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();

    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(format!("Схема адреса не разрешена: {trimmed}"));
    }

    // Второй аргумент — конкретное приложение. None означает «браузер по умолчанию»,
    // и именно этого ждёт пользователь от внешней ссылки.
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
        // Пункт 4.5: плагин открывает адреса и файлы в системных приложениях.
        // Нужен только со стороны Rust, из JS его команды не вызываются: выдавать
        // контексту anilist.co opener:allow-open-url — значит позволить любому скрипту
        // сайта открывать что угодно. Вместо этого есть своя команда с проверкой схемы.
        .plugin(tauri_plugin_opener::init())
        // Пункт 4.5: память геометрии окна между запусками.
        //
        // Регистрация именно здесь, в цепочке Builder, а не внутри setup(): плагины
        // из цепочки поднимаются ДО setup, а наше окно создаётся внутри setup. Плагин
        // восстанавливает геометрию сам, сразу после создания окна, поэтому ручной вызов
        // restore_state() не нужен. Поменяешь порядок — окно перестанет восстанавливаться
        // без единой ошибки на сборке.
        //
        // Из JS команды плагина не вызываются, поэтому window-state:default в
        // capabilities/default.json сознательно НЕ добавлен: окно открыто на чужом сайте,
        // и лишние разрешения там — это разрешения для кода anilist.co, а не для нашего.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        // Список команд дублируется в build.rs (AppManifest::commands) и в
        // capabilities/default.json. Так устроен ACL для окна на внешнем URL: разрешено
        // ровно то, что перечислено в capability, а регистрации здесь недостаточно. Пропуск
        // любого из трёх мест даёт отказ вида "... not allowed. Plugin not found".
        .invoke_handler(tauri::generate_handler![animori_reload, animori_open_external])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Копия дескриптора приложения для замыкания on_navigation: сам app взят
            // по ссылке и в замыкание с 'static его не отдать.
            let handle = app.handle().clone();

            // Порядок скриптов важен: стили регистрируются раньше бандла, иначе первые
            // смонтированные Vue-приложения успеют мелькнуть без оформления.
            //
            // Пункт 4.5: inner_size и center остаются, но теперь это только геометрия первого
            // запуска: если сохранённое состояние есть, плагин перекроет их сразу после
            // создания окна. min_inner_size при этом остаётся нижней границей и страхует от
            // восстановления непригодного к работе размера.
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
            // Разведка к 4.7. Ставится ПОСЛЕ бандла: в главном фрейме скрипты идут
            // по порядку регистрации, и приёмник сводки из бандла должен быть готов раньше,
            // чем уйдёт первое сообщение. Во вложенные фреймы идёт ТОЛЬКО этот скрипт.
            .initialization_script_for_all_frames(NET_PROBE_SCRIPT)
            // Пункт 4.5, страховка на стороне оболочки.
            //
            // Основную работу делает перехватчик кликов в features/ui/links.ts, но полагаться
            // только на него нельзя: навигация бывает и без клика — редирект с сервера,
            // вызов location.assign из кода сайта, баннер внутри iframe плеера. Окно без
            // тулбара и без кнопки «назад» превратилось бы в ловушку на чужом сайте.
            //
            // Внутри окна остаётся только anilist.co; остальное уходит в системный браузер,
            // а навигация отменяется возвратом false. Схемы кроме http/https пропускаем
            // без обработки: на первом шаге здесь бывает about:blank и data:, и отказ от них
            // сломал бы загрузку самого окна.
            .on_navigation(move |url| {
                let scheme = url.scheme();
                if scheme != "http" && scheme != "https" {
                    return true;
                }

                match url.host_str() {
                    Some(host) if is_internal_host(host) => true,
                    Some(_) => {
                        // Ошибку только пишем в журнал: отказ системного браузера не повод
                        // впускать внешний сайт в окно приложения.
                        if let Err(e) = handle.opener().open_url(url.as_str(), None::<&str>) {
                            log::warn!("Не удалось открыть внешний адрес {url}: {e}");
                        }
                        false
                    }
                    None => true,
                }
            })
            .build()?;

            // Пункт 4.7: сетевой блокировщик. Подключается СРАЗУ после создания окна
            // и до того, как страница начнёт грузить своё: подписка на событие запроса действует
            // только на те запросы, что уйдут после неё.
            #[cfg(windows)]
            adblock::install(&main_window);

            // На не-Windows окно больше нигде не нужно, а предупреждение о неиспользованной
            // переменной в сборке никому не нужно.
            #[cfg(not(windows))]
            let _ = &main_window;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
