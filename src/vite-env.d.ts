/// <reference types="vite/client" />
/// <reference types="vite-plugin-monkey/client" />

/**
 * Целевая платформа сборки. Подставляется Vite через define на этапе
 * компиляции. Используется на Этапе 3 в src/bridge/index.ts для выбора
 * реализации IBridge с tree-shaking лишнего кода.
 */
declare const __ANIMORI_PLATFORM__: 'userscript' | 'tauri'
