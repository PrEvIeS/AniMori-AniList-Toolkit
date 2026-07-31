// Пункт 4.3, правка по дефекту «animori_reload not allowed. Plugin not found».
//
// Окно приложения открыто на внешнем URL, и доступ к IPC ему даёт блок remote.urls
// в capabilities/default.json. Правило Tauri «все команды, зарегистрированные через
// invoke_handler, доступны всем окнам» действует только для локального контекста
// приложения: для удалённого источника разрешённым считается ровно то, что перечислено
// в capability. Разрешения для собственной команды при этом не существует до тех пор,
// пока команда не объявлена здесь — резолвер ACL не находит владельца имени и отвечает
// «Plugin not found», хотя никакого плагина в деле нет.
//
// tauri-build по этому списку генерирует на каждую команду пару разрешений
// allow-<команда> и deny-<команда>, переводя имя в kebab-case:
// animori_reload -> allow-animori-reload. Именно это имя и ставится в capability.
//
// ВАЖНО: пока app_manifest не задан, разрешения не нужны никому; после того как он
// задан, они нужны ВСЕМ собственным командам сразу. Поэтому новая команда заводится
// в трёх местах: invoke_handler в src/lib.rs, этот список и блок permissions
// в capabilities/default.json. Пропуск любого из трёх даёт ту же ошибку.
const COMMANDS: &[&str] = &["animori_reload"];

fn main() {
    // try_build вместо build: build() не принимает Attributes, а нам нужен app_manifest.
    // Ошибку всё равно разворачиваем в панику — так же, как это делает сам build().
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build")
}
