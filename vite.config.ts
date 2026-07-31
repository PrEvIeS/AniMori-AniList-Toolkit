import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import monkey from 'vite-plugin-monkey'

// Метаданные ниже перенесены 1:1 из шапки монолита animori.user.js (строки 1-25),
// кроме version: 2.0.0 — модульная кодовая база вместо монолита 1.9.1.
// Не добавляй @match/@grant/@connect "на всякий случай": лишние права ломают ревю GreasyFork.
export default defineConfig(({ mode }) => {
  // Пункт 4.6: два таргета из одного входа src/main.ts.
  //
  // Режим userscript: vite-plugin-monkey добавляет шапку и сам инжектирует CSS.
  // Режим tauri: плагин monkey отключён целиком — шапка юзерскрипта и его
  // обёртки в initialization_script недопустимы. На выходе два файла:
  // dist/animori.tauri.js (IIFE) и dist/animori.tauri.css. Rust-бэкенд включает оба
  // через include_str! (пункт 4.3), поэтому имена файлов зафиксированы жёстко,
  // без хешей в имени.
  const isTauri = mode === 'tauri'

  return {
    resolve: {
      alias: {
        // Пункт 3.4: выбор реализации Bridge на этапе сборки.
        //
        // Подмена пути надёжнее ветвления по __ANIMORI_PLATFORM__ внутри кода:
        // TauriBridge создаёт LazyStore на верхнем уровне модуля, и такой побочный
        // эффект Rollup вправе сохранить даже после удаления недостижимой ветки — вместе
        // с ним в бандл юзерскрипта уехали бы пакеты @tauri-apps/*.
        //
        // Ключ обязан идти до '@': совпадение строковых алиасов идёт по порядку.
        // Пересечения всё равно нет: '@' срабатывает лишь на точном '@' или префиксе '@/'.
        '@bridge-impl': fileURLToPath(
          new URL(
            isTauri ? './src/bridge/TauriBridge.ts' : './src/bridge/MonkeyBridge.ts',
            import.meta.url,
          ),
        ),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      // Этап 3-4: выбор реализации Bridge на этапе сборки.
      __ANIMORI_PLATFORM__: JSON.stringify(isTauri ? 'tauri' : 'userscript'),
      // Этап 2: флаги сборки Vue. Без них рантаим сыплет предупреждения в консоль.
      // Options API нигде не используется — только Composition API, поэтому false.
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    css: {
      preprocessorOptions: {
        scss: { api: 'modern-compiler' },
      },
    },
    plugins: [
      // vue() строго до monkey(): к monkey код должен прийти уже без SFC.
      vue(),
      ...(isTauri
        ? []
        : [
            monkey({
              entry: 'src/main.ts',
              userscript: {
                name: 'AniMori: AniList Toolkit',
                namespace: 'http://tampermonkey.net/',
                version: '2.0.0',
                description:
                  'Русский перевод, поиск, плеер, рейтинги Shiki и MAL, дерево хронологии, опенинги/эндинги, музыка, внешние ссылки, экспорт и сравнение списков Shikimori/AniList.',
                author: 'foulnike',
                license: 'MIT',
                match: ['https://anilist.co/*', '*://shikimori.io/*'],
                grant: [
                  'GM_xmlhttpRequest',
                  'GM_setValue',
                  'GM_getValue',
                  'GM_addStyle',
                  'GM_setClipboard',
                ],
                connect: [
                  'raw.githubusercontent.com',
                  'shikimori.io',
                  'shikimori.rip',
                  'smotret-anime.online',
                  'anime365.ru',
                  'graphql.anilist.co',
                  'kodik-api.com',
                  'api.animethemes.moe',
                ],
                downloadURL:
                  'https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.user.js',
                updateURL:
                  'https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.meta.js',
              },
              build: {
                fileName: 'animori.user.js',
                metaFileName: 'animori.meta.js',
              },
            }),
          ]),
    ],
    build: {
      outDir: 'dist',
      // Сборка tauri не чистит dist: в CI она идёт второй и рядом лежит уже собранный
      // animori.user.js для GreasyFork.
      emptyOutDir: !isTauri,
      minify: false,
      target: 'esnext',
      ...(isTauri
        ? {
            // Не lib-режим: нужен ровно один самодостаточный IIFE без экспортов,
            // который можно отдать WebView строкой.
            rollupOptions: {
              input: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
              output: {
                format: 'iife' as const,
                inlineDynamicImports: true,
                entryFileNames: 'animori.tauri.js',
                assetFileNames: 'animori.tauri.[ext]',
              },
            },
            cssCodeSplit: false,
          }
        : {}),
    },
  }
})
