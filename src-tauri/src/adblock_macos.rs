// Сетевой блокировщик для macOS: декларативные правила WKContentRuleList.
//
// Почему не так, как на Windows. У WebView2 есть событие WebResourceRequested,
// в котором виден и отменяем каждый запрос, включая запросы чужого кадра плеера.
// У WKWebView такого события нет вовсе — перехватывать https-запросы движок
// не даёт никому. Единственный штатный способ отбить запрос — контент-блокировщик:
// список правил компилируется заранее и дальше исполняется внутри движка.
//
// Плюс подхода: правила действуют во всех фреймах, в том числе кроссдоменных, —
// то есть кадр плеера накрывается так же, как на Windows.
// Минус, и его не обойти: список декларативный, колбэка на срабатывание нет.
// Поэтому доклад «заблокирован источник X» (window.__animoriNetBlocked) на macOS
// не работает, и счётчика заблокированного в журнале здесь не будет.
//
// Список адресов общий с Windows и живёт в adblock_rules.rs.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{define_class, MainThreadOnly};
use objc2_foundation::{MainThreadMarker, NSError, NSObjectProtocol, NSString};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKScriptMessage, WKScriptMessageHandler,
    WKUserContentController,
};

use crate::adblock_rules::{AD_HOSTS, AD_PATTERNS, ALLOW_HOSTS};

/// Имя канала страница → оболочка.
///
/// На Windows тумблер ходит запросом на adblock.animori.invalid: там его видно
/// в перехватчике. Здесь перехвата нет, поэтому заводится свой обработчик сообщений.
/// Уровень доступа тот же самый: и тот запрос, и это сообщение доступны любому
/// скрипту anilist.co. Разница только с командой Tauri — та потребовала бы
/// разрешения в capabilities, то есть доступа ко всему плагину, а не к одному действию.
const MESSAGE_NAME: &str = "animoriAdblock";

/// Идентификатор скомпилированного списка в хранилище WebKit.
const RULE_LIST_ID: &str = "animori-adblock";

/// По умолчанию выключен — как и на Windows: блокировка лишает источники
/// рекламных денег, и это решение человека, а не установщика.
static ENABLED: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// Скомпилированный список и контроллер окна. Оба — main-thread-only,
    /// поэтому живут в thread_local, а не в статике: Retained не Send.
    static RULE_LIST: RefCell<Option<Retained<WKContentRuleList>>> = const { RefCell::new(None) };
    static CONTROLLER: RefCell<Option<Retained<WKUserContentController>>> = const { RefCell::new(None) };
    /// Обработчик тумблера. Держится явно, а не через mem::forget: документация
    /// Apple не обещает, что контроллер удержит его сам, а освобождённый
    /// обработчик означал бы молча переставший работать тумблер.
    static TOGGLE: RefCell<Option<Retained<Toggle>>> = const { RefCell::new(None) };
}

/// Экранирует то, что контент-блокировщик разберёт как регулярное выражение.
///
/// Без этого "vast?" означало бы «vas и необязательная t», а точки в доменах
/// совпадали бы с любым символом: под "media.net" попал бы "mediaXnet".
fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if matches!(
            c,
            '.' | '?' | '*' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '^' | '$' | '\\'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Экранирование для JSON-строки.
///
/// Отдельно от escape_regex: тот готовит выражение, а обратный слеш в нём для
/// JSON сам по себе спецсимвол. Без этого шага "media\.net" уезжало бы в файл
/// как невалидная escape-последовательность, WebKit отказывался бы разбирать
/// список целиком — и блокировка молча не работала бы вовсе.
fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Собирает JSON контент-блокировщика из общего списка правил.
///
/// Порядок значим: разрешения идут последними. У контент-блокировщика нет
/// приоритетов, есть только действие ignore-previous-rules, которое отменяет
/// всё совпавшее выше, — так воспроизводится правило «ALLOW_HOSTS всегда
/// побеждает» из adblock.rs.
fn rules_json() -> String {
    let mut out = String::from("[");

    // Хост целиком или его поддомен. [:/] на конце не даёт "media.net"
    // совпасть с "media.network".
    for host in AD_HOSTS {
        out.push_str(&format!(
            r#"{{"trigger":{{"url-filter":"^https?://([^/]+\\.)?{}[:/]"}},"action":{{"type":"block"}}}},"#,
            escape_json(&escape_regex(host))
        ));
    }

    // Приметы в адресе: домен победителя аукциона меняется, стандарты — нет.
    // Регистр не учитывается: url-filter-is-case-sensitive по умолчанию false,
    // что совпадает с lowered_url.contains() из adblock.rs.
    for pattern in AD_PATTERNS {
        out.push_str(&format!(
            r#"{{"trigger":{{"url-filter":"{}"}},"action":{{"type":"block"}}}},"#,
            escape_json(&escape_regex(pattern))
        ));
    }

    // Разрешения — последними, см. комментарий выше.
    for (i, host) in ALLOW_HOSTS.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            r#"{{"trigger":{{"url-filter":"^https?://([^/]+\\.)?{}[:/]"}},"action":{{"type":"ignore-previous-rules"}}}}"#,
            escape_json(&escape_regex(host))
        ));
    }

    out.push(']');
    out
}

