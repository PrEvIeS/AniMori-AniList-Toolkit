import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

// Метаданные ниже перенесены 1:1 из шапки монолита animori.user.js (строки 1-25),
// кроме version: 2.0.0 — модульная кодовая база вместо монолита 1.9.1.
// Не добавляй @match/@grant/@connect "на всякий случай": лишние права ломают ревью GreasyFork.
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    // Этап 3-4: выбор реализации Bridge на этапе сборки.
    __ANIMORI_PLATFORM__: JSON.stringify(mode === 'tauri' ? 'tauri' : 'userscript'),
  },
  css: {
    preprocessorOptions: {
      scss: { api: 'modern-compiler' },
    },
  },
  plugins: [
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
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    target: 'esnext',
  },
}))
