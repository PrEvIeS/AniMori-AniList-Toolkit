// Аварийный выход, когда прокси принят, но страница не грузится. TCP-щуп в proxy.rs
// не отличает прокси, который принимает соединение, но наружу не выпускает, а панель
// настроек живёт внутри незагрузившейся страницы — выключить прокси нечем.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_store::StoreExt;

use crate::proxy::{self, ProxyOutcome};

/// Повторяют proxy.rs, а тот — src/core/proxy.ts: доступа к чужим модулям ни одна
/// из сторон не имеет, а разойтись они не должны.
const STORE_FILE: &str = "animori-settings.json";
const KEY_ENABLED: &str = "set_proxy_on";

/// Через мёртвый прокси страница не загрузится вовсе, а живой медленный канал
/// укладывается: меньше — ложные срабатывания у далёкого прокси.
const PAGE_READY_TIMEOUT_MS: u64 = 12_000;

/// Отметка «страница ожила». Отдельно от ProxyState: команда ниже вызывается ВСЕГДА,
/// в том числе когда прокси выключен и сторож не заводится.
pub struct PageReady(AtomicBool);

/// НЕДОВЕРЕННЫЙ ВЫЗОВ: приходит из контекста anilist.co, то есть доступен любому
/// скрипту сайта. Худшее последствие злоупотребления — сторож промолчит.
#[tauri::command]
pub fn animori_page_ready(state: State<'_, PageReady>) {
    state.0.store(true, Ordering::Relaxed);
}

/// Заводит сторожа, один раз сразу после создания окна. Отсчёт от создания, а не от
/// конца навигации: при мёртвом прокси она не завершится никогда.
pub fn spawn(app: &AppHandle) {
    app.manage(PageReady(AtomicBool::new(false)));

    // При Off, Invalid и Unreachable окно и так идёт напрямую: винить прокси в пустой
    // странице значило бы ставить заведомо ложный диагноз.
    let Some((outcome, server)) = proxy::current_status(app) else {
        log::warn!("Сторож страницы не заведён: состояние прокси недоступно");
        return;
    };

    if outcome != ProxyOutcome::Applied {
        return;
    }

    let app = app.clone();

    // Обычный поток, а не задача рантайма: blocking_show держит поток до ответа
    // человека минутами, а на главном потоке он и вовсе повесил бы окно.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(PAGE_READY_TIMEOUT_MS));

        if app.state::<PageReady>().0.load(Ordering::Relaxed) {
            return;
        }

        let seconds = PAGE_READY_TIMEOUT_MS / 1000;
        log::warn!("Страница не подала признаков жизни за {seconds} с при прокси {server}");

        let approved = app
            .dialog()
            .message(format!(
                "AniList не загрузился за {seconds} секунд.\n\n\
                 Похоже, дело в прокси {server}: он принимает соединение, но трафик \
                 через него не проходит.\n\n\
                 Выключить прокси и перезапустить приложение?"
            ))
            .title("AniMori: страница не загрузилась")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Выключить и перезапустить".to_string(),
                "Оставить как есть".to_string(),
            ))
            .blocking_show();

        if !approved {
            log::info!("Аварийное выключение прокси отклонено пользователем");
            return;
        }

        if let Err(err) = disable_proxy(&app) {
            log::error!("Не удалось выключить прокси: {err}");

            // Перезапуск был бы вредом: настройка та же, а сессия потеряна.
            app.dialog()
                .message(format!(
                    "Не удалось сохранить настройки: {err}\n\n\
                     Выключите прокси вручную: в файле \
                     %APPDATA%\\com.foulnike.animori\\animori-settings.json \
                     задайте \"set_proxy_on\": false."
                ))
                .title("AniMori: настройки не сохранены")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return;
        }

        log::info!("Прокси выключен по аварийному сценарию, перезапуск");
        app.restart();
    });
}

/// Пишется РОВНО ОДИН ключ: адрес и логин человек вводил сам. Отказ save() обязан
/// быть виден: без записи на диск диалог повторится по кругу.
fn disable_proxy(app: &AppHandle) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_ENABLED, false);
    store.save().map_err(|e| e.to_string())
}