/// Ставит или снимает список в контроллере окна по текущему состоянию тумблера.
fn apply() {
    CONTROLLER.with(|c| {
        let controller = c.borrow();
        let Some(controller) = controller.as_ref() else {
            return;
        };

        RULE_LIST.with(|r| {
            let list = r.borrow();
            let Some(list) = list.as_ref() else {
                // Компиляция ещё не кончилась: применим по её завершении.
                return;
            };

            unsafe {
                if ENABLED.load(Ordering::Relaxed) {
                    controller.addContentRuleList(list);
                } else {
                    controller.removeContentRuleList(list);
                }
            }
        });
    });
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AniMoriAdblockToggle"]
    struct Toggle;

    unsafe impl NSObjectProtocol for Toggle {}

    unsafe impl WKScriptMessageHandler for Toggle {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(
            _this: &Toggle,
            _controller: &WKUserContentController,
            msg: &WKScriptMessage,
        ) {
            let body = unsafe { msg.body() };
            let Ok(text) = body.downcast::<NSString>() else {
                return;
            };

            let on = text.to_string() == "on";
            ENABLED.store(on, Ordering::Relaxed);
            apply();
            log::info!("Адблок: сетевая блокировка {}", if on { "включена" } else { "выключена" });
        }
    }
);

/// Ошибка не валит приложение: без блокировщика программа работает,
/// просто с рекламой. Ровно как на Windows.
pub fn install(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|webview| {
        let Some(mtm) = MainThreadMarker::new() else {
            log::warn!("Адблок: установка не с главного потока, пропущена");
            return;
        };

        // Tauri отдаёт готовый WKUserContentController окна.
        let controller = webview.controller() as *mut WKUserContentController;
        if controller.is_null() {
            log::warn!("Адблок: у окна нет контроллера, блокировка не поставлена");
            return;
        }
        let controller: Retained<WKUserContentController> =
            unsafe { Retained::retain(controller) }.expect("контроллер окна пуст");

        // Канал тумблера.
        let toggle: Retained<Toggle> = unsafe { objc2::msg_send![Toggle::alloc(mtm), init] };
        unsafe {
            controller.addScriptMessageHandler_name(
                ProtocolObject::from_ref(&*toggle),
                &NSString::from_str(MESSAGE_NAME),
            );
        }
        TOGGLE.with(|c| *c.borrow_mut() = Some(toggle));

        CONTROLLER.with(|c| *c.borrow_mut() = Some(controller));

        let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
            log::warn!("Адблок: хранилище правил недоступно");
            return;
        };

        // Компиляция асинхронная: движок разбирает и оптимизирует правила сам.
        let handler = RcBlock::new(move |list: *mut WKContentRuleList, err: *mut NSError| {
            if !err.is_null() {
                let msg = unsafe { (*err).localizedDescription() };
                log::warn!("Адблок: правила не скомпилировались: {msg}");
                return;
            }
            let Some(list) = (unsafe { Retained::retain(list) }) else {
                log::warn!("Адблок: компилятор вернул пустой список");
                return;
            };
            RULE_LIST.with(|r| *r.borrow_mut() = Some(list));
            // Тумблер мог прийти раньше, чем кончилась компиляция.
            apply();
            log::info!("Адблок: правила скомпилированы");
        });

        unsafe {
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&NSString::from_str(RULE_LIST_ID)),
                Some(&NSString::from_str(&rules_json())),
                Some(&handler),
            );
        }
    });

    if let Err(e) = result {
        log::warn!("Адблок: доступ к вебвью не получен: {e}");
    }
}

// Компиляция правил идёт асинхронно, а в релизной сборке плагин логов не поднят:
// битый JSON провалился бы молча и блокировка просто не работала бы. Тест выгружает
// список ровно в том виде, в каком его получает WebKit, чтобы его можно было
// скормить настоящему WKContentRuleListStore (см. AGENTS.md этого каталога).

// Компиляция правил идёт асинхронно, а в релизной сборке плагин логов не поднят:
// битый JSON провалился бы молча и блокировка просто не работала бы. Тест
// разбирает список настоящим парсером и выгружает его в том виде, в каком его
// получает WebKit, чтобы список можно было скормить живому WKContentRuleListStore.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_json_parses_and_is_dumped() {
        let json = rules_json();

        // Разбор настоящим парсером: подстроки не поймали бы ни висячую запятую,
        // ни одиночный обратный слеш, из-за которого WebKit отверг бы весь список.
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("список правил — невалидный JSON");
        let arr = parsed.as_array().expect("список обязан быть массивом");

        assert_eq!(
            arr.len(),
            AD_HOSTS.len() + AD_PATTERNS.len() + ALLOW_HOSTS.len(),
            "часть правил потерялась при сборке"
        );

        // Разрешения обязаны идти последними: у контент-блокировщика нет
        // приоритетов, отменяет только ignore-previous-rules ниже по списку.
        for rule in &arr[arr.len() - ALLOW_HOSTS.len()..] {
            assert_eq!(rule["action"]["type"], "ignore-previous-rules");
        }
        for rule in &arr[..AD_HOSTS.len()] {
            assert_eq!(rule["action"]["type"], "block");
        }

        // После разбора в выражении обязан остаться ровно один обратный слеш:
        // точка в домене экранирована и не совпадёт с произвольным символом.
        let first = arr[0]["trigger"]["url-filter"].as_str().unwrap();
        assert!(first.contains(r"\."), "точки в домене не экранированы: {first}");
        assert!(first.ends_with("[:/]"), "нет якоря конца хоста: {first}");

        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/adblock-rules.json");
        std::fs::write(&out, &json).expect("не удалось выгрузить правила");
        eprintln!("правила выгружены: {}", out.display());
    }
}
