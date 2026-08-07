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

/// Когда проверять гонку подписки: прокси с логином обязан спросить учётные
/// данные на первом же соединении, а это секунды, а не десятки секунд.
const AUTH_SILENCE_MS: u64 = 3_000;

/// Шаг опроса. Сон целиком не годится: при известной причине человека нечем
/// занять оставшиеся десять секунд ожидания.
const POLL_STEP_MS: u64 = 250;

/// Тихий перезаход разрешён ровно один: иначе мёртвый прокси превратил бы окно
/// в вечную карусель перезагрузок.
static RELOADED: AtomicBool = AtomicBool::new(false);

/// Отметка «страница ожила». Отдельно от ProxyState: команда ниже вызывается ВСЕГДА,
/// в том числе когда прокси выключен и сторож не заводится.
pub struct PageReady(AtomicBool);

/// НЕДОВЕРЕННЫЙ ВЫЗОВ: приходит из контекста anilist.co, то есть доступен любому
/// скрипту сайта. Худшее последствие злоупотребления — сторож промолчит.
#[tauri::command]
pub fn animori_page_ready(state: State<'_, PageReady>) {
    state.0.store(true, Ordering::Relaxed);

    // Живая страница обнуляет счёт попыток авторизации: лимит на подбор пароля,
    // а не на длину сеанса.
    #[cfg(windows)]
    crate::proxy_auth::note_page_ready();
}

/// Прокси спрашивал учётные данные. За пределами Windows события нет вовсе.
fn auth_asked() -> bool {
    #[cfg(windows)]
    {
        crate::proxy_auth::was_asked()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Прокси отверг подставленную пару логина и пароля.
fn auth_rejected() -> bool {
    #[cfg(windows)]
    {
        crate::proxy_auth::was_rejected()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Чем кончилось ожидание очередного отрезка времени.
enum Verdict {
    Ready,
    Rejected,
    Silent,
}

/// Ждёт с шагом POLL_STEP_MS и выходит раньше срока, как только исход ясен.
fn wait(app: &AppHandle, total_ms: u64) -> Verdict {
    let mut left = total_ms;

    while left > 0 {
        let step = left.min(POLL_STEP_MS);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;

        if app.state::<PageReady>().0.load(Ordering::Relaxed) {
            return Verdict::Ready;
        }

        if auth_rejected() {
            return Verdict::Rejected;
        }
    }

    Verdict::Silent
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

    // Логин задан: значит отсутствие запроса авторизации — сам по себе симптом.
    let has_login = proxy::window_auth(app).is_some();

    let app = app.clone();

    // Обычный поток, а не задача рантайма: blocking_show держит поток до ответа
    // человека минутами, а на главном потоке он и вовсе повесил бы окно.
    std::thread::spawn(move || {
        let mut verdict = wait(&app, AUTH_SILENCE_MS);

        // Прокси ставится до окна, а обработчик — после него: первый запрос авторизации
        // теоретически может проскочить мимо подписки. Один тихий перезаход дешевле
        // любого диалога и незаметен, если страница и так всё равно пуста.
        if matches!(verdict, Verdict::Silent)
            && has_login
            && !auth_asked()
            && !RELOADED.swap(true, Ordering::Relaxed)
        {
            match app.get_webview_window("main") {
                Some(window) => {
                    log::info!("Прокси не спросил учётные данные за 3 с — один тихий перезаход");
                    if let Err(e) = window.reload() {
                        log::warn!("Перезаход не удался: {e}");
                    }
                }
                None => log::warn!("Окно main не найдено, перезаход пропущен"),
            }
        }

        if matches!(verdict, Verdict::Silent) {
            verdict = wait(&app, PAGE_READY_TIMEOUT_MS - AUTH_SILENCE_MS);
        }

        if matches!(verdict, Verdict::Ready) {
            return;
        }

        let rejected = matches!(verdict, Verdict::Rejected) || auth_rejected();
        let seconds = PAGE_READY_TIMEOUT_MS / 1000;

        if rejected {
            log::warn!("Прокси {server} не принял учётные данные");
        } else {
            log::warn!("Страница не подала признаков жизни за {seconds} с при прокси {server}");
        }

        // Три разные беды — три разных текста. При отказе по паролю выключать рабочий
        // прокси — лечение хуже болезни, поэтому называем файл и ключ для правки вручную:
        // панель настроек живёт внутри страницы, которая не загрузилась.
        let message = if rejected {
            format!(
                "Прокси {server} не принял логин и пароль, поэтому AniList не загрузился.\n\n\
                 Проверьте их в файле %APPDATA%\\com.foulnike.animori\\animori-settings.json: \
                 ключи \"set_proxy_login\" и \"set_proxy_pass\". Панель настроек живёт внутри \
                 страницы, которая сейчас пуста.\n\n\
                 Выключить прокси и перезапустить приложение?"
            )
        } else if auth_asked() {
            format!(
                "AniList не загрузился за {seconds} секунд.\n\n\
                 Прокси {server} принял учётные данные, но трафик через него всё равно \
                 не проходит.\n\n\
                 Выключить прокси и перезапустить приложение?"
            )
        } else {
            format!(
                "AniList не загрузился за {seconds} секунд.\n\n\
                 Похоже, дело в прокси {server}: он принимает соединение, но трафик \
                 через него не проходит.\n\n\
                 Выключить прокси и перезапустить приложение?"
            )
        };

        let approved = app
            .dialog()
            .message(message)
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
