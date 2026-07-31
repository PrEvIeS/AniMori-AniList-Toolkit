// Пункт 4.3: инъекция собранного бандла в WebView, который открыт на внешнем URL.
//
// Окно создаётся здесь, а не в tauri.conf.json: initialization_script есть только у
// WebviewWindowBuilder, и для окна, объявленного в конфиге, добавить его после
// создания невозможно. Метка остаётся "main" — на неё ссылается capabilities.

use tauri::{WebviewUrl, WebviewWindowBuilder};

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

// В режиме tauri плагин monkey отключён, а вместе с ним пропал и его автоматический
// инжект стилей — CSS ложится отдельным файлом. Поднимать ради этого ещё одну
// npm-зависимость не стали: стили вставляет бэкенд первым скриптом инициализации.
//
// serde_json::to_string даёт корректный JS-литерал: в SCSS есть и кавычки, и обратные
// слеши, и переводы строк; ручное экранирование здесь — готовая дыра.
//
// Скрипт инициализации выполняется до создания DOM, поэтому document.head может
// ещё отсутствовать — тогда вставляем по DOMContentLoaded.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Порядок скриптов важен: стили регистрируются раньше бандла, иначе первые
            // смонтированные Vue-приложения успеют мелькнуть без оформления.
            WebviewWindowBuilder::new(
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
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
