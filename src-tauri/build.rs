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
// Именно эти имена перечисляются в capabilities/default.json.
//
// Правило на будущее: новая команда — три места.
//   1) invoke_handler в src/lib.rs
//   2) COMMANDS ниже
//   3) permissions в capabilities/default.json
// Пропуск любого из трёх даёт тот же отказ на стороне JS.

const COMMANDS: &[&str] = &["animori_reload", "animori_open_external"];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build")
}
