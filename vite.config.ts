import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

/**
 * Конфигурация сборки AniMori.
 *
 * Блок метаданных юзерскрипта (ранее — строки 1–20 файла animori.user.js)
 * полностью перенесён сюда и генерируется на этапе сборки (build time).
 * Версия берётся из package.json, поэтому ручное версионирование внутри
 * JS-файла больше не требуется.
 *
 * Режимы сборки (задел под Этап 3/4):
 *   vite build --mode userscript  → сборка юзерскрипта (MonkeyBridge)
 *   vite build --mode tauri       → сборка веб-бандла для Tauri (TauriBridge)
 */
export default defineConfig(({ mode }) => ({
  define: {
    // Читается модулем src/bridge/index.ts на Этапе 3 для tree-shaking.
    __ANIMORI_PLATFORM__: JSON.stringify(mode === 'tauri' ? 'tauri' : 'userscript'),
  },

  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },

  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: {
          '': 'AniMori: AniList Toolkit',
          ru: 'AniMori: AniList Toolkit',
        },
        description: {
          '': 'Русификатор и набор инструментов для AniList — перевод интерфейса, плеер, рейтинги, дерево франшиз, экспорт и сравнение списков с Shikimori.',
        },
        namespace: 'https://github.com/foulnike/AniMori-AniList-Toolkit',
        author: 'foulnike',
        license: 'MIT',
        homepageURL: 'https://github.com/foulnike/AniMori-AniList-Toolkit',
        supportURL: 'https://github.com/foulnike/AniMori-AniList-Toolkit/issues',
        icon: 'https://anilist.co/img/icons/favicon-32x32.png',
        match: [
          'https://anilist.co/*',
          'https://shikimori.io/*',
          'https://shikimori.one/*',
          'https://shikimori.rip/*',
        ],
        connect: [
          'raw.githubusercontent.com',
          'graphql.anilist.co',
          'shikimori.io',
          'shikimori.one',
          'shikimori.rip',
          'smotret-anime.online',
          'anime365.ru',
          'api.animethemes.moe',
          'kodik-api.com',
        ],
        grant: [
          'GM_getValue',
          'GM_setValue',
          'GM_deleteValue',
          'GM_listValues',
          'GM_addStyle',
          'GM_xmlhttpRequest',
          'GM_setClipboard',
        ],
        'run-at': 'document-start',
        downloadURL:
          'https://greasyfork.org/scripts/572948-animori-anilist-toolkit/code/animori.user.js',
        updateURL:
          'https://greasyfork.org/scripts/572948-animori-anilist-toolkit/code/animori.meta.js',
      },
      build: {
        fileName: 'animori.user.js',
        metaFileName: 'animori.meta.js',
      },
    }),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Юзерскрипт должен остаться читаемым для ревью на GreasyFork.
    minify: false,
    target: 'esnext',
  },
}))
