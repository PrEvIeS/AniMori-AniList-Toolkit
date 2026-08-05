import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import monkey from 'vite-plugin-monkey'

// Единый источник номера версии — package.json.
//
// Раньше номер был прописан здесь строкой, и при выпуске его приходилось
// поднимать в двух местах. Пропуск одного из них стоит дорого: Tauri берёт
// версию из package.json и приложение обновится, а GreasyFork смотрит только на
// шапку скрипта — со старым номером он решит, что обновлять нечего, и люди
// останутся на прежней сборке молча.
//
// Чтение файла, а не import его JSON: импорт потребовал бы resolveJsonModule
// и тянул бы package.json в область проверки типов всего проекта.
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

// Метаданные ниже перенесены 1:1 из шапки монолита animori.user.js (строки 1-25),
// кроме version — он теперь приезжает из package.json.
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
        // эффект Rollup вправе сохранить даже после удаления недостижимой ветви — вместе
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
        // Пункт 2.10, правка 2 августа: блокировщик рекламы есть только в десктопной
        // сборке. В браузере его работу делает расширение пользователя, и оно делает её
        // лучше: расширение видит и кадр плеера, куда наш код заглянуть не вправе.
        //
        // Выбор целью алиаса, а не проверкой платформы: initAdblock() тянет наблюдатель
        // мутаций, строку стилей и net-block.ts, и полагаться на вычистку недостижимой
        // ветви нельзя ровно по той же причине, что и с мостом выше.
        //
        // Ключ так же обязан идти до '@'.
        '@adblock-impl': fileURLToPath(
          new URL(
            isTauri
              ? './src/features/adblock/impl.desktop.ts'
              : './src/features/adblock/impl.noop.ts',
            import.meta.url,
          ),
        ),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      // Этап 3-4: выбор реализации Bridge на этапе сборки.
      __ANIMORI_PLATFORM__: JSON.stringify(isTauri ? 'tauri' : 'userscript'),
      // Пункт 5.3.5: номер версии нужен рантайму для заголовка User-Agent
      // нашего канала (src/bridge/TauriBridge.ts). Берётся из того же package.json,
      // что и версия в шапке юзерскрипта: второй источник номера заводить нельзя,
      // см. комментарий в шапке файла.
      __ANIMORI_VERSION__: JSON.stringify(version),
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
                version,
                description:
                  'Русский перевод, поиск, плеер, рейтинги Shiki и MAL, дерево хронологии, опенинги/эндинги, музыка, внешние ссылки, экспорт и сравнение списков Shikimori/AniList.',
                author: 'foulnike',
                license: 'MIT',
                // Только anilist.co. Прежний '*://shikimori.io/*' стал мёртвым после пункта 3.7:
                // точка входа выходит на шаге `if (IS_SHIKI) return`, то есть на Shikimori скрипт
                // грузился, чтобы сразу ничего не сделать. Перенос списков этого не требует:
                // после 3.6 списки Shikimori читаются через мост с любого домена, а разрешает
                // такой запрос @connect, а не @match — он ниже и остаётся на месте.
                match: ['https://anilist.co/*'],
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
