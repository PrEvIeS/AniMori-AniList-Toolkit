// Пункт 4.3, правка по итогам первого живого запуска.
//
// Окно приложения открыто на внешнем URL (WebviewUrl::External + remote.urls в
// capability). Для такого окна ACL Tauri работает иначе, чем для локального
// фронтенда: вызвать можно ровно то, что перечислено в разрешениях, и собственные
// команды приложения тоже требуют разрешения. Без объявления здесь такого
// разрешения вообще не существует, и вызов из JS падает с сообщением
// "<имя> not allowed. Plugin not found" — именно так молчала кнопка перезагрузки.
//
// AppManifest::commands порождает разрешения с именами в kebab-case:
//   animori_reload        -> allow-animori-reload
//   animori_open_external -> allow-animori-open-external
//   animori_proxy_status  -> allow-animori-proxy-status
//   animori_proxy_probe   -> allow-animori-proxy-probe
// Именно эти имена перечисляются в capabilities/default.json.
//
// Правило на будущее: новая команда — три места.
//   1) invoke_handler в src/lib.rs
//   2) COMMANDS ниже
//   3) permissions в capabilities/default.json
// Пропуск любого из трёх даёт тот же отказ на стороне JS.

const COMMANDS: &[&str] = &[
    "animori_reload",
    "animori_open_external",
    // Пункт 5.3.6: диагностика прокси для карточки настроек. Обе только читают:
    // status отдаёт снимок состояния, probe открывает TCP-соединение на адрес из
    // файла настроек. Ни та, ни другая не принимают адрес параметром — иначе скрипт
    // чужого сайта получил бы сканер портов местной сети чужими руками.
    "animori_proxy_status",
    "animori_proxy_probe",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build")
}
