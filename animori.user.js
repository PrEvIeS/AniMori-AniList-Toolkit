// ==UserScript==
// @name         AniMori: AniList Toolkit
// @namespace    http://tampermonkey.net/
// @version      1.9.0
// @description  Русский перевод, поиск, плеер, рейтинги Shiki и MAL, дерево хронологии, опенинги/эндинги, музыка, внешние ссылки, экспорт и сравнение списков Shikimori/AniList.
// @author       foulnike
// @match        https://anilist.co/*
// @match        *://shikimori.io/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      raw.githubusercontent.com
// @connect      shikimori.io
// @connect      shikimori.rip
// @connect      smotret-anime.online
// @connect      anime365.ru
// @connect      graphql.anilist.co
// @connect      kodik-api.com
// @connect      api.animethemes.moe
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.user.js
// @updateURL https://update.greasyfork.org/scripts/572948/AniMori%3A%20AniList%20Toolkit.meta.js
// ==/UserScript==

// @ts-nocheck — legacy без TS build; @ts-check дал бы ~670 шумных ошибок (implicit any, GM_* без типов). JSDoc ниже даёт автодополнение.

(function() {
    'use strict';

    // ==========================================
    // 1. ГЛОБАЛЬНЫЕ КОНСТАНТЫ И КОНФИГУРАЦИЯ
    // ==========================================

    const IS_SHIKI = window.location.hostname.includes("shikimori");
    const IS_ANILIST = window.location.hostname.includes("anilist.co");

    // Словарь перевода интерфейса
    const DICT_URL = 'https://raw.githubusercontent.com/foulnike/AniMori-AniList-Toolkit/main/dictionary.json';

    // Shikimori
    const SHIKI_DOMAINS =['shikimori.io', 'shikimori.rip']; // .rip — фоллбэк для удалённых по РКН

    // anime365 (smotret-anime) — фоллбэк для тайтлов/описаний
    const ANIME365_DOMAINS = ['smotret-anime.online', 'anime365.ru'];
    const ANIME365_THROTTLE = 180;  // мс между запросами (только на cache-miss)
    const ANIME365_FAIL_LIMIT = 5;  // подряд-сбоев → отключение источника на сессию

    // TTL кэша — 90 дней
    const CACHE_TIME = 90 * 24 * 60 * 60 * 1000;

    // IndexedDB
    const DB_NAME = 'AniMoriSuperDB';
    const DB_VERSION = 5;

    // Глобальные стейты
    let dictionary = Object.create(null);
    let alRateLimitPause = 0;      // пауза при 429 AniList
    let shikiRateLimitPause = 0;   // пауза при 429 Shikimori
    let anime365RateLimitPause = 0;// пауза 429/бэкофф anime365
    let anime365FailStreak = 0;    // подряд-сбои (403/503/сеть)
    let anime365Disabled = false;  // авто-отключение на сессию
    let globalDbInstance = null;
    let globalPendingQueues = null; // очереди перевода (для инспектора)

    // Пользовательские настройки (в GM-хранилище)
    const settings = {
        translateInterface:  GM_getValue('set_interface', true),
        titlePrimary:        GM_getValue('set_title_primary', GM_getValue('set_titles', true) ? 'shikimori' : 'off'),
        titleFallback:       GM_getValue('set_title_fallback', 'none'),
        translateCharacters: GM_getValue('set_chars', true),
        translateStaff:      GM_getValue('set_staff', true),
        enablePlayer:        GM_getValue('set_player', true),
        enableRatings:       GM_getValue('set_ratings', true),
        enableFranchise:     GM_getValue('set_franchise', true),
        enableThemes:        GM_getValue('set_themes', true),
        enableExtLinks:      GM_getValue('set_extlinks', true),
        enableLinkRutracker: GM_getValue('set_link_rutracker', true),
        enableLinkYummy:     GM_getValue('set_link_yummy', true),
        enableLinkAnimego:   GM_getValue('set_link_animego', true),
        enableLinkMangalib:  GM_getValue('set_link_mangalib', true),
        yummyDomain:         GM_getValue('set_yummy_domain', 'yummyanime.tv'),
        animegoDomain:       GM_getValue('set_animego_domain', 'animego.org'),
        mangalibDomain:      GM_getValue('set_mangalib_domain', 'mangalib.me'),
        enableLogger:        GM_getValue('set_logger', true),
        accentPreset:        GM_getValue('am_accent', 'site')
    };
    // Тайтлы вкл, пока основной источник != 'off'
    settings.translateTitles = settings.titlePrimary !== 'off';

    /* ===== AniMori: акцентные темы тулкита =====
       --am-accent (по умолч. var(--color-blue), следует теме AniList). Пресет переопределяет её
       на documentElement → красит виджеты/модалки, не трогая тему сайта. Инлайновые
       «синий=AniList/розовый=Shikimori» намеренно на --color-blue (семантика источника). */
    const AM_ACCENTS = {
        site:       { name: 'Тема сайта', triple: null,          dot: 'rgb(var(--color-blue))' },
        sakura:     { name: 'Sakura',     triple: '244,114,182',  dot: '#f472b6' },
        mono:       { name: 'Mono',       triple: '148,163,184',  dot: '#94a3b8' },
        catppuccin: { name: 'Catppuccin', triple: '203,166,247',  dot: '#cba6f7' }
    };
    let amAccentTriple = null; // триплет "r,g,b" или null (следовать сайту)

    function amApplyAccentToDom() {
        // --am-accent на documentElement. 'site' (null) = синий AniList.
        document.documentElement.style.setProperty('--am-accent', amAccentTriple || 'var(--color-blue)');
    }

    function amSetAccent(preset) {
        const p = AM_ACCENTS[preset] ? preset : 'site';
        amAccentTriple = AM_ACCENTS[p].triple;
        amApplyAccentToDom();
    }

    // Локализация для парсера дат/времени
    const monthsFull = { Jan: 'января', Feb: 'февраля', Mar: 'марта', Apr: 'апреля', May: 'мая', Jun: 'июня', Jul: 'июля', Aug: 'августа', Sep: 'сентября', Oct: 'октября', Nov: 'ноября', Dec: 'декабря' };
    const days = { Mon: 'Пн', Tue: 'Вт', Wed: 'Ср', Thu: 'Чт', Fri: 'Пт', Sat: 'Сб', Sun: 'Вс' };
    const seasons = { Winter: 'Зима', Spring: 'Весна', Summer: 'Лето', Fall: 'Осень' };

    // Регэкспы перевода (роли, даты, время)
    const rxRole = /^(.+?)\s*\((.+)\)$/;
    const rxRoleEps = /\beps?\b/gi;
    const rxRoleOP = /\bOP\b/gi;
    const rxRoleED = /\bED\b/gi;
    const rxRanking = /^#(\d+)\s+(highest\s+rated|most\s+popular)\s+(.+)$/i;
    const rxTimeComplex = /^(\d+\s+\w+)(?:,\s*|\s+)(\d+\s+\w+)$/i;
    const rxHeight = /^(?:Height:\s+)?([\d\s\.,\-–—]+)\s*cm(?:\s*\((.*?)\))?$/i;
    const rxLiked = /^(\d+)\s+out\s+of\s+(\d+)\s+(?:users?\s+)?liked\s+this\s+review$/i;
    const rxDateFull = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})$/i;
    const rxBday = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:,)?\s+(\d{1,4})$/i;
    const rxSeason = /^(Winter|Spring|Summer|Fall)\s+(\d{4})$/i;
    const rxAct = /^(Watched|Rewatched|Read|Reread)\s+(episode|chapter)\s+([\d\s\-–—]+)\s+of$/i;
    const rxLabel = /^(Format|Status|Country|Chapters|Score|Count|Hours Watched|Mean Score|Chapters Read|Episodes|Released|Started|Amount|Progress|Finish Date|Birthday|Height|Age|Gender|Blood Type|Blood type|Occupation|Affiliation|Grade):\s*(.*)$/i;
    const rxUnit = /^(\d+)\s+(day|hour|hr|minute|min|mins|sec|episode|chapter|volume|reply|user)s?$/i;
    const rxRecent = /^(\d+)\s+recently\s+(watched|read)$/i;
    const rxReviewBy = /^a\s+review\s+by\s+(.+)$/i;
    const rxDayDate = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})$/i;
    const rxAgo = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
    const rxAiringEp = /^Ep\s+(\d+)\s+airing\s+in\s+(\d+)\s+(second|minute|min|hour|day|week|month)s?$/i;
    const rxAiringOnly = /^Airing\s+in\s+(\d+)\s+(second|minute|min|hour|day|week|month)s?$/i;
    const rxListAdded = /^(.+?)\s+added\s+to\s+(completed|watching|planning|dropped|paused|reading)\s+list$/i;
    const rxListUpdated = /^(.+?)\s+list\s+entry\s+updated$/i;

    // Утилиты
    function escapeHTML(str) {
        if (!str) return "";
        return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
    }

    /**
     * Сборка HTML: интерполяции экранируются. Доверенный HTML — rawHTML(value).
     */
    function html(strings, ...values) {
        return strings.reduce((out, str, i) => {
            const val = values[i - 1];
            const safe = (val && val.__isRawHTML) ? val.value : escapeHTML(val);
            return out + (i > 0 ? safe : '') + str;
        }, '');
    }
    function rawHTML(value) {
        return { __isRawHTML: true, value: String(value == null ? '' : value) };
    }

    // ==== Бегущая строка (ping-pong) для текста, не влезающего в контейнер ====
    // Спан + CSS-анимация «туда-сюда» при overflow; скорость ~ длине.
    function applyMarquee(el) {
        if (!el || el.dataset.amMarqInit) return;
        el.dataset.amMarqInit = '1';
        const inner = document.createElement('span');
        inner.className = 'am-marq-inner';
        while (el.firstChild) inner.appendChild(el.firstChild);
        el.appendChild(inner);
        el.classList.add('am-marq');
        const measure = () => {
            const overflow = inner.scrollWidth - el.clientWidth;
            if (overflow > 4) {
                el.style.setProperty('--am-marq-shift', `-${overflow}px`);
                el.style.setProperty('--am-marq-dur', `${Math.max(3, overflow / 40 + 1).toFixed(1)}s`);
                el.classList.add('am-marq-on');
            } else {
                el.classList.remove('am-marq-on');
                el.style.removeProperty('--am-marq-shift');
            }
        };
        requestAnimationFrame(measure);
        if (window.ResizeObserver) { try { new ResizeObserver(measure).observe(el); } catch (e) { /* игнор */ } }
    }

    // ==== Копирование в буфер с фидбэком на кнопке ====
    function amCopy(text, btn) {
        const done = () => {
            if (!btn) return;
            btn.classList.add('am-copied');
            setTimeout(() => btn.classList.remove('am-copied'), 1200);
        };
        try {
            if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); done(); return; }
        } catch (e) { /* провалимся на navigator.clipboard */ }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(e => Logger('WARN', 'Не удалось скопировать в буфер', e));
        } else {
            Logger('WARN', 'Буфер обмена недоступен');
        }
    }

    function getPlural(n, forms) {
        return (n % 10 === 1 && n % 100 !== 11 ? forms[0] : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? forms[1] : forms[2]));
    }

    // ==== Свои внешние ссылки ====
    // JSON в GM: массив { name, url, color }; url — шаблон с {ru}/{romaji}/{query}, color — триплет "r,g,b".
    const CL_COLORS = ['61,180,242', '243,139,168', '183,148,244', '166,227,161', '246,193,119', '224,82,100'];
    function getCustomLinks() {
        try {
            const raw = GM_getValue('am_custom_links', '[]');
            const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function setCustomLinks(arr) {
        try { GM_setValue('am_custom_links', JSON.stringify(arr)); } catch (e) { /* noop */ }
    }

    // ==== Локальный словарь перевода ====
    // JSON в GM: { "Оригинал": "Перевод" }. Накладывается ПОВЕРХ удалённого (user > remote).
    // Ключи нормализуются как в translateAdvanced (пробелы+trim), иначе не поймается при поиске.
    let remoteDict = Object.create(null);  // база с GitHub (до слияния)
    let amRetranslate = null;              // ре-скан DOM (ставится в initTranslator)

    function normDictKey(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
    function getUserDict() {
        try {
            const raw = GM_getValue('am_user_dict', '{}');
            const obj = (raw && typeof raw === 'object') ? raw : JSON.parse(raw || '{}');
            return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
        } catch (e) { return {}; }
    }
    function setUserDict(obj) {
        try { GM_setValue('am_user_dict', JSON.stringify(obj)); } catch (e) { /* noop */ }
    }
    // Пересобрать: база + правки юзера.
    function rebuildDictionary() {
        dictionary = Object.assign(Object.create(null), remoteDict, getUserDict());
    }
    // Добавить/обновить запись, применить вживую.
    function upsertUserDictEntry(source, translation) {
        const k = normDictKey(source);
        const v = normDictKey(translation);
        if (!k || !v) return false;
        const ud = getUserDict();
        ud[k] = v;
        setUserDict(ud);
        rebuildDictionary();
        if (typeof amRetranslate === 'function') amRetranslate();
        return true;
    }
    function removeUserDictEntry(source) {
        const k = normDictKey(source);
        const ud = getUserDict();
        if (Object.prototype.hasOwnProperty.call(ud, k)) { delete ud[k]; setUserDict(ud); rebuildDictionary(); }
    }

    // ==========================================
    //1.5. ЛОГГЕР СКРИПТА (отладка)
    // ==========================================

    const LOG_LIMIT = 1000;
    let scriptLogs =[];
    let isLoggerOpen = false;
    let activeLogFilter = 'ALL';
    let activeSearchQuery = '';
    let unreadLogs = 0;

    // Восстановление логов из сессии
    if (settings.enableLogger) {
        try {
            const savedLogs = sessionStorage.getItem('animori_logs');
            if (savedLogs) scriptLogs = JSON.parse(savedLogs);
        } catch (e) {
            // Logger может быть не готов — прямой console.warn.
            console.warn('[AniMori] Не удалось восстановить логи сессии', e);
        }
    }

    // Интерактивный просмотрщик JSON
    function createJSONView(obj, isRoot = true) {
        if (obj === null) return '<span style="color:#f38ba8">null</span>';
        if (typeof obj === 'undefined') return '<span style="color:#f38ba8">undefined</span>';
        if (typeof obj === 'boolean') return `<span style="color:#cba6f7">${obj}</span>`;
        if (typeof obj === 'number') return `<span style="color:#fab387">${obj}</span>`;
        if (typeof obj === 'string') return `<span style="color:#a6e3a1">"${escapeHTML(obj)}"</span>`;

        if (Array.isArray(obj)) {
            if (obj.length === 0) return '[]';
            // jsonHtml, не html — не затеняем html``.
            let jsonHtml = `<details ${isRoot ? 'open' : ''} style="margin-left:${isRoot?0:15}px;"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none;">Array(${obj.length})[</summary><div style="margin-left:15px; border-left:1px solid rgba(255,255,255,0.1); padding-left:10px;">`;
            for(let i=0; i<obj.length; i++) {
                jsonHtml += `<div style="margin-bottom:2px;"><span style="color:#cdd6f4">${i}:</span> ${createJSONView(obj[i], false)}</div>`;
            }
            jsonHtml += `</div><span style="color:#89b4fa;">]</span></details>`;
            return jsonHtml;
        }

        if (typeof obj === 'object') {
            const keys = Object.keys(obj);
            if (keys.length === 0) return '{}';
            let jsonHtml = `<details ${isRoot ? 'open' : ''} style="margin-left:${isRoot?0:15}px;"><summary style="cursor:pointer;color:#89b4fa;user-select:none;outline:none;">Object {</summary><div style="margin-left:15px; border-left:1px solid rgba(255,255,255,0.1); padding-left:10px;">`;
            for(let key of keys) {
                jsonHtml += `<div style="margin-bottom:2px;"><span style="color:#cdd6f4">"${escapeHTML(key)}":</span> ${createJSONView(obj[key], false)}</div>`;
            }
            jsonHtml += `</div><span style="color:#89b4fa;">}</span></details>`;
            return jsonHtml;
        }
        return escapeHTML(String(obj));
    }

    // Главная функция логирования
    function Logger(type, message, details = null) {
        if (!settings.enableLogger) return;

        let parsedDetails = details;
        if (details instanceof Error) {
            parsedDetails = { name: details.name, message: details.message, stack: details.stack };
        }

        const d = new Date();
        const time = `${d.toLocaleTimeString('ru-RU', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
        const path = window.location.pathname; // URL-контекст
        const stackLines = new Error().stack.split('\n');
        const stack = stackLines.length > 2 ? stackLines.slice(2).join('\n') : '';

        const entry = { id: Date.now() + Math.random(), time, path, type, message, details: parsedDetails, stack };
        scriptLogs.push(entry);

        let typeCount = 0;
        for (let i = scriptLogs.length - 1; i >= 0; i--) {
            if (scriptLogs[i].type === type) {
                typeCount++;
                if (typeCount > LOG_LIMIT) {
                    scriptLogs.splice(i, 1);
                    break;
                }
            }
        }

        // В сессию (последние 200 — квота)
        try { sessionStorage.setItem('animori_logs', JSON.stringify(scriptLogs.slice(-200))); } catch (e) {}

        if (isLoggerOpen) appendLogEntry(entry);
        if (type === 'ERROR') console.error(`[AniMori ERROR] ${message}`, details || '');
        else if (type === 'WARN') console.warn(`[AniMori WARN] ${message}`, details || '');
    }

    /**
     * Наша ли ошибка (по маркерам filename/stack).
     */
    function isOwnScriptSource(str) {
        if (!str) return false;
        const s = String(str).toLowerCase();
        return s.includes('userscript') || s.includes('tampermonkey') || s.includes('animori') || s.includes('.user.js');
    }

    // Глобальный перехватчик ошибок скрипта
    if (settings.enableLogger) {
        window.addEventListener('error', (e) => {
            // Только свои, не баги AniList/Shikimori
            if (isOwnScriptSource(e.filename) || isOwnScriptSource(e.error?.stack)) {
                Logger('ERROR', `Uncaught Error: ${e.message}`, { file: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
            }
        });
        window.addEventListener('unhandledrejection', (e) => {
            if (isOwnScriptSource(e.reason && e.reason.stack)) {
                Logger('ERROR', `Unhandled Promise Rejection: ${e.reason}`, typeof e.reason === 'object' ? e.reason : { reason: e.reason });
            }
        });
    }

    /**
     * Вызывает fn (async ок), логируя ошибки в Logger('ERROR').
     * Пример: await safeCall(() => anilistQuery(query, vars, true), 'anilistQuery/Viewer');
     * @param {Function} fn - функция без аргументов (async ок).
     * @param {string} context - место вызова для лога.
     * @param {{silent?: boolean}} [options] - silent=true подавляет повторный throw.
     * @returns {Promise<*>} результат fn(), либо undefined при silent=true и ошибке.
     */
    async function safeCall(fn, context, { silent = false } = {}) {
        try {
            return await fn();
        } catch (e) {
            Logger('ERROR', `Ошибка в ${context}: ${e && e.message ? e.message : e}`, e);
            if (!silent) throw e;
        }
    }

    // Рендер одной записи лога
    function createSingleLogEl(entry) {
        const el = document.createElement('div');
        el.className = `am-log-entry type-${entry.type.toLowerCase()}`;

        let detailsHtml = rawHTML('');
        if (entry.details) {
            // createJSONView экранирует сам — доверенный HTML.
            detailsHtml = rawHTML(`<div class="am-log-details" style="display:none;">${createJSONView(entry.details)}</div>`);
        }

        const shortPath = entry.path === '/' ? '/' : (entry.path.split('/').slice(1, 3).join('/') || '/');

        el.innerHTML = html`
            <div class="am-log-header">
                <span class="am-log-time">${entry.time}</span>
                <span class="am-log-badge">${entry.type}</span>
                <span class="am-log-path" title="${entry.path}">/${shortPath}</span>
                <span class="am-log-msg">${entry.message}</span>
                <div style="margin-left:auto; display:flex; gap:8px; align-items:center;">
                    ${rawHTML(entry.stack ? '<span class="am-log-btn-stack" title="Показать Stack Trace">[Stack]</span>' : '')}
                    ${rawHTML(entry.details ? '<span class="am-log-expand">▼</span>' : '')}
                </div>
            </div>
            ${rawHTML(entry.stack ? `<div class="am-log-stack-details" style="display:none; padding:8px 12px; background:rgba(252,129,129,0.1); border-top:1px solid rgba(255,255,255,0.05);"><pre style="margin:0; font-size:10.5px; color:#f38ba8; white-space:pre-wrap; font-family:inherit;">${escapeHTML(entry.stack)}</pre></div>` : '')}
            ${detailsHtml}
        `;

        if (entry.details) {
            const header = el.querySelector('.am-log-header');
            header.style.cursor = 'pointer';
            header.onclick = (e) => {
                if (e.target.classList.contains('am-log-btn-stack')) return;
                e.stopPropagation();
                const det = el.querySelector('.am-log-details');
                const isHidden = det.style.display === 'none';
                det.style.display = isHidden ? 'block' : 'none';
                el.querySelector('.am-log-expand').style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
            };
        }

        if (entry.stack) {
            const stackBtn = el.querySelector('.am-log-btn-stack');
            stackBtn.onclick = (e) => {
                e.stopPropagation();
                const stackEl = el.querySelector('.am-log-stack-details');
                stackEl.style.display = stackEl.style.display === 'none' ? 'block' : 'none';
            };
        }

        return el;
    }

    function updateScrollBtn() {
        const btn = document.getElementById('am-log-scroll-down');
        if (!btn) return;
        if (unreadLogs > 0) {
            btn.style.display = 'block';
            btn.textContent = `⬇ Новые логи (${unreadLogs})`;
        } else {
            btn.style.display = 'none';
        }
    }

    function appendLogEntry(entry) {
        const container = document.getElementById('am-log-container');
        if (!container) return;
        if (activeLogFilter !== 'ALL' && activeLogFilter !== entry.type) return;

        // Фильтрация поиска
        if (activeSearchQuery) {
            const q = activeSearchQuery.toLowerCase();
            const msg = entry.message.toLowerCase();
            const path = entry.path.toLowerCase();
            let detailsStr = '';
            try { detailsStr = JSON.stringify(entry.details || {}).toLowerCase(); } catch(e){}
            if (!msg.includes(q) && !detailsStr.includes(q) && !path.includes(q)) return;
        }

        const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 30;
        // При поиске группировка отключена
        const canGroup = activeLogFilter === 'ALL' && !activeSearchQuery &&['API', 'DB', 'QUEUE'].includes(entry.type);
        const lastChild = container.lastElementChild;

        if (canGroup && lastChild) {
            if (lastChild.classList.contains('am-log-group') && lastChild.dataset.groupType === entry.type) {
                lastChild.querySelector('.am-log-group-items').appendChild(createSingleLogEl(entry));
                let count = parseInt(lastChild.dataset.groupCount) + 1;
                lastChild.dataset.groupCount = count;
                lastChild.querySelector('.am-log-group-count').textContent = `Сгруппировано (${count})`;
            } else if (lastChild.classList.contains('am-log-entry') && lastChild.classList.contains(`type-${entry.type.toLowerCase()}`)) {
                const prevNode = lastChild;
                container.removeChild(prevNode);
                const groupEl = document.createElement('div');
                groupEl.className = `am-log-group type-${entry.type.toLowerCase()}`;
                groupEl.dataset.groupType = entry.type;
                groupEl.dataset.groupCount = "2";
                groupEl.innerHTML = html`
                    <div class="am-log-header am-log-group-header">
                        <span class="am-log-time">${entry.time}</span>
                        <span class="am-log-badge">${entry.type}</span>
                        <span class="am-log-msg am-log-group-count" style="font-style: italic; color: #8b949e;">Сгруппировано (2)</span>
                        <span class="am-log-expand">▼</span>
                    </div>
                    <div class="am-log-group-items" style="display:none;"></div>
                `;
                const itemsContainer = groupEl.querySelector('.am-log-group-items');
                itemsContainer.appendChild(prevNode);
                itemsContainer.appendChild(createSingleLogEl(entry));

                const header = groupEl.querySelector('.am-log-group-header');
                header.style.cursor = 'pointer';
                header.onclick = () => {
                    const isHidden = itemsContainer.style.display === 'none';
                    itemsContainer.style.display = isHidden ? 'block' : 'none';
                    groupEl.querySelector('.am-log-expand').style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
                };
                container.appendChild(groupEl);
            } else { container.appendChild(createSingleLogEl(entry)); }
        } else { container.appendChild(createSingleLogEl(entry)); }

        if (isAtBottom) {
            container.scrollTop = container.scrollHeight;
            unreadLogs = 0;
        } else {
            unreadLogs++;
        }
        updateScrollBtn();
    }

    function renderAllLogs() {
        const container = document.getElementById('am-log-container');
        if (!container) return;
        container.innerHTML = '';
        scriptLogs.forEach(appendLogEntry);
        container.scrollTop = container.scrollHeight;
        unreadLogs = 0;
        updateScrollBtn();
    }

    // UI логгера
    function openLoggerModal() {
        if (document.getElementById('am-logger-overlay')) return;
        isLoggerOpen = true;
        unreadLogs = 0;

        const overlay = document.createElement('div');
        overlay.id = 'am-logger-overlay';
        overlay.innerHTML = html`
            <div class="am-logger-modal" style="position:relative;">
                <div class="am-logger-header">
                    <h2>AniMori Logger <span style="font-size:12px;opacity:0.6;font-weight:normal;">(Session Memory)</span></h2>
                    <input type="text" id="am-log-search" placeholder="Поиск по логам..." style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;width:200px;transition:0.2s;">
                    <div class="am-logger-filters">
                        <button class="am-log-filter ${activeLogFilter === 'ALL' ? 'active' : ''}" data-filter="ALL">ALL</button>
                        <button class="am-log-filter ${activeLogFilter === 'INFO' ? 'active' : ''}" data-filter="INFO">INFO</button>
                        <button class="am-log-filter ${activeLogFilter === 'WARN' ? 'active' : ''}" data-filter="WARN">WARN</button>
                        <button class="am-log-filter ${activeLogFilter === 'API' ? 'active' : ''}" data-filter="API">API</button>
                        <button class="am-log-filter ${activeLogFilter === 'DB' ? 'active' : ''}" data-filter="DB">DB</button>
                        <button class="am-log-filter ${activeLogFilter === 'QUEUE' ? 'active' : ''}" data-filter="QUEUE">QUEUE</button>
                        <button class="am-log-filter ${activeLogFilter === 'ERROR' ? 'active' : ''}" data-filter="ERROR">ERROR</button>
                    </div>
                    <div class="am-logger-actions">
                        <button id="am-log-state">Состояние</button>
                        <button id="am-log-download">Скачать</button>
                        <button id="am-log-copy">Копировать</button>
                        <button id="am-log-clear">Очистить</button>
                        <button id="am-log-close">✖</button>
                    </div>
                </div>
                <div id="am-log-container"></div>
                <button id="am-log-scroll-down" style="display:none; position:absolute; bottom:25px; right:30px; background:#3dbbee; color:#fff; border:none; border-radius:20px; padding:8px 16px; cursor:pointer; box-shadow:0 4px 15px rgba(0,0,0,0.5); font-weight:bold; z-index:10; transition:0.2s;"></button>
            </div>
        `;
        document.body.appendChild(overlay);

        const container = document.getElementById('am-log-container');
        container.onscroll = () => {
            if (container.scrollHeight - container.scrollTop <= container.clientHeight + 30) {
                unreadLogs = 0; updateScrollBtn();
            }
        };

        const searchInput = document.getElementById('am-log-search');
        searchInput.value = activeSearchQuery;
        searchInput.oninput = (e) => {
            activeSearchQuery = e.target.value.trim();
            renderAllLogs();
        };

        document.getElementById('am-log-scroll-down').onclick = () => {
            container.scrollTop = container.scrollHeight;
            unreadLogs = 0; updateScrollBtn();
        };

        document.getElementById('am-log-close').onclick = () => { overlay.remove(); isLoggerOpen = false; };
        document.getElementById('am-log-clear').onclick = () => { scriptLogs=[]; sessionStorage.removeItem('animori_logs'); renderAllLogs(); Logger('INFO', 'Логгер очищен вручную'); };

        document.getElementById('am-log-copy').onclick = () => {
            const text = scriptLogs.map(l => `[${l.time}][${l.type}][PATH: ${l.path}] ${l.message} \n${l.details ? JSON.stringify(l.details, null, 2) : ''}`).join('\n\n');
            navigator.clipboard.writeText(text);
            const btn = document.getElementById('am-log-copy');
            btn.textContent = '✔ Скопировано';
            setTimeout(() => btn.textContent = 'Копировать', 2000);
        };

        document.getElementById('am-log-download').onclick = () => {
            const text = scriptLogs.map(l =>
                `[${l.time}] [${l.type}][PATH: ${l.path}]\nMSG: ${l.message}\nDETAILS: ${l.details ? JSON.stringify(l.details, null, 2) : 'null'}\nSTACK:\n${l.stack}\n---------------------------------------------------`
            ).join('\n\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `animori_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        };

        // Инспектор: слепок работы скрипта
        document.getElementById('am-log-state').onclick = async () => {
            document.getElementById('am-log-state').textContent = 'Загрузка...';

            const dbStats = await getDbStats();

            const state = {
                url: window.location.href,
                settings: settings,
                currentMediaId: typeof currentMediaId !== 'undefined' ? currentMediaId : null,
                queueSizes: {
                    MED2: globalPendingQueues?.MED2?.size || 0,
                    CHR2: globalPendingQueues?.CHR2?.size || 0,
                    STF3: globalPendingQueues?.STF3?.size || 0
                },
                databaseCache: dbStats,
                rateLimits: {
                    alRateLimitPause: alRateLimitPause > Date.now() ? new Date(alRateLimitPause).toLocaleTimeString() : 'OK',
                    shikiRateLimitPause: shikiRateLimitPause > Date.now() ? new Date(shikiRateLimitPause).toLocaleTimeString() : 'OK',
                    anime365: {
                        rateLimitPause: anime365RateLimitPause > Date.now() ? new Date(anime365RateLimitPause).toLocaleTimeString() : 'OK',
                        failStreak: `${anime365FailStreak}/${ANIME365_FAIL_LIMIT}`,
                        disabled: anime365Disabled
                    }
                },
                translationSources: {
                    titlePrimary: settings.titlePrimary,
                    titleFallback: settings.titleFallback
                }
            };

            Logger('INFO', 'DUMP: Текущее состояние скрипта', state);
            renderAllLogs();
            if(container) container.scrollTop = container.scrollHeight;
            document.getElementById('am-log-state').textContent = 'Состояние';
        };

        overlay.querySelectorAll('.am-log-filter').forEach(btn => {
            btn.onclick = (e) => {
                overlay.querySelectorAll('.am-log-filter').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                activeLogFilter = e.target.dataset.filter;
                renderAllLogs();
            };
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); isLoggerOpen = false; }
        });

        renderAllLogs();
    }

    // ==========================================
    // 1.5 СКАНЕР ДЕЛЬТЫ: сравнение списков Shikimori <-> AniList (read-only)
    // Ключ — MAL id (Shikimori id == MAL id, у AniList idMal). Read-only: статистика и расхождения.
    // ==========================================

    const CMP_STATUS_ORDER = ['watching', 'rewatching', 'planned', 'completed', 'on_hold', 'dropped'];
    const CMP_STATUS_LABEL = {
        watching: 'Смотрю/Читаю', rewatching: 'Пересматриваю', planned: 'Запланировано',
        completed: 'Просмотрено', on_hold: 'Отложено', dropped: 'Брошено', null: '—'
    };
    const AL_STATUS_MAP = { CURRENT: 'watching', REPEATING: 'rewatching', PLANNING: 'planned', COMPLETED: 'completed', PAUSED: 'on_hold', DROPPED: 'dropped' };
    // Связи AniList (сезоны/куски, сиквелы/приквелы) — для группировки «связанных» (B).
    const CMP_SPLIT_RELATIONS = ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'ALTERNATIVE', 'SPIN_OFF'];
    let cmpLast = null; // снимок последнего скана (перерисовка без сети)

    // Игнор-лист (C): MAL id, скрытые юзером (ложные расхождения).
    /**
     * Читает игнор-лист сканера дельты.
     * @returns {Set<number>} Множество MAL id (пустое при отсутствии/повреждении).
     */
    function cmpGetIgnore() { try { return new Set(JSON.parse(GM_getValue('CMP_IGNORE', '[]'))); } catch (e) { Logger('WARN', 'Сканер сравнения: повреждён игнор-лист CMP_IGNORE, сброшен в пустой', e); return new Set(); } }
    /**
     * Сохраняет игнор-лист в GM.
     * @param {Set<number>} set Множество MAL id.
     * @returns {void}
     */
    function cmpSaveIgnore(set) { GM_setValue('CMP_IGNORE', JSON.stringify([...set])); }
    /**
     * Добавляет MAL id в игнор-лист.
     * @param {number|string} id MAL id (→ Number).
     * @returns {void}
     */
    function cmpAddIgnore(id) { const s = cmpGetIgnore(); s.add(Number(id)); cmpSaveIgnore(s); }
    /**
     * Убирает MAL id из игнор-листа.
     * @param {number|string} id MAL id (→ Number).
     * @returns {void}
     */
    function cmpRemoveIgnore(id) { const s = cmpGetIgnore(); s.delete(Number(id)); cmpSaveIgnore(s); }

    /**
     * Экранирует HTML для шаблонов сканера дельты.
     * @param {*} s Произвольное значение (→ строка).
     * @returns {string} Экранированная строка (& < >).
     */
    function cmpEsc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    /**
     * Русская метка статуса (Shikimori-стиль).
     * @param {?string} s Статус ('watching'|'rewatching'|'planned'|'completed'|'on_hold'|'dropped'|null).
     * @returns {string} Русская метка, либо '—' если неизвестен.
     */
    function cmpStatusLabel(s) { return CMP_STATUS_LABEL[s] || '—'; }
    /**
     * Форматирует оценку 0..10 для таблицы сравнения.
     * @param {number} v Оценка по шкале 0..10.
     * @returns {string} Оценка с 1 знаком, либо '—' если нет (v <= 0).
     */
    function cmpFmtScore(v) { return v > 0 ? (Math.round(v * 10) / 10).toString() : '—'; }
    /**
     * Форматирует прогресс записи для таблицы сравнения.
     * @param {CmpListEntry} e Нормализованная запись (AniList или Shikimori).
     * @param {'anime'|'manga'} type Тип тайтла.
     * @returns {string} "N эп." (аниме) или "N гл. / M т." (манга).
     */
    function cmpFmtProg(e, type) { return type === 'manga' ? `${e.progress} гл. / ${e.volumes} т.` : `${e.progress} эп.`; }

    // Список юзера AniList, ключ = idMal. POINT_100 → /10 (независимо от шкалы юзера).
    /**
     * Грузит список юзера AniList и нормализует под Shikimori (см. CmpAniListEntry).
     * @param {string} userName Имя пользователя AniList.
     * @param {'ANIME'|'MANGA'} type Тип тайтла.
     * @returns {Promise<Map<number, CmpAniListEntry>>} Карта MAL id -> нормализованная запись.
     */
    async function cmpFetchAniListList(userName, type) {
        const q = `query($n:String,$t:MediaType){MediaListCollection(userName:$n,type:$t){lists{entries{status score(format:POINT_100) progress progressVolumes repeat notes media{idMal title{romaji english} relations{edges{relationType node{idMal}}}}}}}}`;
        const res = await anilistQuery(q, { n: userName, t: type }, true);
        const lists = res && res.data && res.data.MediaListCollection && res.data.MediaListCollection.lists || [];
        const map = new Map();
        for (const l of lists) for (const e of (l.entries || [])) {
            const mal = e.media && e.media.idMal;
            if (!mal) continue;
            map.set(mal, {
                malId: mal,
                title: (e.media.title && (e.media.title.romaji || e.media.title.english)) || ('MAL#' + mal),
                status: AL_STATUS_MAP[e.status] || null,
                score10: e.score ? e.score / 10 : 0,
                progress: e.progress || 0,
                volumes: e.progressVolumes || 0,
                rewatches: e.repeat || 0,
                notes: (e.notes || '').trim(),
                relations: ((e.media.relations && e.media.relations.edges) || [])
                    .filter(ed => CMP_SPLIT_RELATIONS.includes(ed.relationType))
                    .map(ed => ed.node && ed.node.idMal).filter(Boolean),
            });
        }
        return map;
    }

    // Избранное AniList (пагинация). idMal -> название.
    /**
     * Грузит избранное юзера AniList постранично.
     * @param {string} userName Имя пользователя AniList.
     * @param {'anime'|'manga'} kind Раздел избранного (поле favourites.{kind}).
     * @returns {Promise<Map<number, string>>} Карта MAL id -> название тайтла.
     */
    async function cmpFetchAniListFavs(userName, kind) {
        const map = new Map(); let page = 1;
        while (true) {
            const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{idMal title{romaji english}}}}}}`;
            const res = await anilistQuery(q, { n: userName, p: page }, true);
            const fav = res && res.data && res.data.User && res.data.User.favourites && res.data.User.favourites[kind];
            if (!fav) break;
            for (const n of (fav.nodes || [])) { if (n.idMal) map.set(n.idMal, (n.title && (n.title.romaji || n.title.english)) || ('MAL#' + n.idMal)); }
            if (!fav.pageInfo || !fav.pageInfo.hasNextPage) break;
            page++; await new Promise(r => setTimeout(r, 700));
        }
        return map;
    }

    // Список Shikimori через v1 *_rates, ключ = target id (== MAL id).
    /**
     * Грузит список юзера Shikimori через постраничный REST `{type}_rates`, нормализует под AniList.
     * @param {number|string} userId Shikimori user id.
     * @param {'anime'|'manga'} type Тип тайтла.
     * @returns {Promise<Map<number, CmpShikiEntry>>} Карта MAL id (== Shikimori id тайтла) -> нормализованная запись.
     */
    async function cmpFetchShikiList(userId, type) {
        const map = new Map(); let page = 1;
        while (true) {
            const r = await fetchShiki(`/api/users/${userId}/${type}_rates?limit=5000&page=${page}`);
            const data = r && r.data;
            if (!Array.isArray(data) || data.length === 0) break;
            for (const it of data) {
                const media = it[type];
                if (!media || !media.id) continue;
                const mal = media.id;
                map.set(mal, {
                    malId: mal,
                    title: media.russian || media.name || ('MAL#' + mal),
                    status: it.status || null,
                    score10: it.score || 0,
                    progress: type === 'anime' ? (it.episodes || 0) : (it.chapters || 0),
                    volumes: type === 'manga' ? (it.volumes || 0) : 0,
                    rewatches: it.rewatches || 0,
                    notes: (it.text || '').trim(),
                });
            }
            if (data.length < 5000) break;
            page++; await new Promise(r => setTimeout(r, 700));
        }
        return map;
    }

    /**
     * Грузит избранное Shikimori (аниме/манга/персонажи/стафф) одним запросом.
     * Персонажи/стафф не мостятся по id — только имена для матча (см. cmpNameDiff).
     * @param {number|string} userId Shikimori user id.
     * @returns {Promise<{anime: Map<number,string>, manga: Map<number,string>, characters: Array<{name:string,romaji:string}>, people: Array<{name:string,romaji:string}>}>}
     *          Избранное, разложенное по категориям.
     */
    async function cmpFetchShikiFavs(userId) {
        const r = await fetchShiki(`/api/users/${userId}/favourites`);
        const d = (r && r.data) || {};
        const toMap = arr => { const m = new Map(); (arr || []).forEach(x => { if (x && x.id) m.set(x.id, x.russian || x.name || ('MAL#' + x.id)); }); return m; };
        // Персонажи/стафф: id не мостится → матч по имени. Ромадзи (name) для матча, russian для показа.
        const toNames = arr => (arr || []).map(x => ({ name: x.russian || x.name || '', romaji: x.name || '' })).filter(x => x.name || x.romaji);
        // AniList staff — единый список; Shikimori разнесён по people/seyu/mangakas/producers → объединяем.
        const staffAll = [...(d.people || []), ...(d.seyu || []), ...(d.mangakas || []), ...(d.producers || [])];
        return { anime: toMap(d.animes), manga: toMap(d.mangas), characters: toNames(d.characters), people: toNames(staffAll) };
    }

    // Избранные персонажи/стафф AniList. id не мостится → только имена (full — ромадзи, native — оригинал).
    /**
     * Грузит избранных персонажей/стафф юзера AniList постранично.
     * @param {string} userName Имя пользователя AniList.
     * @param {'characters'|'staff'} kind Раздел избранного.
     * @returns {Promise<Array<{name: string, native: string}>>} Имена (full/native), без id (см. cmpNameDiff).
     */
    async function cmpFetchAniListFavPeople(userName, kind) {
        const arr = []; let page = 1;
        while (true) {
            const q = `query($n:String,$p:Int){User(name:$n){favourites{${kind}(page:$p){pageInfo{hasNextPage} nodes{name{full native}}}}}}`;
            const res = await anilistQuery(q, { n: userName, p: page }, true);
            const fav = res && res.data && res.data.User && res.data.User.favourites && res.data.User.favourites[kind];
            if (!fav) break;
            for (const n of (fav.nodes || [])) arr.push({ name: (n.name && n.name.full) || '', native: (n.name && n.name.native) || '' });
            if (!fav.pageInfo || !fav.pageInfo.hasNextPage) break;
            page++; await new Promise(r => setTimeout(r, 700));
        }
        return arr;
    }

    // Нормализация имени: lower, ё→е, разбивка по не-буквам, сортировка токенов (гасит порядок «Имя Фамилия»).
    /**
     * Нормализует имя для матча Shikimori<->AniList.
     * @param {?string} s Исходное имя (может быть null/undefined).
     * @returns {string} Нормализованная строка (lower, ё→е, токены отсортированы).
     */
    function cmpNormName(s) { return (s || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter(Boolean).sort().join(' '); }

    // Сравнение избранных персонажей/стаффа по имени.
    /**
     * Сравнивает избранных персонажей/стафф двух площадок по нормализованному имени.
     * @param {Array<{name:string,romaji:string}>} shikiArr Избранное Shikimori (name/romaji).
     * @param {Array<{name:string,native:string}>} alArr Избранное AniList (name/native).
     * @returns {{onlyShiki: Array<{title:string}>, onlyAl: Array<{title:string}>, shikiCount:number, alCount:number}}
     *          Расхождения по спискам избранного (только на одной из площадок) + счётчики.
     */
    function cmpNameDiff(shikiArr, alArr) {
        const alKeys = new Set(alArr.map(x => cmpNormName(x.name)).filter(Boolean));
        const shKeys = new Set(shikiArr.map(x => cmpNormName(x.romaji || x.name)).filter(Boolean));
        const onlyShiki = shikiArr.filter(x => { const k = cmpNormName(x.romaji || x.name); return k && !alKeys.has(k); }).map(x => ({ title: x.name }));
        const onlyAl = alArr.filter(x => { const k = cmpNormName(x.name); return k && !shKeys.has(k); }).map(x => ({ title: x.name || x.native }));
        return { onlyShiki, onlyAl, shikiCount: shikiArr.length, alCount: alArr.length };
    }

    // D: глубокая проверка каталогов (батчами) → MAL id, существующие в каталоге другой площадки (не в списке).
    /**
     * Глубокая проверка: для тайтлов не из списка одной площадки — есть ли они в каталоге другой (батчами по 50).
     * @param {{anime: number[], manga: number[]}} onlyShiki MAL id, которые есть только в списке Shikimori.
     * @param {{anime: number[], manga: number[]}} onlyAl MAL id, которые есть только в списке AniList.
     * @param {(text: string) => void} [setStatus] Колбэк для отображения текстового статуса прогресса.
     * @returns {Promise<{alHas: Set<number>, shikiHas: Set<number>}>} Множества MAL id, реально найденных в каталоге AniList/Shikimori.
     */
    async function cmpDeepCheck(onlyShiki, onlyAl, setStatus) {
        const alHas = new Set(), shikiHas = new Set();
        if (setStatus) setStatus('Глубокая проверка: каталог AniList...');
        for (const [type, ids] of [['ANIME', onlyShiki.anime], ['MANGA', onlyShiki.manga]]) {
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                const res = await anilistQuery(`query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){idMal}}}`, { m: chunk, t: type });
                const media = (res && res.data && res.data.Page && res.data.Page.media) || [];
                media.forEach(m => { if (m.idMal) alHas.add(m.idMal); });
                await new Promise(r => setTimeout(r, 700));
            }
        }
        if (setStatus) setStatus('Глубокая проверка: каталог Shikimori...');
        for (const [ep, ids] of [['animes', onlyAl.anime], ['mangas', onlyAl.manga]]) {
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                const r = await fetchShiki(`/api/${ep}?ids=${chunk.join(',')}&limit=50`);
                const data = (r && r.data) || [];
                if (Array.isArray(data)) data.forEach(m => { if (m && m.id) shikiHas.add(m.id); });
                await new Promise(r => setTimeout(r, 700));
            }
        }
        return { alHas, shikiHas };
    }

    /**
     * Агрегирует статистику по списку (кол-во по статусам, средняя оценка оценённых).
     * @param {Map<number, CmpListEntry>} map Нормализованный список (AniList или Shikimori).
     * @returns {{total:number, byStatus: Record<string, number>, mean: number}} Сводная статистика.
     */
    function cmpStats(map) {
        const st = {}; CMP_STATUS_ORDER.forEach(s => st[s] = 0);
        let scored = 0, sum = 0;
        for (const e of map.values()) {
            if (e.status && st[e.status] !== undefined) st[e.status]++;
            if (e.score10 > 0) { scored++; sum += e.score10; }
        }
        return { total: map.size, byStatus: st, mean: scored ? sum / scored : 0 };
    }

    // Расхождения по типу (anime|manga) → ведёрки.
    /**
     * Дифф между списками Shikimori и AniList для одного типа.
     * @param {Map<number, CmpShikiEntry>} shiki Нормализованный список Shikimori.
     * @param {Map<number, CmpAniListEntry>} al Нормализованный список AniList.
     * @param {'anime'|'manga'} type Тип тайтла.
     * @returns {{
     *   onlyShiki: Array<{id:number,title:string,info:string}>,
     *   onlyShikiRel: Array<{id:number,title:string,info:string}>,
     *   onlyAl: Array<{id:number,title:string,info:string}>,
     *   onlyAlRel: Array<{id:number,title:string,info:string}>,
     *   status: Array<{id:number,title:string,shiki:string,al:string}>,
     *   score: Array<{id:number,title:string,shiki:string,al:string}>,
     *   progress: Array<{id:number,title:string,shiki:string,al:string}>,
     *   rewatch: Array<{id:number,title:string,shiki:number,al:number}>,
     *   notes: Array<{id:number,title:string,shiki:string,al:string}>
     * }} Ведёрки расхождений по категориям.
     */
    function cmpDiff(shiki, al, type) {
        // idMal из связей AniList (детект «связанных»).
        const alRelated = new Set();
        for (const a of al.values()) for (const rid of (a.relations || [])) alRelated.add(rid);

        const ids = new Set([...shiki.keys(), ...al.keys()]);
        const out = { onlyShiki: [], onlyShikiRel: [], onlyAl: [], onlyAlRel: [], status: [], score: [], progress: [], rewatch: [], notes: [] };
        for (const id of ids) {
            const s = shiki.get(id), a = al.get(id);
            if (s && !a) {
                // B: на тайтл ссылается запись AniList — «связанный».
                (alRelated.has(id) ? out.onlyShikiRel : out.onlyShiki).push({ id, title: s.title, info: cmpStatusLabel(s.status) });
                continue;
            }
            if (a && !s) {
                // B: запись AniList связана с Shiki — «связанный».
                const rel = (a.relations || []).some(rid => shiki.has(rid));
                (rel ? out.onlyAlRel : out.onlyAl).push({ id, title: a.title, info: cmpStatusLabel(a.status) });
                continue;
            }
            const title = a.title || s.title;
            if (s.status !== a.status) out.status.push({ id, title, shiki: cmpStatusLabel(s.status), al: cmpStatusLabel(a.status) });
            if (Math.round(s.score10) !== Math.round(a.score10)) out.score.push({ id, title, shiki: cmpFmtScore(s.score10), al: cmpFmtScore(a.score10) });
            let pDiff = s.progress !== a.progress || (type === 'manga' && s.volumes !== a.volumes);
            if (pDiff) out.progress.push({ id, title, shiki: cmpFmtProg(s, type), al: cmpFmtProg(a, type) });
            if (s.rewatches !== a.rewatches) out.rewatch.push({ id, title, shiki: s.rewatches, al: a.rewatches });
            if (s.notes !== a.notes && (s.notes || a.notes)) out.notes.push({ id, title, shiki: s.notes ? 'есть' : '—', al: a.notes ? 'есть' : '—' });
        }
        return out;
    }

    /**
     * Сравнивает избранное (по id/MAL id) двух площадок.
     * @param {Map<number,string>} shikiFav Избранное Shikimori (id -> название).
     * @param {Map<number,string>} alFav Избранное AniList (idMal -> название).
     * @returns {{onlyShiki: Array<{id:number,title:string}>, onlyAl: Array<{id:number,title:string}>, shikiCount:number, alCount:number}}
     *          Расхождения избранного + счётчики.
     */
    function cmpFavDiff(shikiFav, alFav) {
        const ids = new Set([...shikiFav.keys(), ...alFav.keys()]);
        const onlyShiki = [], onlyAl = [];
        for (const id of ids) {
            if (shikiFav.has(id) && !alFav.has(id)) onlyShiki.push({ id, title: shikiFav.get(id) });
            else if (alFav.has(id) && !shikiFav.has(id)) onlyAl.push({ id, title: alFav.get(id) });
        }
        return { onlyShiki, onlyAl, shikiCount: shikiFav.size, alCount: alFav.size };
    }

    // Резолв Shikimori user id по логину/числовому id.
    /**
     * Резолвит Shikimori user id по логину (числовой id — как есть).
     * @param {string} login Логин Shikimori или числовой id (строкой).
     * @returns {Promise<number>} Numeric user id.
     * @throws {Error} Если пользователь не найден.
     */
    async function cmpResolveShikiUser(login) {
        const isNum = /^\d+$/.test(login);
        const path = isNum ? `/api/users/${login}` : `/api/users/${encodeURIComponent(login)}?is_nickname=1`;
        const r = await fetchShiki(path);
        if (r && r.data && r.data.id) return r.data.id;
        throw new Error('Пользователь Shikimori не найден: ' + login);
    }

    // --- Рендер ---
    /**
     * Рендерит таблицу статистики (статусы + средняя оценка) для одного типа.
     * @param {string} label Заголовок таблицы (например 'Аниме'/'Манга').
     * @param {{total:number, byStatus: Record<string, number>, mean: number}} sh Статистика Shikimori (см. cmpStats).
     * @param {{total:number, byStatus: Record<string, number>, mean: number}} al Статистика AniList (см. cmpStats).
     * @returns {string} Готовый HTML-фрагмент таблицы (значения экранированы через cmpEsc/числа).
     */
    function cmpRenderSummary(label, sh, al) {
        const rows = CMP_STATUS_ORDER.map(s =>
            `<tr><td>${CMP_STATUS_LABEL[s]}</td><td>${sh.byStatus[s]}</td><td>${al.byStatus[s]}</td><td style="color:rgb(var(--color-text-light));">${al.byStatus[s] - sh.byStatus[s] > 0 ? '+' : ''}${al.byStatus[s] - sh.byStatus[s] || ''}</td></tr>`
        ).join('');
        return `<table class="amk-table" style="margin-bottom:12px;">
            <thead><tr><th>${cmpEsc(label)}</th><th style="width:70px;color:rgb(var(--color-pink));">Shiki</th><th style="width:70px;color:rgb(var(--color-blue));">AniList</th><th style="width:50px;">Δ</th></tr></thead>
            <tbody>${rows}
            <tr style="font-weight:700;"><td>Всего</td><td>${sh.total}</td><td>${al.total}</td><td>${al.total - sh.total || ''}</td></tr>
            <tr><td>Средняя оценка</td><td>${sh.mean ? sh.mean.toFixed(2) : '—'}</td><td>${al.mean ? al.mean.toFixed(2) : '—'}</td><td></td></tr>
            </tbody></table>`;
    }

    /**
     * Рендерит HTML-блок расхождений (dA/dM) со свёрнутыми секциями.
     * @param {ReturnType<typeof cmpDiff>} diff Дифф одного типа (см. cmpDiff).
     * @param {Set<number>} ignore Игнор-лист MAL id (см. cmpGetIgnore) — скрываются.
     * @param {?{alHas: Set<number>, shikiHas: Set<number>}} catalog Результат cmpDeepCheck либо null.
     * @returns {string} Готовый HTML-фрагмент (значения экранированы через cmpEsc).
     */
    function cmpRenderDiff(diff, ignore, catalog) {
        const notIgn = arr => arr.filter(x => !ignore.has(Number(x.id)));
        const ignBtn = id => `<span class="amk-x cmp-ignore" data-id="${id}" title="Скрыть (в игнор)">✕</span>`;
        const row = (x, right) => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span><span class="amk-meta">${right || ''}</span>${ignBtn(x.id)}</div>`;
        const sec = (label, arr, fmt) => {
            const a = notIgn(arr);
            if (!a.length) return '';
            const items = a.slice(0, 500).map(fmt).join('');
            const more = a.length > 500 ? `<div style="opacity:.6;padding:6px;">…ещё ${a.length - 500}</div>` : '';
            return `<details class="amk-collapse"><summary>${cmpEsc(label)} <span class="amk-count">(${a.length})</span></summary><div class="amk-collapse-body">${items}${more}</div></details>`;
        };
        let h = '';
        // A: «только на одной площадке» — не ошибка синка.
        // D: глубокая проверка делит на «есть/нет в каталоге другой площадки».
        if (catalog) {
            h += sec('Только на Shikimori — ЕСТЬ в каталоге AniList (можно добавить)', diff.onlyShiki.filter(x => catalog.alHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
            h += sec('Только на Shikimori — НЕТ в каталоге AniList', diff.onlyShiki.filter(x => !catalog.alHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
            h += sec('Только на AniList — ЕСТЬ в каталоге Shikimori (можно добавить)', diff.onlyAl.filter(x => catalog.shikiHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
            h += sec('Только на AniList — НЕТ в каталоге Shikimori', diff.onlyAl.filter(x => !catalog.shikiHas.has(Number(x.id))), x => row(x, cmpEsc(x.info)));
        } else {
            h += sec('В списке только на Shikimori', diff.onlyShiki, x => row(x, cmpEsc(x.info)));
            h += sec('В списке только на AniList', diff.onlyAl, x => row(x, cmpEsc(x.info)));
        }
        // B: связанные — отдельным свёрнутым блоком.
        const rel = [...diff.onlyShikiRel, ...diff.onlyAlRel];
        h += sec('Связано с уже отслеживаемым (деление на сезоны / сиквелы)', rel, x => row(x, cmpEsc(x.info)));
        // Реальные разногласия по совпавшим (один MAL id).
        h += sec('Разный статус', diff.status, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разная оценка', diff.score, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разный прогресс', diff.progress, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разные пересмотры', diff.rewatch, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        h += sec('Разные заметки', diff.notes, x => row(x, `S: ${cmpEsc(x.shiki)} | A: ${cmpEsc(x.al)}`));
        const total = ['onlyShiki', 'onlyAl', 'onlyShikiRel', 'onlyAlRel', 'status', 'score', 'progress', 'rewatch', 'notes'].reduce((n, k) => n + notIgn(diff[k]).length, 0);
        if (!total) h += `<div style="opacity:.6;padding:8px;">Расхождений нет.</div>`;
        return h;
    }

    /**
     * Рендерит HTML-блок расхождений избранного (аниме+манга) с игнор-листом.
     * @param {ReturnType<typeof cmpFavDiff>} favA Расхождения избранного аниме.
     * @param {ReturnType<typeof cmpFavDiff>} favM Расхождения избранного манги.
     * @param {Set<number>} ignore Игнор-лист MAL id.
     * @returns {string} Готовый HTML-фрагмент.
     */
    function cmpRenderFavs(favA, favM, ignore) {
        const notIgn = arr => arr.filter(x => !ignore.has(Number(x.id)));
        const ignBtn = id => `<span class="amk-x cmp-ignore" data-id="${id}" title="Скрыть (в игнор)">✕</span>`;
        const sec = (label, arr) => {
            const a = notIgn(arr);
            if (!a.length) return '';
            const items = a.slice(0, 500).map(x => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span>${ignBtn(x.id)}</div>`).join('');
            return `<details class="amk-collapse"><summary>${cmpEsc(label)} <span class="amk-count">(${a.length})</span></summary><div class="amk-collapse-body">${items}</div></details>`;
        };
        let h = `<div style="font-size:13px;margin-bottom:6px;">Избранное — Аниме: <b style="color:rgb(var(--color-pink));">${favA.shikiCount}</b> Shiki / <b style="color:rgb(var(--color-blue));">${favA.alCount}</b> AniList · Манга: <b style="color:rgb(var(--color-pink));">${favM.shikiCount}</b> / <b style="color:rgb(var(--color-blue));">${favM.alCount}</b></div>`;
        h += sec('Избранное аниме: только в Shikimori', favA.onlyShiki);
        h += sec('Избранное аниме: только в AniList', favA.onlyAl);
        h += sec('Избранное манга: только в Shikimori', favM.onlyShiki);
        h += sec('Избранное манга: только в AniList', favM.onlyAl);
        if (!notIgn(favA.onlyShiki).length && !notIgn(favA.onlyAl).length && !notIgn(favM.onlyShiki).length && !notIgn(favM.onlyAl).length) h += `<div style="opacity:.6;padding:8px;">Избранное совпадает.</div>`;
        return h;
    }

    // Избранные персонажи/стафф — сравнение по имени (без id/игнора).
    /**
     * Рендерит HTML-блок расхождений избранных персонажей/стаффа (по имени).
     * @param {string} label Заголовок блока (например 'Избранные персонажи').
     * @param {ReturnType<typeof cmpNameDiff>} diff Результат cmpNameDiff.
     * @returns {string} Готовый HTML-фрагмент.
     */
    function cmpRenderNameFavs(label, diff) {
        const sec = (l, arr) => {
            if (!arr.length) return '';
            const items = arr.slice(0, 500).map(x => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(x.title)}</span></div>`).join('');
            const more = arr.length > 500 ? `<div style="opacity:.6;padding:6px;">…ещё ${arr.length - 500}</div>` : '';
            return `<details class="amk-collapse"><summary>${cmpEsc(l)} <span class="amk-count">(${arr.length})</span></summary><div class="amk-collapse-body">${items}${more}</div></details>`;
        };
        let h = `<div style="font-size:13px;margin:8px 0 4px;"><b>${cmpEsc(label)}</b> — <b style="color:rgb(var(--color-pink));">${diff.shikiCount}</b> Shiki / <b style="color:rgb(var(--color-blue));">${diff.alCount}</b> AniList <span style="opacity:.5;">(матч по имени, приблизительно)</span></div>`;
        h += sec(label + ': только в Shikimori', diff.onlyShiki);
        h += sec(label + ': только в AniList', diff.onlyAl);
        return h;
    }

    // Пересчёт диффа из cmpLast + рендер (игнор-лист), без сети.
    /**
     * Пересчёт диффа из cmpLast + рендер в DOM с игнор-листом. Без сети.
     * @param {HTMLElement} resultEl Контейнер результата.
     * @returns {void}
     */
    function cmpRender(resultEl) {
        if (!cmpLast) return;
        const ignore = cmpGetIgnore();
        const { shA, alA, shM, alM, shFav, alFavA, alFavM, alFavChar, alFavStaff, catalog } = cmpLast;
        const stA = { sh: cmpStats(shA), al: cmpStats(alA) };
        const stM = { sh: cmpStats(shM), al: cmpStats(alM) };
        const dA = cmpDiff(shA, alA, 'anime');
        const dM = cmpDiff(shM, alM, 'manga');
        const favA = cmpFavDiff(shFav.anime, alFavA);
        const favM = cmpFavDiff(shFav.manga, alFavM);
        const favChar = cmpNameDiff(shFav.characters || [], alFavChar || []);
        const favStaff = cmpNameDiff(shFav.people || [], alFavStaff || []);

        const titleOf = id => {
            id = Number(id);
            for (const m of [shA, alA, shM, alM]) { const e = m.get(id); if (e) return e.title; }
            for (const fm of [shFav.anime, alFavA, shFav.manga, alFavM]) { if (fm.has(id)) return fm.get(id); }
            return 'MAL#' + id;
        };
        const ignArr = [...ignore];
        const ignHtml = ignArr.length
            ? `<details class="amk-collapse"><summary>Игнорируемые <span class="amk-count">(${ignArr.length})</span></summary><div class="amk-collapse-body">${ignArr.map(id => `<div class="amk-diffrow"><span class="amk-name">${cmpEsc(titleOf(id))}</span><span class="cmp-unignore amk-x" data-id="${id}" title="Вернуть" style="color:rgb(var(--color-blue));opacity:.85;">↩</span></div>`).join('')}</div></details>`
            : '';

        // Под-HTML экранирован cmpEsc() — доверенный → rawHTML().
        resultEl.innerHTML = html`<div style="display:flex;gap:20px;flex-wrap:wrap;">
                <div style="flex:1;min-width:280px;">${rawHTML(cmpRenderSummary('Аниме', stA.sh, stA.al))}</div>
                <div style="flex:1;min-width:280px;">${rawHTML(cmpRenderSummary('Манга', stM.sh, stM.al))}</div>
             </div>
             <div style="margin-top:6px;">${rawHTML(cmpRenderFavs(favA, favM, ignore))}</div>
             ${rawHTML(cmpRenderNameFavs('Избранные персонажи', favChar))}
             ${rawHTML(cmpRenderNameFavs('Избранный стафф', favStaff))}
             <h3 style="margin:16px 0 4px;color:rgb(var(--color-text));">Аниме</h3>${rawHTML(cmpRenderDiff(dA, ignore, catalog))}
             <h3 style="margin:16px 0 4px;color:rgb(var(--color-text));">Манга</h3>${rawHTML(cmpRenderDiff(dM, ignore, catalog))}
             ${rawHTML(ignHtml)}
             <div style="opacity:.5;font-size:11px;margin-top:14px;line-height:1.5;">«В списке только на одной площадке» — не ошибка синка, а различие каталогов/списков. «Связано с уже отслеживаемым» — вероятно деление на сезоны или сиквелы (по связям AniList). Крестик ✕ — скрыть строку (игнор, запоминается). Даты не сравниваются. Оценки нормализованы к 10-балльной. Сопоставление по MAL id.</div>`;

        resultEl.querySelectorAll('.cmp-ignore').forEach(el => el.onclick = () => { cmpAddIgnore(el.dataset.id); cmpRender(resultEl); });
        resultEl.querySelectorAll('.cmp-unignore').forEach(el => el.onclick = () => { cmpRemoveIgnore(el.dataset.id); cmpRender(resultEl); });
    }

    /**
     * Полный скан (Shikimori <-> AniList): резолв юзеров, загрузка списков/избранного,
     * опц. глубокая проверка, снимок в cmpLast, рендер. Ошибки не бросает — в statusEl/лог.
     * @param {string} shikiLogin Логин или id пользователя Shikimori.
     * @param {string} alName Имя пользователя AniList (если пусто — берётся из Viewer по токену).
     * @param {?HTMLElement} statusEl Элемент для текстового статуса прогресса (может быть null).
     * @param {HTMLElement} resultEl Контейнер для рендера результата.
     * @param {boolean} deepCheck Включить глубокую проверку каталогов (см. cmpDeepCheck).
     * @returns {Promise<void>}
     */
    async function cmpRunScan(shikiLogin, alName, statusEl, resultEl, deepCheck) {
        const setStatus = t => { if (statusEl) statusEl.textContent = t; };
        try {
            GM_setValue('SHIKI_LOGIN', shikiLogin);
            // AniList-имя: пусто → из Viewer (нужен токен).
            if (!alName) {
                setStatus('Определяю пользователя AniList...');
                const v = await anilistQuery('query{Viewer{name}}', {}, true);
                alName = v && v.data && v.data.Viewer && v.data.Viewer.name;
                if (!alName) throw new Error('Не удалось определить AniList-пользователя. Укажите имя вручную или задайте токен в настройках.');
            }
            setStatus('Ищу пользователя Shikimori...');
            const shikiId = await cmpResolveShikiUser(shikiLogin);

            setStatus('Загружаю списки (аниме)...');
            const [shA, alA] = [await cmpFetchShikiList(shikiId, 'anime'), await cmpFetchAniListList(alName, 'ANIME')];
            setStatus('Загружаю списки (манга)...');
            const [shM, alM] = [await cmpFetchShikiList(shikiId, 'manga'), await cmpFetchAniListList(alName, 'MANGA')];
            setStatus('Загружаю избранное...');
            const shFav = await cmpFetchShikiFavs(shikiId);
            const alFavA = await cmpFetchAniListFavs(alName, 'anime');
            const alFavM = await cmpFetchAniListFavs(alName, 'manga');
            const alFavChar = await cmpFetchAniListFavPeople(alName, 'characters');
            const alFavStaff = await cmpFetchAniListFavPeople(alName, 'staff');

            // D: глубокая проверка каталогов (опц.).
            let catalog = null;
            if (deepCheck) {
                const dA0 = cmpDiff(shA, alA, 'anime');
                const dM0 = cmpDiff(shM, alM, 'manga');
                catalog = await cmpDeepCheck(
                    { anime: dA0.onlyShiki.map(x => x.id), manga: dM0.onlyShiki.map(x => x.id) },
                    { anime: dA0.onlyAl.map(x => x.id), manga: dM0.onlyAl.map(x => x.id) },
                    setStatus
                );
            }

            setStatus('Сравниваю...');
            cmpLast = { shA, alA, shM, alM, shFav, alFavA, alFavM, alFavChar, alFavStaff, catalog };
            cmpRender(resultEl);
            setStatus(`Готово: Shiki ${shA.size + shM.size} / AniList ${alA.size + alM.size} тайтлов.`);
        } catch (e) {
            Logger('ERROR', 'Сканер сравнения: ошибка', e);
            setStatus('Ошибка: ' + (e && e.message ? e.message : e));
        }
    }

    /**
     * Открывает модалку сканера (если закрыта), биндит обработчики,
     * префилл полей (логин Shiki из GM, имя AniList по токену).
     * @returns {Promise<void>}
     */
    async function openCompareModal() {
        if (document.getElementById('am-cmp-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'am-cmp-overlay';
        overlay.className = 'amk-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = html`
            <div class="amk-modal amk-wide">
                <div class="amk-head">
                    <h2 class="amk-title"><span class="amk-dot"></span><span style="color:rgb(var(--color-pink));">Shikimori</span>&nbsp;⇄&nbsp;<span style="color:rgb(var(--color-blue));">AniList</span> <span class="amk-sub">сравнение списков</span></h2>
                    <button class="amk-close" id="am-cmp-close" title="Закрыть">✕</button>
                </div>
                <div class="amk-head" style="border-bottom:1px solid rgba(var(--color-text-light),0.06);">
                    <input class="amk-input" id="am-cmp-shiki" placeholder="Логин Shikimori" style="flex:1;min-width:150px;width:auto;">
                    <input class="amk-input" id="am-cmp-al" placeholder="Имя AniList (авто по токену)" style="flex:1;min-width:150px;width:auto;">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;white-space:nowrap;" title="Проверяет по каталогам обеих площадок наличие недостающих тайтлов. Медленнее (доп. запросы)."><input type="checkbox" id="am-cmp-deep"> Глубокая проверка</label>
                    <button class="amk-btn amk-btn-primary" id="am-cmp-run">Сканировать</button>
                </div>
                <div id="am-cmp-status" style="padding:8px 18px;font-size:12px;color:rgb(var(--color-text-light));min-height:18px;flex-shrink:0;"></div>
                <div class="amk-body" id="am-cmp-result" style="padding-top:6px;"></div>
            </div>`;
        document.body.appendChild(overlay);

        const closeEl = () => overlay.remove();
        document.getElementById('am-cmp-close').onclick = closeEl;
        overlay.addEventListener('click', e => { if (e.target === overlay) closeEl(); });

        const shikiInput = document.getElementById('am-cmp-shiki');
        const alInput = document.getElementById('am-cmp-al');
        shikiInput.value = GM_getValue('SHIKI_LOGIN', '');
        // Префилл имени AniList из Viewer (если есть токен).
        anilistQuery('query{Viewer{name}}', {}, true).then(v => {
            const n = v && v.data && v.data.Viewer && v.data.Viewer.name;
            if (n && !alInput.value) alInput.placeholder = n + ' (по токену)';
        }).catch(() => {});

        const statusEl = document.getElementById('am-cmp-status');
        const resultEl = document.getElementById('am-cmp-result');
        const run = () => {
            const login = shikiInput.value.trim();
            if (!login) { statusEl.textContent = 'Укажите логин Shikimori.'; return; }
            const deep = document.getElementById('am-cmp-deep').checked;
            document.getElementById('am-cmp-run').disabled = true;
            cmpRunScan(login, alInput.value.trim(), statusEl, resultEl, deep).finally(() => {
                const b = document.getElementById('am-cmp-run'); if (b) b.disabled = false;
            });
        };
        document.getElementById('am-cmp-run').onclick = run;
        shikiInput.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
        alInput.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    }

    // ==========================================
    // 2. INDEXEDDB (кэш)
    // ==========================================

    /**
     * Миграции схемы IndexedDB. Ключ — версия, значение — мигратор `(db, tx) => {...}` от N-1 к N.
     * Прогон от `oldVersion+1` до `db.version`; каждый шаг идемпотентен (`objectStoreNames.contains(...)`).
     * Новая миграция: поднять DB_VERSION, добавить `[N+1]: ...`. Версии 1→5 консолидированы в шаг 5, далее с 6.
     */
    const DB_MIGRATIONS = {
        5: (db, tx) => {
            if (!db.objectStoreNames.contains('shikiCache')) db.createObjectStore('shikiCache', { keyPath: 'key' });
            if (!db.objectStoreNames.contains('malCache')) db.createObjectStore('malCache', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('franchiseCache')) db.createObjectStore('franchiseCache', { keyPath: 'id' });
        }
    };

    /**
     * Открывает IndexedDB (в globalDbInstance), прогоняя недостающие DB_MIGRATIONS.
     * @returns {Promise<?IDBDatabase>} База, либо null при ошибке.
     */
    async function openDB() {
        if (globalDbInstance) return globalDbInstance;
        return new Promise((resolve) => {
            Logger('DB', 'Открытие подключения к IndexedDB...');
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                const tx = e.target.transaction;
                const fromVersion = e.oldVersion || 0;
                Logger('DB', `Миграция БД: ${fromVersion} → ${DB_VERSION}`);

                for (let v = fromVersion + 1; v <= DB_VERSION; v++) {
                    const migrate = DB_MIGRATIONS[v];
                    if (!migrate) continue;
                    try {
                        migrate(db, tx);
                        Logger('DB', `Миграция БД: шаг ${v} выполнен успешно`);
                    } catch (err) {
                        Logger('ERROR', `Миграция БД: сбой на шаге ${v}`, err);
                    }
                }
            };

            req.onsuccess = () => {
                globalDbInstance = req.result;
                resolve(globalDbInstance);
            };

            req.onerror = (err) => {
                Logger('ERROR', 'Ошибка открытия IndexedDB', err);
                resolve(null);
            };
        });
    }

    /**
     * Читает запись из object store по ключу.
     * @param {'shikiCache'|'malCache'|'franchiseCache'} store Имя object store.
     * @param {IDBValidKey} key Ключ (shikiCache — строка `key`, malCache/franchiseCache — числовой `id`).
     * @returns {Promise<?(ShikiCacheRecord|MalCacheRecord|FranchiseCacheRecord)>} Запись либо null.
     */
    /**
     * Читает запись по ключу из object store.
     * @param {'shikiCache'|'malCache'|'franchiseCache'} store Имя object store.
     * @param {string|number} key keyPath стора (`key` для shikiCache, `id` для malCache/franchiseCache).
     * @returns {Promise<?(ShikiCacheRecord|MalCacheRecord|FranchiseCacheRecord)>} Запись, либо null.
     */
    async function dbGet(store, key) {
        try {
            const db = await openDB();
            if (!db) return null;
            return new Promise(resolve => {
                const req = db.transaction(store, 'readonly').objectStore(store).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => { Logger('ERROR', `Ошибка чтения DB (${store})`, key); resolve(null); };
            });
        } catch (e) {
            Logger('ERROR', `Сбой dbGet (${store})`, e);
            return null;
        }
    }

    /**
     * Пишет (put — вставка/перезапись) запись в object store.
     * @param {'shikiCache'|'malCache'|'franchiseCache'} store Имя object store.
     * @param {ShikiCacheRecord|MalCacheRecord|FranchiseCacheRecord} data Объект с keyPath стора (`key`/`id`).
     * @returns {Promise<void>}
     */
    async function dbSet(store, data) {
        try {
            const db = await openDB();
            if (!db) return;
            return new Promise(resolve => {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(data);
                tx.oncomplete = () => { Logger('DB', `Запись в кэш ${store} успешна`); resolve(); };
                tx.onerror = (e) => { Logger('ERROR', `Ошибка записи DB (${store})`, e); resolve(); };
            });
        } catch (e) {
            Logger('ERROR', `Сбой dbSet (${store})`, e);
        }
    }

    /**
     * Очищает все сторы кэша (shikiCache, malCache, franchiseCache).
     * @returns {Promise<void>}
     */
    async function clearCache() {
        Logger('INFO', 'Запущен ручной сброс кэша IndexedDB');
        const db = await openDB();
        if (!db) return;

        const tx = db.transaction(['shikiCache', 'malCache', 'franchiseCache'], 'readwrite');
        tx.objectStore('shikiCache').clear();
        tx.objectStore('malCache').clear();
        tx.objectStore('franchiseCache').clear();

        return new Promise(r => tx.oncomplete = r);
    }

    // Фоновый GC старых записей
    /**
     * GC: курсором по shikiCache удаляет записи старше CACHE_TIME (по `ts`). Fire-and-forget.
     * @returns {Promise<void>}
     */
    async function runGarbageCollector() {
        try {
            const db = await openDB();
            if (!db) return;
            const tx = db.transaction(['shikiCache'], 'readwrite');
            const store = tx.objectStore('shikiCache');
            const req = store.openCursor();
            let deletedCount = 0;

            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (Date.now() - cursor.value.ts > CACHE_TIME) {
                        cursor.delete();
                        deletedCount++;
                    }
                    cursor.continue();
                } else {
                    if (deletedCount > 0) Logger('DB', `Garbage Collector очистил ${deletedCount} устаревших записей из кэша`);
                }
            };
        } catch (e) {
            Logger('ERROR', 'Ошибка Garbage Collector', e);
        }
    }

    /**
     * Снимок БД/кэша для инспектора (записи по типам ключей, размер).
     * @returns {Promise<{media:number, characters:number, staff:number, themes:number, malMappings:number, totalCacheRecords:number, estimatedSize:string} | {error:string}>}
     *          Сводная статистика, либо объект с полем error при сбое.
     */
    async function getDbStats() {
        try {
            const db = await openDB();
            if (!db) return { error: 'БД недоступна' };

            // 1. Размер памяти до транзакции
            let estimatedSize = 'Неизвестно';
            try {
                if (navigator.storage && navigator.storage.estimate) {
                    const est = await navigator.storage.estimate();
                    estimatedSize = (est.usage / 1024 / 1024).toFixed(2) + ' MB';
                }
            } catch(e) { Logger('WARN', 'getDbStats: navigator.storage.estimate() недоступен', e); }

            // 2. Транзакция
            return new Promise((resolve) => {
                const tx = db.transaction(['shikiCache', 'malCache'], 'readonly');
                const shikiStore = tx.objectStore('shikiCache');
                const malStore = tx.objectStore('malCache');

                const stats = { media: 0, characters: 0, staff: 0, themes: 0, malMappings: 0, totalCacheRecords: 0, estimatedSize };

                const malReq = malStore.count();
                malReq.onsuccess = () => { stats.malMappings = malReq.result; };

                const shikiReq = shikiStore.getAllKeys();
                shikiReq.onsuccess = () => {
                    const keys = shikiReq.result;
                    stats.totalCacheRecords = keys.length;
                    keys.forEach(key => {
                        if (typeof key === 'string') {
                            if (key.startsWith('MED2_') || key.startsWith('FULL_')) stats.media++;
                            else if (key.startsWith('CHR2_')) stats.characters++;
                            else if (key.startsWith('STF3_')) stats.staff++;
                            else if (key.startsWith('THEMES_')) stats.themes++;
                        }
                    });
                };

                tx.oncomplete = () => resolve(stats);
                tx.onerror = () => resolve({ error: 'Ошибка чтения метрик БД' });
            });
        } catch (e) {
            Logger('ERROR', 'Сбой getDbStats', e);
            return { error: e.message };
        }
    }

    // ==========================================
    // 3. API И АВТОРИЗАЦИЯ
    // ==========================================

    // Типы данных (JSDoc)
    // -------------------------------------------------------------------------
    // Типы сканера дельты и кэша IndexedDB.

    /**
     * @typedef {Object} AniListMediaTitle
     * @property {?string} [romaji] Название ромадзи.
     * @property {?string} [english] Английское название.
     */

    /**
     * @typedef {Object} AniListRelationEdge
     * @property {string} relationType Тип связи ('SEQUEL', 'PREQUEL', 'PARENT', ...).
     * @property {{idMal: ?number}} node Связанный тайтл.
     */

    /**
     * Урезанный Media из AniList GraphQL (MediaListCollection.entries[].media).
     * @typedef {Object} AniListMediaLite
     * @property {?number} idMal MyAnimeList ID.
     * @property {AniListMediaTitle} [title]
     * @property {{edges: AniListRelationEdge[]}} [relations]
     */

    /**
     * Полный Media из AniList GraphQL (рендер виджетов страницы тайтла).
     * @typedef {Object} AniListMedia
     * @property {number} id AniList ID тайтла.
     * @property {'ANIME'|'MANGA'} type
     * @property {?number} idMal MyAnimeList ID.
     * @property {?number} [seasonYear]
     * @property {?number} [averageScore] Шкала 0..100.
     * @property {AniListMediaTitle} [title]
     * @property {{status: ?string, progress?: number}} [mediaListEntry]
     */

    /**
     * Запись списка AniList, нормализованная сканером дельты (ключ — malId).
     * @typedef {Object} CmpAniListEntry
     * @property {number} malId
     * @property {string} title
     * @property {?string} status Shikimori-стиль ('watching'|'rewatching'|'planned'|'completed'|'on_hold'|'dropped'|null).
     * @property {number} score10 Оценка 0..10.
     * @property {number} progress
     * @property {number} volumes
     * @property {number} rewatches
     * @property {string} notes
     * @property {number[]} relations idMal связанных тайтлов.
     */

    /**
     * Урезанный тайтл Shikimori из `${type}_rates`.
     * @typedef {Object} ShikiMediaLite
     * @property {number} id Равен MyAnimeList ID.
     * @property {?string} [russian]
     * @property {?string} [name]
     */

    /**
     * Карточка тайтла Shikimori (GET /api/animes|mangas/:id), только нужные поля.
     * @typedef {Object} ShikiMedia
     * @property {number} id
     * @property {?string} [russian]
     * @property {?string} [name]
     * @property {?string} [url]
     * @property {?string} [domain] Зеркало Shikimori.
     * @property {?string} [description]
     * @property {?number} [score] Шкала 0..10.
     * @property {Array<{name: string, value: number}>} [rates_scores_stats] Гистограмма оценок.
     */

    /**
     * Запись списка Shikimori, нормализованная сканером дельты (ключ — malId).
     * @typedef {Object} CmpShikiEntry
     * @property {number} malId
     * @property {string} title
     * @property {?string} status ('watching'|'rewatching'|'planned'|'completed'|'on_hold'|'dropped'|null).
     * @property {number} score10
     * @property {number} progress
     * @property {number} volumes
     * @property {number} rewatches
     * @property {string} notes
     */

    /** @typedef {CmpAniListEntry|CmpShikiEntry} CmpListEntry Нормализованная запись любого источника. */

    /**
     * Запись в IndexedDB `shikiCache` (keyPath 'key'): карточки тайтлов/персонажей/персонала/тем.
     * Форма одна, различаются префикс ключа и `data`.
     * @typedef {Object} ShikiCacheRecord
     * @property {string} key Составной ключ вида "ПРЕФИКС_id" (например "FULL_123").
     * @property {*} data Полезная нагрузка (зависит от префикса).
     * @property {number} ts Unix-таймстамп записи (для протухания по CACHE_TIME).
     */

    /**
     * Запись в IndexedDB `malCache` (keyPath 'id'): AniList ID -> AniListMedia.
     * @typedef {Object} MalCacheRecord
     * @property {number} id AniList Media ID.
     * @property {AniListMedia} data
     */

    /**
     * Запись в IndexedDB `franchiseCache` (keyPath 'id'). Зарезервирован под дерево франшизы, пока не заполняется.
     * @typedef {Object} FranchiseCacheRecord
     * @property {number} id
     * @property {*} data
     * @property {number} [ts]
     */


    /**
     * Токен AniList: из настроек, либо (на anilist.co) из Vuex у залогиненного юзера.
     * @returns {?string} Токен (Bearer), либо null.
     */
    function getAlToken() {
        let token = GM_getValue("AL_TOKEN");
        if (token) return token;

        // Токен из Vuex (если залогинен на AniList)
        if (IS_ANILIST) {
            try {
                const vuex = JSON.parse(localStorage.getItem('vuex'));
                if (vuex && vuex.auth && vuex.auth.token) return vuex.auth.token;
            } catch(e) { Logger('ERROR', 'Ошибка чтения Vuex хранилища AniList', e); }
        }
        return null;
    }

    /**
     * GraphQL к AniList (GM_xmlhttpRequest) с паузой после 429 и авто-ретраем.
     * @param {string} query GraphQL-запрос.
     * @param {Object<string, *>} variables Переменные GraphQL-запроса.
     * @param {boolean} [useAuth=false] Добавлять ли заголовок Authorization (см. getAlToken()).
     * @returns {Promise<{data?: *, errors?: *}>} Разобранный JSON-ответ AniList GraphQL.
     */
    async function anilistQuery(query, variables, useAuth = false) {
        if (Date.now() < alRateLimitPause) {
            await new Promise(r => setTimeout(r, alRateLimitPause - Date.now() + Math.floor(Math.random() * 500)));
        }

        const headers = { "Content-Type": "application/json", "Accept": "application/json" };
        if (useAuth) {
            const token = getAlToken();
            if (token) headers["Authorization"] = "Bearer " + token;
        }

        Logger('API', 'GraphQL запрос (AniList)', { query: query.substring(0, 100) + '...', variables, useAuth });

        const startTime = performance.now();

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: "https://graphql.anilist.co",
                headers,
                data: JSON.stringify({ query, variables }),
                onload: (res) => {
                    if (res.status === 200) {
                        const timeTaken = Math.round(performance.now() - startTime);
                        Logger('API', `[DONE] GraphQL запрос (AniList) выполнен за ${timeTaken}ms`);
                        resolve(JSON.parse(res.responseText));
                    } else if (res.status === 429) {
                        const match = res.responseHeaders?.match(/retry-after:\s*(\d+)/i);
                        const waitTime = match ? parseInt(match[1]) * 1000 : 5000;
                        alRateLimitPause = Date.now() + waitTime + 500;
                        Logger('ERROR', `AniList Rate Limit 429! Ожидание ${waitTime}ms`, res);
                        // Повтор после паузы (429)
                        setTimeout(() => resolve(anilistQuery(query, variables, useAuth)), waitTime + 500 + Math.floor(Math.random() * 500));
                    } else {
                        Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.responseText);
                        reject(`Error ${res.status}`);
                    }
                },
                onerror: (e) => {
                    Logger('ERROR', 'AniList Network Error', e);
                    reject(e);
                }
            });
        });
    }

    // Запрос к Shikimori (перебор зеркал)
    /**
     * GET к Shikimori REST: перебор зеркал SHIKI_DOMAINS при сбое, ретрай при 429.
     * @param {string} path Путь (например `/api/animes/123`), без домена.
     * @returns {Promise<{data: *, domain: ?string}>} JSON и домен зеркала (data === null при 404/полном сбое).
     */
    async function fetchShiki(path) {
        if (Date.now() < shikiRateLimitPause) {
            await new Promise(r => setTimeout(r, shikiRateLimitPause - Date.now() + Math.floor(Math.random() * 500)));
        }

        Logger('API', `Запрос к Shikimori API: ${path}`);
        let lastNotFound = null;
        for (const domain of SHIKI_DOMAINS) {
            try {
                const res = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: `https://${domain}${path}`,
                        timeout: 5000,
                        onload: (r) => {
                            if (r.status === 200) resolve({ data: JSON.parse(r.responseText), domain });
                            else if (r.status === 429) { shikiRateLimitPause = Date.now() + 5000; resolve({ status: 429 }); }
                            else if (r.status === 404) resolve({ data: null, domain, notFound: true });
                            else reject(r.status);
                        },
                        onerror: reject, ontimeout: reject
                    });
                });

                if (res && res.status === 429) {
                    Logger('ERROR', `Shikimori Rate Limit 429 (${domain})! Пауза.`);
                    await new Promise(r => setTimeout(r, 5000 + Math.floor(Math.random() * 1000)));
                    return fetchShiki(path); // рекурсивный повтор (429)
                }
                // 404: возможно удалён по РКН — пробуем следующее зеркало (напр. .rip).
                if (res && res.notFound) { lastNotFound = { data: null, domain: res.domain }; continue; }
                if (res) return res;
            } catch (e) {
                Logger('ERROR', `Ошибка запроса к зеркалу Shiki: ${domain}`, e);
            }
        }
        return lastNotFound || { data: null, domain: null };
    }

    /**
     * Грузит русский тайтл/описание с anime365 по MAL ID. Только аниме.
     * null при отсутствии/сбое всех зеркал.
     * @param {?number} malId MyAnimeList ID.
     * @param {'ANIME'|'MANGA'} type Тип тайтла AniList.
     * @returns {Promise<?{russian:string, description:string, url:string, domain:string}>}
     */
    async function fetchAnime365ByMal(malId, type) {
        if (!malId || type === 'MANGA') return null; // только аниме
        if (anime365Disabled) return null;           // отключён на сессию
        if (Date.now() < anime365RateLimitPause) {
            await new Promise(r => setTimeout(r, anime365RateLimitPause - Date.now() + Math.floor(Math.random() * 500)));
        }
        Logger('API', `Запрос к anime365 API: myAnimeListId=${malId}`);
        for (const domain of ANIME365_DOMAINS) {
            try {
                const res = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: `https://${domain}/api/series?myAnimeListId=${malId}&limit=1`,
                        timeout: 5000,
                        onload: (r) => {
                            if (r.status === 200) resolve({ ok: true, body: JSON.parse(r.responseText) });
                            else if (r.status === 404) resolve({ ok: true, body: null });
                            else if (r.status === 429) resolve({ __rl: true });
                            // 403/503 + Cloudflare (520–524) — soft-block, не «нет данных».
                            else if ([403, 502, 503, 520, 521, 522, 523, 524].includes(r.status)) resolve({ __block: true, status: r.status });
                            else reject(r.status);
                        },
                        onerror: reject, ontimeout: reject
                    });
                });

                // Пауза между запросами (cache-miss)
                await new Promise(r => setTimeout(r, ANIME365_THROTTLE));

                if (res.__rl) {
                    anime365RateLimitPause = Date.now() + 5000;
                    Logger('WARN', `anime365 Rate Limit 429 (${domain}). Пауза 5с.`);
                    await new Promise(r => setTimeout(r, 5000 + Math.floor(Math.random() * 1000)));
                    return fetchAnime365ByMal(malId, type); // рекурсивный повтор (429)
                }

                if (res.__block) {
                    anime365FailStreak++;
                    anime365RateLimitPause = Date.now() + 15000; // бэкофф
                    Logger('WARN', `anime365 недоступен: HTTP ${res.status} (${domain}). Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}, бэкофф 15с.`);
                    if (anime365FailStreak >= ANIME365_FAIL_LIMIT) {
                        anime365Disabled = true;
                        Logger('ERROR', 'anime365 отключён на эту сессию после серии сбоев — цепочка уходит на фоллбэк/оригинал.');
                    }
                    return null; // → resolveTitle: фоллбэк
                }

                anime365FailStreak = 0; // успех/404 — сброс

                const item = res.body && res.body.data && res.body.data[0];
                if (item) {
                    let desc = '';
                    if (Array.isArray(item.descriptions)) {
                        const d = item.descriptions.find(x => x && x.value);
                        if (d) desc = d.value;
                    }
                    return {
                        russian: (item.titles && item.titles.ru) || '',
                        description: desc,
                        url: item.url || `https://${domain}/`,
                        domain
                    };
                }
                return null; // 200, но пусто
            } catch (e) {
                anime365FailStreak++;
                Logger('WARN', `Сбой запроса к зеркалу anime365: ${domain} (${e}). Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}.`);
                if (anime365FailStreak >= ANIME365_FAIL_LIMIT) {
                    anime365Disabled = true;
                    anime365RateLimitPause = Date.now() + 15000;
                    Logger('ERROR', 'anime365 отключён на эту сессию после серии сбоев — цепочка уходит на фоллбэк/оригинал.');
                }
            }
        }
        return null;
    }

    /**
     * Резолвит русский тайтл/описание по цепочке источников (основной → фоллбэк), пропуская 'off'/'none' и дубли.
     * @param {?number} malId MyAnimeList ID.
     * @param {'ANIME'|'MANGA'} type Тип тайтла AniList.
     * @returns {Promise<?{russian:string, description:?string, url:string, sourceName:string}>}
     */
    async function resolveTitle(malId, type) {
        const order = [...new Set([settings.titlePrimary, settings.titleFallback])]
            .filter(src => src && src !== 'off' && src !== 'none');
        for (const src of order) {
            if (src === 'shikimori') {
                const shiki = await fetchShiki(`/api/${type === 'MANGA' ? 'mangas' : 'animes'}/${malId}`);
                if (shiki.data && shiki.data.russian) {
                    return { russian: shiki.data.russian, description: shiki.data.description, url: `https://${shiki.domain}${shiki.data.url}`, sourceName: 'Shikimori' };
                }
            } else if (src === 'anime365') {
                const a = await fetchAnime365ByMal(malId, type);
                if (a && a.russian) {
                    return { russian: a.russian, description: a.description, url: a.url, sourceName: 'anime365' };
                }
            }
        }
        return null;
    }

    // Муз. темы (AnimeThemes API)
    /**
     * Грузит опенинги/эндинги с AnimeThemes.moe (кэш shikiCache `THEMES_<malId>`).
     * @param {?number} malId MyAnimeList ID аниме.
     * @returns {Promise<?{openings: Array<{seq:string,title:string,artist:string}>, endings: Array<{seq:string,title:string,artist:string}>}>} Списки тем с исполнителем, либо null при отсутствии malId/ошибке.
     */
    async function fetchMalThemes(malId) {
        if (!malId) return null;
        const cacheKey = `THEMES2_${malId}`;
        const cached = await dbGet('shikiCache', cacheKey);
        if (cached && (Date.now() - cached.ts < CACHE_TIME)) return cached.data;

        Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`);
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://api.animethemes.moe/anime?filter[has]=resources&filter[site]=MyAnimeList&filter[external_id]=${malId}&include=animethemes.song.artists`,
                onload: (res) => {
                    if (res.status === 200) {
                        try {
                            const data = JSON.parse(res.responseText);
                            const animeList = data.anime || [];

                            // Не найдено — пустые массивы.
                            if (animeList.length === 0) {
                                const emptyData = { openings: [], endings: [] };
                                dbSet('shikiCache', { key: cacheKey, data: emptyData, ts: Date.now() });
                                return resolve(emptyData);
                            }

                            const themes = animeList[0].animethemes || [];
                            const formattedData = { openings: [], endings: [] };

                            themes.forEach(t => {
                                const song = t.song || {};
                                const title = song.title || t.slug;
                                const artist = (song.artists || []).map(a => a.name).filter(Boolean).join(', ');
                                const seq = t.slug.replace(/[^0-9]/g, '') || '1';
                                const item = { seq, title, artist };

                                if (t.type === 'OP') formattedData.openings.push(item);
                                else if (t.type === 'ED') formattedData.endings.push(item);
                            });

                            dbSet('shikiCache', { key: cacheKey, data: formattedData, ts: Date.now() });
                            resolve(formattedData);
                        } catch (e) {
                            Logger('ERROR', 'Ошибка парсинга AnimeThemes', e);
                            resolve(null);
                        }
                    } else if (res.status === 429) {
                        Logger('ERROR', 'AnimeThemes Rate Limit 429! Повторная попытка...');
                        setTimeout(() => resolve(fetchMalThemes(malId)), 1500 + Math.floor(Math.random() * 500));
                    } else {
                        Logger('ERROR', `AnimeThemes Error HTTP ${res.status}`);
                        resolve(null);
                    }
                },
                onerror: (e) => {
                    Logger('ERROR', 'AnimeThemes Network Error', e);
                    resolve(null);
                }
            });
        });
    }

    // Поиск персоны (сейю/персонал) на Shikimori
    /**
     * Ищет персону на Shikimori: REST search (прямой + реверс) → GraphQL fallback → детали.
     * @param {string} endpointStr REST/GraphQL эндпоинт Shikimori ('people' и т.п.).
     * @param {string} searchName Имя для поиска (обычно ромадзи из AniList).
     * @param {string} [nativeName] Оригинальное имя (для сверки по japanese-полю).
     * @returns {Promise<{status: number, data: ?{id:number, russian:?string, description:?string, url?:string, domain?:string}}>}
     *          HTTP-подобный статус (200/404/429) и найденные данные персоны либо null.
     */
    // ==========================================
    // Единый скоринговый матчер имён (Shikimori <-> AniList)
    // ==========================================
    function amNormRomaji(str) {
        if (!str) return '';
        return str.toLowerCase()
            .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .replace(/['\u2019\u02bc`]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }
    function amCollapseVowels(str) {
        return str.replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u').replace(/aa/g, 'a').replace(/ee/g, 'e').replace(/ii/g, 'i');
    }
    function amTokens(str) { return amNormRomaji(str).split(' ').filter(Boolean); }
    function amNormNative(str) { return (str || '').replace(/\s+/g, '').trim(); }

    /**
     * Оценивает уверенность совпадения кандидата Shikimori с целью AniList (балл).
     * @param {{name?:string, russian?:string, japanese?:string}} cand Кандидат Shikimori.
     * @param {{full?:string, native?:string}} target Цель AniList.
     * @returns {number} Балл 0..100 (100 = точный кандзи, 80+ = точный ромадзи).
     */
    function scoreNameMatch(cand, target) {
        const tNative = amNormNative(target.native);
        const cNative = amNormNative(cand.japanese);
        if (tNative && cNative) {
            if (tNative === cNative) return 100;
            if (cNative.includes(tNative) || tNative.includes(cNative)) return 90;
        }
        const tTok = amTokens(target.full);
        const cTok = amTokens(cand.name);
        if (tTok.length && cTok.length) {
            const tSet = [...tTok].sort().join(' ');
            const cSet = [...cTok].sort().join(' ');
            if (tSet === cSet) return 85;
            if (amCollapseVowels(tSet) === amCollapseVowels(cSet)) return 80;
            const tS = new Set(tTok.map(amCollapseVowels));
            const cS = new Set(cTok.map(amCollapseVowels));
            const small = tS.size <= cS.size ? tS : cS;
            const big   = tS.size <= cS.size ? cS : tS;
            let all = true; for (const x of small) if (!big.has(x)) { all = false; break; }
            if (all && small.size >= 2 && small.size >= big.size - 1) return 55;
            const tJoin = amCollapseVowels(tTok.join(''));
            const cJoin = amCollapseVowels(cTok.join(''));
            if (tJoin.length >= 5 && cJoin.length >= 5 && (cJoin.includes(tJoin) || tJoin.includes(cJoin))) return 30;
        }
        return 0;
    }

    async function fetchShikiPersonREST(endpointStr, searchName, nativeName, targetMalIds = []) {
        if (!searchName) return { status: 404, data: null };
        let cleanStr = searchName.replace(/_/g, ' ').replace(/-/g, ' ').trim();
        let nameParts = cleanStr.split(' ');
        let reversedName = nameParts.length > 1 ? [...nameParts].reverse().join(' ') : cleanStr;
        let finalStatus = 404;
        const target = { full: cleanStr, native: nativeName };

        Logger('API', `Поиск персоны на Shiki: ${cleanStr}`);
        for (const domain of SHIKI_DOMAINS) {
            try {
                let fetchMatch = async (url) => {
                    let r = await new Promise(resolve => GM_xmlhttpRequest({ method: "GET", url, onload: resolve, onerror: () => resolve({status: 0}) }));
                    if (r.status === 429) throw { status: 429 };
                    if (r.status === 200) {
                        try {
                            let res = JSON.parse(r.responseText);
                            if (res && res.length > 0) {
                                let best = null, bestScore = 0;
                                for (let c of res) {
                                    let sc = scoreNameMatch(c, target);
                                    if (sc > bestScore) { bestScore = sc; best = c; }
                                }
                                if (best && bestScore >= 80) return { cand: best, score: bestScore };
                            }
                        } catch(e) { Logger('ERROR', 'Ошибка парсинга персоны Shiki', e); }
                    }
                    return null;
                };

                let item = null, itemScore = 0;
                const searchUrls = [
                    `https://${domain}/api/${endpointStr}/search?search=${encodeURIComponent(cleanStr)}`,
                    ...(nameParts.length > 1 ? [`https://${domain}/api/${endpointStr}/search?search=${encodeURIComponent(reversedName)}`] : []),
                    `https://${domain}/api/${endpointStr}?search=${encodeURIComponent(cleanStr)}`
                ];
                for (const url of searchUrls) {
                    let m = await fetchMatch(url);
                    if (m && m.score > itemScore) { item = m.cand; itemScore = m.score; }
                    if (itemScore >= 100) break;
                }

                if (!item) {
                    const gqlQuery = `query($search: String) { ${endpointStr}(search: $search, limit: 5) { id name russian japanese } }`;
                    let r = await new Promise(resolve => GM_xmlhttpRequest({
                        method: "POST", url: `https://${domain}/api/graphql`,
                        headers: { "Content-Type": "application/json", "Accept": "application/json" },
                        data: JSON.stringify({ query: gqlQuery, variables: { search: cleanStr } }),
                        onload: resolve, onerror: () => resolve({status: 0})
                    }));
                    if (r.status === 429) return { status: 429 };
                    if (r.status === 200) {
                        try {
                            let res = JSON.parse(r.responseText);
                            let list = res.data && res.data[endpointStr] ? res.data[endpointStr] : [];
                            let best = null, bestScore = 0;
                            for (let c of list) {
                                let sc = scoreNameMatch(c, target);
                                if (sc > bestScore) { bestScore = sc; best = c; }
                            }
                            if (best && bestScore >= 80) { item = best; itemScore = bestScore; }
                        } catch(e) { Logger('ERROR', 'Ошибка парсинга GraphQL Shiki', e); }
                    }
                }

                if (item && item.id) {
                    let rDetails = await new Promise(resolve => GM_xmlhttpRequest({ method: "GET", url: `https://${domain}/api/${endpointStr}/${item.id}`, onload: resolve, onerror: () => resolve({status: 0}) }));
                    if (rDetails.status === 429) return { status: 429 };
                    let detailsRes = null;
                    if (rDetails.status === 200) { try { detailsRes = JSON.parse(rDetails.responseText); } catch(e) { Logger('ERROR', 'Ошибка парсинга деталей персоны Shiki', e); } }

                    // Гард тёзок: при неточном (не-кандзи, score < 90) — требуем пересечение по тайтлам
                    if (targetMalIds && targetMalIds.length && itemScore < 90 && detailsRes) {
                        let candMal = [];
                        if (Array.isArray(detailsRes.animes)) detailsRes.animes.forEach(a => a && a.id && candMal.push(a.id));
                        if (Array.isArray(detailsRes.mangas)) detailsRes.mangas.forEach(a => a && a.id && candMal.push(a.id));
                        if (Array.isArray(detailsRes.works))  detailsRes.works.forEach(w => w && w.anime && w.anime.id && candMal.push(w.anime.id));
                        if (Array.isArray(detailsRes.roles))  detailsRes.roles.forEach(rr => (rr.animes || []).forEach(a => a && a.id && candMal.push(a.id)));
                        if (candMal.length && !candMal.some(id => targetMalIds.includes(id))) {
                            Logger('API', `Отклонён вероятный тёзка: ${cleanStr} (нет общих тайтлов, score=${itemScore})`);
                            return { status: 404, data: null };
                        }
                    }

                    if (detailsRes) {
                        return { status: 200, data: { id: detailsRes.id || item.id, russian: detailsRes.russian || item.russian, description: detailsRes.description, url: detailsRes.url, domain } };
                    } else {
                        return { status: 200, data: { id: item.id, russian: item.russian, description: null, domain } };
                    }
                }
            } catch (e) {
                if (e.status === 429) return { status: 429 };
                Logger('ERROR', `Сбой fetchShikiPersonREST для "${cleanStr}" (${domain})`, e);
            }
        }
        Logger('API', `Персона не найдена: ${cleanStr}`);
        return { status: finalStatus, data: null };
    }

    /**
     * Резолвит персонажа/персону Shikimori через роли в общих тайтлах (по MAL id),
     * когда прямой поиск по имени не сработал.
     * @param {{name: {full?: string}, media?: {nodes: Array<{idMal:?number}>}, staffMedia?: {nodes: Array<{idMal:?number}>}}} personData Данные персоны из AniList (character/staff) с медиа-связями.
     * @param {'characters'|'staff'} type Тип персоны (определяет, какое поле связей использовать: media/staffMedia).
     * @returns {Promise<?Object>} Найденная запись персонажа/человека Shikimori (сырой объект из /api/animes/:id/roles), либо null.
     */
    async function resolveShikiPersonByMedia(personData, type) {
        let mediaNodes = (type === 'characters' ? personData.media : personData.staffMedia)?.nodes ||[];
        let mediaRefs = mediaNodes.filter(m => m.idMal).map(m => ({ id: m.idMal, kind: m.type === 'MANGA' ? 'mangas' : 'animes' }));
        if (mediaRefs.length === 0) return null;

        const target = { full: personData.name.full || '', native: personData.name.native || '' };
        let best = null, bestScore = 0;

        for (let ref of mediaRefs) {
            let rolesRes = await fetchShiki(`/api/${ref.kind}/${ref.id}/roles`);
            if (rolesRes.data) {
                let items = rolesRes.data.map(r => type === 'characters' ? r.character : r.person).filter(x => x);
                for (let c of items) {
                    let sc = scoreNameMatch(c, target);
                    if (sc > bestScore) { bestScore = sc; best = c; }
                    if (bestScore >= 100) break;
                }
            }
            if (bestScore >= 100) break;
        }
        // Кандидаты ограничены тайтлом → порог мягче, но ложные подстроки (score 30) отсекаем.
        return bestScore >= 55 ? best : null;
    }

    // ==========================================
    // 4. ЭКСПОРТЕР СПИСКА (Shikimori -> AniList)
    // ==========================================
    function initExporter() {
        Logger('INFO', 'Инициализация модуля Экспортера');
        const mapStatusShikiToAL = { 'planned': 'PLANNING', 'watching': 'CURRENT', 'reading': 'CURRENT', 'completed': 'COMPLETED', 'on_hold': 'PAUSED', 'dropped': 'DROPPED', 'rewatching': 'REPEATING', 'rereading': 'REPEATING' };

        function convertScoreShikiToAL(score, format) {
            if (!score) return 0;
            switch (format) {
                case 'POINT_100': case 'POINT_10_DECIMAL': return score * 10;
                case 'POINT_10': return score;
                case 'POINT_5': return Math.round(score / 2);
                case 'POINT_3': return score >= 8 ? 3 : (score >= 5 ? 2 : 1);
                default: return score;
            }
        }

        function fuzzyEquals(fd1, fd2) {
            const empty1 = !fd1 || (!fd1.year && !fd1.month && !fd1.day);
            const empty2 = !fd2 || (!fd2.year && !fd2.month && !fd2.day);
            if (empty1 && empty2) return true;
            if (empty1 || empty2) return false;
            return fd1.year === fd2.year && fd1.month === fd2.month && fd1.day === fd2.day;
        }

        function makeFuzzyDate(d) {
            if (!d) return undefined;
            const date = new Date(d);
            if (isNaN(date.getTime())) return undefined;
            return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
        }

        async function fetchShikiUserId(username) {
            const res = await fetch(`${window.location.origin}/api/users/${username}`);
            if (!res.ok) throw new Error("Пользователь Shikimori не найден.");
            return (await res.json()).id;
        }

        async function fetchShikimoriListV2(userId, type) {
            let page = 1; let all =[]; let seen = new Set();
            const targetType = type === 'anime' ? 'Anime' : 'Manga';
            Logger('INFO', `Скачивание списка ${type} с Shikimori v2...`);

            while (true) {
                const url = `${window.location.origin}/api/v2/user_rates?user_id=${userId}&target_type=${targetType}&limit=1000&page=${page}`;
                const res = await fetch(url);
                if (!res.ok) {
                    if (res.status === 404) break;
                    if (res.status === 403) throw new Error("Профиль скрыт.");
                    break;
                }
                const data = await res.json();
                if (!data || data.length === 0) break;

                let added = 0;
                for (let item of data) {
                    if (!seen.has(item.id)) { seen.add(item.id); all.push(item); added++; }
                }
                if (added === 0) break;
                page++; await new Promise(r => setTimeout(r, 500));
            }
            return all;
        }

        // Парсинг истории активности (даты)
        async function fetchShikiHistoryDates(userId, btn) {
            let page = 1; const datesMap = {};
            while (true) {
                if (btn) btn.textContent = `Анализ таймингов (стр. ${page})...`;
                try {
                    const res = await fetch(`${window.location.origin}/api/users/${userId}/history?limit=100&page=${page}`);
                    if (!res.ok) {
                        if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
                        break;
                    }
                    const data = await res.json();
                    if (!data || data.length === 0) break;

                    data.forEach(item => {
                        if (!item.target) return;
                        const id = item.target.id;
                        const dateObj = new Date(item.created_at);
                        const desc = (item.description || "").toLowerCase();

                        if (!datesMap[id]) datesMap[id] = { starts: [], ends:[] };
                        if (desc === 'просмотрено' || desc === 'прочитано' || desc === 'пересмотрено' || desc === 'перечитано') {
                            datesMap[id].ends.push(dateObj.getTime());
                        } else if (desc.includes('смотрю') || desc.includes('читаю') || desc.includes('просмотрен') || desc.includes('прочитан') || desc.includes('эпизод') || desc.includes('глав') || desc.includes('пересматр') || desc.includes('перечитыв')) {
                            datesMap[id].starts.push(dateObj.getTime());
                        }
                    });

                    if (data.length < 100) break;
                    page++; await new Promise(r => setTimeout(r, 350));
                } catch(e) { Logger('ERROR', `fetchShikiHistoryDates: сбой на странице ${page}, обработка прервана`, e); break; }
            }

            const finalMap = {};
            for (const id in datesMap) {
                const starts = datesMap[id].starts; const ends = datesMap[id].ends;
                let start = starts.length > 0 ? new Date(Math.min(...starts)) : null;
                let end = ends.length > 0 ? new Date(Math.max(...ends)) : null;
                finalMap[id] = { start, end };
            }
            return finalMap;
        }

        async function fetchShikimoriFavorites(usernameOrId) {
            const endpoints =[`/api/users/${usernameOrId}/favorites`, `/api/users/${usernameOrId}/favourites`];
            for (const ep of endpoints) {
                try { const res = await fetch(window.location.origin + ep); if (res.ok) return await res.json(); } catch(e) { Logger('WARN', `fetchShikimoriFavorites: сбой запроса ${ep}`, e); }
            }
            return null;
        }

        // Пакетный маппинг MAL -> AniList
        async function getAnilistIds(malIds, type) {
            if (!malIds || malIds.length === 0) return {};
            const map = {};
            for (let i = 0; i < malIds.length; i += 50) {
                const chunk = malIds.slice(i, i + 50);
                const query = `query($m:[Int],$t:MediaType){Page(page:1,perPage:50){media(idMal_in:$m,type:$t){id idMal}}}`;
                const res = await anilistQuery(query, { m: chunk, t: type });
                if (res?.data?.Page?.media) res.data.Page.media.forEach(m => map[m.idMal] = m.id);
                await new Promise(r => setTimeout(r, 700));
            }
            return map;
        }

        // Список AniList для сверки
        async function getExistingAnilistList(alUserId, type, btn) {
            const map = {};
            if (btn) btn.textContent = `Загрузка AL списка (${type})...`;
            const query = `query($u:Int!,$t:MediaType){MediaListCollection(userId:$u,type:$t){lists{entries{mediaId status score progress progressVolumes repeat notes startedAt { year month day } completedAt { year month day }}}}}`;
            const res = await anilistQuery(query, {u: alUserId, t: type});
            const lists = res?.data?.MediaListCollection?.lists ||[];
            lists.forEach(list => list.entries.forEach(m => map[m.mediaId] = m));
            await new Promise(r => setTimeout(r, 600));
            return map;
        }

        async function getExistingAnilistFavorites(alUserId, btn) {
            const existing = { anime: new Set(), manga: new Set(), characters: new Set(), staff: new Set() };
            const fetchFav = async (type, targetSet) => {
                let page = 1; let hasNextPage = true;
                if (btn) btn.textContent = `Загрузка Fav AL (${type})...`;
                while (hasNextPage) {
                    const query = `query($u:Int!,$p:Int!){User(id:$u){favourites{${type}(page:$p){pageInfo{hasNextPage}nodes{id}}}}}`;
                    const res = await anilistQuery(query, {u: alUserId, p: page});
                    const data = res?.data?.User?.favourites[type];
                    if (!data) break;
                    data.nodes.forEach(n => targetSet.add(n.id));
                    hasNextPage = data.pageInfo.hasNextPage;
                    page++; await new Promise(r => setTimeout(r, 600));
                }
            };
            await fetchFav('anime', existing.anime); await fetchFav('manga', existing.manga);
            await fetchFav('characters', existing.characters); await fetchFav('staff', existing.staff);
            return existing;
        }

        async function getAnilistIdByName(name, type) {
            const field = type === 'CHARACTER' ? 'characters' : 'staff';
            const query = `query($s:String){Page(page:1,perPage:1){${field}(search:$s){id}}}`;
            try {
                const res = await anilistQuery(query, { s: name });
                if (res?.data?.Page[field]?.length > 0) return res.data.Page[field][0].id;
            } catch(e) { Logger('WARN', `getAnilistIdByName: сбой поиска "${name}" (${type})`, e); }
            return null;
        }

        // Синхронизация списка
        async function syncShikiToAlList(shikiItems, type, alUser, historyDates, btn) {
            if (!shikiItems || shikiItems.length === 0) return;
            const alType = type === 'anime' ? 'ANIME' : 'MANGA';
            const valids = shikiItems.filter(i => i && i.target_id);
            if (valids.length === 0) return;

            if (btn) btn.textContent = `Сверка ID (${type})...`;
            const idMap = await getAnilistIds(valids.map(i => i.target_id), alType);
            const exList = await getExistingAnilistList(alUser.id, alType, btn);

            let count = 0;
            for (const item of valids) {
                count++;
                if (btn) btn.textContent = `Shiki ➜ AL (${type}): ${count}/${valids.length}`;

                const alId = idMap[item.target_id];
                if (!alId) { if (count % 50 === 0) await new Promise(r => setTimeout(r, 10)); continue; }

                const status = mapStatusShikiToAL[item.status] || 'PLANNING';
                const scoreRaw = convertScoreShikiToAL(item.score, alUser.mediaListOptions.scoreFormat);
                const progress = (type === 'anime' ? item.episodes : item.chapters) || 0;
                const progressVolumes = (type === 'manga' ? item.volumes : 0) || 0;
                const repeat = item.rewatches || 0;

                let notes = item.text && item.text.trim().length > 0 ? item.text.trim() : undefined;
                if (notes) {
                    // BB-коды заметок → Markdown
                    notes = notes.replace(/\[b\](.*?)\[\/b\]/gi, '**$1**').replace(/\[i\](.*?)\[\/i\]/gi, '*$1*')
                                 .replace(/\[s\](.*?)\[\/s\]/gi, '~~$1~~').replace(/\[spoiler(?:=[^\]]+)?\]([\s\S]*?)\[\/spoiler\]/gi, '~!$1!~')
                                 .replace(/\[url=(.+?)\](.*?)\[\/url\]/gi, '[$2]($1)');
                }

                let startedAt = undefined; let completedAt = undefined;
                if (historyDates && historyDates[item.target_id]) {
                    if (historyDates[item.target_id].start) startedAt = makeFuzzyDate(historyDates[item.target_id].start);
                    if (historyDates[item.target_id].end) completedAt = makeFuzzyDate(historyDates[item.target_id].end);
                }
                if (!startedAt && item.status !== 'planned' && item.created_at) startedAt = makeFuzzyDate(item.created_at);
                if (!completedAt && item.status === 'completed' && item.updated_at) completedAt = makeFuzzyDate(item.updated_at);

                const ex = exList[alId];
                if (ex) {
                    let alRawScore = Math.round(ex.score || 0);
                    if (alUser.mediaListOptions.scoreFormat === 'POINT_10_DECIMAL') alRawScore = Math.round((ex.score || 0) * 10);
                    let isSame = ex.status === status && alRawScore === scoreRaw && (ex.progress || 0) === progress &&
                                 (ex.repeat || 0) === repeat && fuzzyEquals(ex.startedAt, startedAt) && fuzzyEquals(ex.completedAt, completedAt);
                    if (type === 'manga') isSame = isSame && (ex.progressVolumes || 0) === progressVolumes;
                    if (notes !== undefined) isSame = isSame && (ex.notes ? ex.notes.trim() : undefined) === notes;

                    // Идентично — пропуск
                    if (isSame) { if (count % 50 === 0) await new Promise(r => setTimeout(r, 10)); continue; }
                }

                const variables = { mediaId: alId, status, scoreRaw, progress, repeat };
                if (type === 'manga' && progressVolumes > 0) variables.progressVolumes = progressVolumes;
                if (notes !== undefined) variables.notes = notes;
                if (startedAt) variables.startedAt = startedAt;
                if (completedAt) variables.completedAt = completedAt;

                const mutationVars = []; const mutationArgs =[];
                for (const key of Object.keys(variables)) {
                    const typeStr = key === 'status' ? 'MediaListStatus' : key === 'notes' ? 'String' : (key === 'startedAt' || key === 'completedAt') ? 'FuzzyDateInput' : 'Int';
                    mutationVars.push(`$${key}:${typeStr}`); mutationArgs.push(`${key}:$${key}`);
                }
                const mutation = `mutation(${mutationVars.join(',')}){SaveMediaListEntry(${mutationArgs.join(',')}){id}}`;

                try { await anilistQuery(mutation, variables, true); } catch(e) { Logger('ERROR', `syncShikiToAlList: сбой SaveMediaListEntry (mediaId=${alId}, ${type})`, e); }
                await new Promise(r => setTimeout(r, 700)); // лимит 90/мин
            }
        }

        async function syncShikiToAlFavorites(shikiFavs, exAlFavs, btn) {
            if (!shikiFavs) return;
            const processFavorites = async (arr, alType, exSet, varName) => {
                if (!arr || arr.length === 0) return;
                let processedCount = 0;
                const field = alType === 'ANIME' ? 'anime' : alType === 'MANGA' ? 'manga' : alType === 'CHARACTER' ? 'characters' : 'staff';
                const mutation = `mutation($id:Int!){ToggleFavourite(${varName}:$id){${field}{pageInfo{total}}}}`;

                if (['ANIME', 'MANGA'].includes(alType)) {
                    if (btn) btn.textContent = `Сверка ID (Fav ${alType})...`;
                    const idMap = await getAnilistIds(arr.map(x => x.id), alType);
                    for (const item of arr) {
                        processedCount++;
                        if (btn) btn.textContent = `Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`;
                        const alId = idMap[item.id];
                        if (!alId || exSet.has(alId)) { if (processedCount % 50 === 0) await new Promise(r => setTimeout(r, 10)); continue; }
                        try { await anilistQuery(mutation, { id: alId }, true); } catch(e) { Logger('ERROR', `syncShikiToAlFavorites: сбой ToggleFavourite (id=${alId}, ${alType})`, e); }
                        await new Promise(r => setTimeout(r, 700));
                    }
                } else {
                    for (const item of arr) {
                        processedCount++;
                        if (btn) btn.textContent = `Shiki ➜ AL (Fav ${alType}): ${processedCount}/${arr.length}`;
                        const alId = await getAnilistIdByName(item.name, alType);
                        if (!alId || exSet.has(alId)) { await new Promise(r => setTimeout(r, 600)); continue; }
                        try { await anilistQuery(mutation, { id: alId }, true); } catch(e) { Logger('ERROR', `syncShikiToAlFavorites: сбой ToggleFavourite по имени (id=${alId}, ${alType})`, e); }
                        await new Promise(r => setTimeout(r, 700));
                    }
                }
            };
            const shikiStaff =[...(shikiFavs.people || []), ...(shikiFavs.seyu || []), ...(shikiFavs.mangakas ||[])];
            const uniqStaff = Array.from(new Map(shikiStaff.map(i =>[i.id, i])).values());
            await processFavorites(shikiFavs.animes, 'ANIME', exAlFavs.anime, 'animeId');
            await processFavorites(shikiFavs.mangas, 'MANGA', exAlFavs.manga, 'mangaId');
            await processFavorites(shikiFavs.characters, 'CHARACTER', exAlFavs.characters, 'characterId');
            await processFavorites(uniqStaff, 'STAFF', exAlFavs.staff, 'staffId');
        }

        // На Shikimori нет --color-* AniList → выводим из реальных цветов страницы (фон/текст)
        // под светлую/тёмную тему Shiki. Акцент/статусы фиксированы.
        function amkShikiTokens(el) {
            const triple = (c, fb) => { const m = (c || '').match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/); return m ? `${m[1]} ${m[2]} ${m[3]}` : fb; };
            let bg = getComputedStyle(document.body).backgroundColor;
            if (!bg || bg === 'transparent' || bg.replace(/\s/g, '').includes('rgba(0,0,0,0)')) bg = getComputedStyle(document.documentElement).backgroundColor;
            const bgT = triple(bg, '18 18 28');
            const txT = triple(getComputedStyle(document.body).color, '226 232 240');
            const vars = { '--color-foreground': bgT, '--color-background': bgT, '--color-background-100': bgT, '--color-background-200': bgT, '--color-background-300': bgT, '--color-text': txT, '--color-text-light': txT, '--color-blue': '61 187 238', '--color-pink': '243 139 168', '--color-red': '252 129 129', '--color-green': '166 227 161', '--color-orange': '246 193 119', '--color-purple': '183 148 244' };
            for (const k in vars) el.style.setProperty(k, vars[k]);
        }

        async function openExportModal(btn) {
            if (document.getElementById('shiki-export-overlay')) return;
            const urlPath = window.location.pathname.split('/');
            const dUser = (urlPath.length > 1 && !['animes', 'mangas', 'forum'].includes(urlPath[1])) ? urlPath[1] : "";
            const tok = GM_getValue("AL_TOKEN", "");

            const sw = (id, on = true) => `<label class="amk-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="amk-track"></span><span class="amk-thumb"></span></label>`;
            const overlayTemplate = `
                <div id="shiki-export-overlay" class="amk-overlay" style="display:flex;">
                    <div class="amk-modal" style="width:500px;">
                        <div class="amk-head">
                            <h2 class="amk-title"><span class="amk-dot"></span><span style="color:rgb(var(--color-pink));">Shikimori</span>&nbsp;➜&nbsp;<span style="color:rgb(var(--color-blue));">AniList</span> <span class="amk-sub">экспорт</span></h2>
                            <button class="amk-close" id="se-close" title="Закрыть">✕</button>
                        </div>
                        <div class="amk-body">
                            <div style="display:flex;gap:10px;">
                                <input class="amk-input" id="se-user" placeholder="Логин Shikimori" style="flex:1;width:auto;">
                                <input class="amk-input amk-mono" type="password" id="se-token" placeholder="Токен AniList" style="flex:1;width:auto;">
                            </div>
                            <div class="amk-card">
                                <div class="amk-card-title">Что переносить</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Аниме</b></span>${sw('se-anime')}</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Манга</b></span>${sw('se-manga')}</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Избранное</b></span>${sw('se-favs')}</div>
                                <div class="amk-row"><span class="amk-row-label"><b>Точные даты просмотров</b><span class="amk-row-hint">из истории Shikimori (медленнее)</span></span>${sw('se-dates')}</div>
                            </div>
                            <div class="amk-card">
                                <div class="amk-card-title">Токен AniList</div>
                                <div class="amk-row-hint" style="padding:8px 2px 6px;">Создайте Client <a href="https://anilist.co/settings/developer" target="_blank" style="color:rgb(var(--color-blue));text-decoration:none;">здесь</a>, redirect URL: <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;">https://anilist.co/api/v2/oauth/pin</code></div>
                                <div style="display:flex;gap:8px;">
                                    <input class="amk-input amk-mono" id="se-gen-client" placeholder="Client ID" style="flex:1;width:auto;">
                                    <button class="amk-btn amk-btn-ghost" id="se-gen-btn">Создать URL</button>
                                </div>
                                <div id="se-gen-url" style="margin-top:10px;text-align:center;font-size:12px;"></div>
                            </div>
                        </div>
                        <div class="amk-foot">
                            <button class="amk-btn amk-btn-primary amk-btn-block" id="se-start">Запуск</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', overlayTemplate);
            document.getElementById('se-user').value = dUser;
            document.getElementById('se-token').value = tok;

            const overlay = document.getElementById('shiki-export-overlay');
            amkShikiTokens(overlay);
            document.getElementById('se-close').onclick = () => overlay.remove();
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

            document.getElementById('se-gen-btn').onclick = () => {
                const cid = document.getElementById('se-gen-client').value.trim();
                if (!cid) return alert("Введите Client ID");
                const authLink = document.createElement('a');
                authLink.href = `https://anilist.co/api/v2/oauth/authorize?client_id=${cid}&response_type=token`;
                authLink.target = "_blank";
                authLink.style.cssText = "color:rgb(var(--color-blue));text-decoration:none;font-weight:700;display:inline-block;padding:6px 12px;border:1px solid rgb(var(--color-blue));border-radius:6px;";
                authLink.textContent = "👉 Клик для авторизации";
                document.getElementById('se-gen-url').innerHTML = '';
                document.getElementById('se-gen-url').appendChild(authLink);
            };

            document.getElementById('se-start').onclick = async () => {
                const user = document.getElementById('se-user').value.trim();
                const token = document.getElementById('se-token').value.trim();
                const exportAnime = document.getElementById('se-anime').checked;
                const exportManga = document.getElementById('se-manga').checked;
                const exportFavs = document.getElementById('se-favs').checked;
                const exportDates = document.getElementById('se-dates').checked;

                if (!user || !token) return alert("Заполните логин и токен!");
                if (!exportAnime && !exportManga && !exportFavs) return alert("Выберите опции для экспорта!");

                GM_setValue("AL_TOKEN", token);
                document.getElementById('se-token').value = "";
                document.getElementById('shiki-export-overlay').remove();
                btn.disabled = true;

                try {
                    btn.textContent = "Соединение с AniList...";
                    const res = await anilistQuery(`query{Viewer{id name mediaListOptions{scoreFormat}}}`, {}, true);
                    const alUser = res.data.Viewer;

                    btn.textContent = "Поиск профиля Shiki...";
                    const shikiId = await fetchShikiUserId(user);

                    if (!confirm(`Начать перенос Shikimori ➜ AniList для профиля '${alUser.name}'?\n\nВнимание: Экспорт может занять некоторое время.`)) return;

                    let historyDates = null;
                    if (exportDates && (exportAnime || exportManga)) historyDates = await fetchShikiHistoryDates(shikiId, btn);
                    if (exportAnime) {
                        const animeList = await fetchShikimoriListV2(shikiId, 'anime');
                        await syncShikiToAlList(animeList, 'anime', alUser, historyDates, btn);
                    }
                    if (exportManga) {
                        const mangaList = await fetchShikimoriListV2(shikiId, 'manga');
                        await syncShikiToAlList(mangaList, 'manga', alUser, historyDates, btn);
                    }
                    if (exportFavs) {
                        const exFavs = await getExistingAnilistFavorites(alUser.id, btn);
                        const shikiFavs = await fetchShikimoriFavorites(user);
                        await syncShikiToAlFavorites(shikiFavs, exFavs, btn);
                    }
                    alert("Экспорт успешно завершен!");
                } catch (e) {
                    Logger('ERROR', 'Экспорт Shikimori → AniList: ошибка выполнения', e);
                    alert("Ошибка: " + (e.message || e));
                } finally {
                    btn.disabled = false;
                    setTimeout(() => btn.textContent = "ЭКСПОРТ", 2000);
                }
            };
        }

        const btn = document.createElement('button');
        btn.textContent = 'Экспорт';
        btn.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:9999;padding:11px 20px;background:rgba(var(--color-foreground),0.8);backdrop-filter:blur(16px) saturate(170%);-webkit-backdrop-filter:blur(16px) saturate(170%);border:1px solid rgba(var(--color-text-light),0.2);color:rgb(var(--color-text));border-radius:12px;cursor:pointer;font-weight:600;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,0.18);transition:border-color .2s, color .2s;letter-spacing:0.3px;';
        amkShikiTokens(btn);
        btn.onmouseover = () => { btn.style.borderColor = 'rgb(var(--color-blue))'; btn.style.color = 'rgb(var(--color-blue))'; };
        btn.onmouseout = () => { btn.style.borderColor = 'rgba(var(--color-text-light),0.2)'; btn.style.color = 'rgb(var(--color-text))'; };
        btn.onclick = () => openExportModal(btn);
        document.body.appendChild(btn);
    }

    // ==========================================
    // 5. ПЕРЕВОД И ИНТЕРФЕЙС (ANILIST)
    // ==========================================
    function initTranslator() {
        Logger('INFO', 'Запуск модуля Translator');

        const queue = new Map();
        const pending = { MED2: new Set(), CHR2: new Map(), STF3: new Map() };
        globalPendingQueues = pending; // для Инспектора

        let isProcessing = false;
        let debounceTimer = null;
        let ensureWidgetsTimer = null;

        function cleanShikiBB(text, url, sourceName = 'Shikimori') {
            if (!text) return "";
            let safeText = escapeHTML(text);
            // bbHtml, не html — не затеняем html``.
            const bbHtml = safeText.replace(/\[i\](.*?)\[\/i\]/gi, '<i>$1</i>').replace(/\[b\](.*?)\[\/b\]/gi, '<b>$1</b>').replace(/\[u\](.*?)\[\/u\]/gi, '<u>$1</u>').replace(/\[\w+=\d+\](.*?)\[\/\w+\]/gi, '$1').replace(/\[\w+(=.*?)?\]/gi, '').replace(/\[\/\w+\]/gi, '').replace(/\n/g, '<br>');
            const safeUrl = escapeHTML(url);
            return bbHtml + `<br><br><small style="opacity:0.75;font-size:0.85em;">Описание предоставлено <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#3dbbee; font-weight:bold;">${escapeHTML(sourceName)}</a></small>`;
        }

        function translateAdvanced(text) {
            if (!settings.translateInterface) return null;
            if (!text) return null;

            const cleanText = text.replace(/\s+/g, ' ').trim();
            if (cleanText.length < 2) return null;
            if (/^[\d\s.,\-:[\]()]+$/.test(cleanText)) return null;

            if (Object.prototype.hasOwnProperty.call(dictionary, cleanText)) return dictionary[cleanText];

            if (cleanText.includes(' · ')) {
                return cleanText.split(' · ').map(p => {
                    return (Object.prototype.hasOwnProperty.call(dictionary, p.trim()) ? dictionary[p.trim()] : null) || translateAdvanced(p.trim()) || p.trim();
                }).join(' · ');
            }

            let match;
            if ((match = cleanText.match(rxRole))) {
                let roleTr = (Object.prototype.hasOwnProperty.call(dictionary, match[1].trim()) ? dictionary[match[1].trim()] : null) || match[1].trim();
                let episodes = match[2].trim().replace(rxRoleEps, 'сер.').replace(rxRoleOP, 'OP').replace(rxRoleED, 'ED');
                return `${roleTr} (${episodes})`;
            }

            if ((match = cleanText.match(rxRanking))) {
                const rank = match[1];
                const type = match[2].toLowerCase() === 'highest rated' ? 'в рейтинге' : 'популярности';
                let time = match[3].toLowerCase();
                if (time === 'all time') {
                    time = 'за всё время';
                } else {
                    const seasonMatch = time.match(/^(winter|spring|summer|fall)\s+(\d{4})$/);
                    if (seasonMatch) {
                        const sMap = { winter: 'зимы', spring: 'весны', summer: 'лета', fall: 'осени' };
                        time = `за сезон ${sMap[seasonMatch[1]]} ${seasonMatch[2]} года`;
                    } else if (/^\d{4}$/.test(time)) {
                        time = `за ${time} год`;
                    }
                }
                return `#${rank} ${type} ${time}`;
            }

            if ((match = cleanText.match(rxAiringEp))) {
                const units = { second:['секунду', 'секунды', 'секунд'], minute: ['минуту', 'минуты', 'минут'], min: ['минуту', 'минуты', 'минут'], hour:['час', 'часа', 'часов'], day: ['день', 'дня', 'дней'], week:['неделю', 'недели', 'недель'], month: ['месяц', 'месяца', 'месяцев'] };
                return `${match[1]} серия выйдет через ${match[2]} ${getPlural(parseInt(match[2]), units[match[3].toLowerCase()])}`;
            }
            if ((match = cleanText.match(rxAiringOnly))) {
                const units = { second:['секунду', 'секунды', 'секунд'], minute: ['минуту', 'минуты', 'минут'], min: ['минуту', 'минуты', 'минут'], hour:['час', 'часа', 'часов'], day: ['день', 'дня', 'дней'], week:['неделю', 'недели', 'недель'], month: ['месяц', 'месяца', 'месяцев'] };
                return `Выйдет через ${match[1]} ${getPlural(parseInt(match[1]), units[match[2].toLowerCase()])}`;
            }

            if ((match = cleanText.match(rxTimeComplex))) {
                const p1 = translateAdvanced(match[1]); const p2 = translateAdvanced(match[2]);
                if (p1 && p2) return `${p1} ${p2}`;
            }
            if ((match = cleanText.match(rxHeight))) return `${match[1].trim()} см${match[2] ? ` (${match[2]})` : ''}`;
            if ((match = cleanText.match(rxLiked))) return `${match[1]} из ${match[2]} оценили этот отзыв`;
            if ((match = cleanText.match(rxDateFull))) return `${match[2]} ${monthsFull[match[1]]} ${match[3]} г.`;
            if ((match = cleanText.match(rxBday))) return match[2].length > 2 ? `${monthsFull[match[1]]} ${match[2]} г.` : `${match[2]} ${monthsFull[match[1]]}`;
            if ((match = cleanText.match(rxSeason))) return `${seasons[match[1]]} ${match[2]}`;

            if ((match = cleanText.match(rxAct))) {
                const isRange = match[3].includes('-') || match[3].includes('–');
                const actRu = { watched: isRange ? 'Просмотрены' : 'Просмотрена', rewatched: isRange ? 'Пересмотрены' : 'Пересмотрена', read: isRange ? 'Прочитаны' : 'Прочитана', reread: isRange ? 'Перечитаны' : 'Перечитана' };
                const typeRu = { episode: isRange ? 'серии' : 'серия', chapter: isRange ? 'главы' : 'глава' };
                return `${actRu[match[1].toLowerCase()]} ${typeRu[match[2].toLowerCase()]} ${match[3].trim()}`;
            }

            if ((match = cleanText.match(rxLabel))) {
                const labels = { 'Format': 'Формат', 'Status': 'Статус', 'Country': 'Страна', 'Chapters': 'Главы', 'Score': 'Оценка', 'Count': 'Количество', 'Hours Watched': 'Часов просмотрено', 'Mean Score': 'Средний балл', 'Chapters Read': 'Глав прочитано', 'Episodes': 'Серии', 'Released': 'Выпущено', 'Started': 'Начато', 'Amount': 'Всего', 'Progress': 'Прогресс', 'Finish Date': 'Дата завершения', 'Birthday': 'День рождения', 'Height': 'Рост', 'Age': 'Возраст', 'Gender': 'Пол', 'Blood Type': 'Группа крови', 'Blood type': 'Группа крови', 'Occupation': 'Род занятий', 'Affiliation': 'Принадлежность', 'Grade': 'Ранг' };
                const val = match[2].trim();
                return `${labels[match[1]]}: ${(Object.prototype.hasOwnProperty.call(dictionary, val) ? dictionary[val] : null) || translateAdvanced(val) || val}`;
            }

            if ((match = cleanText.match(rxUnit))) {
                const num = parseInt(match[1]);
                const forms = { day: ['день', 'дня', 'дней'], hour:['час', 'часа', 'часов'], hr: ['час', 'часа', 'часов'], minute:['минуту', 'минуты', 'минут'], min: ['минуту', 'минуты', 'минут'], mins: ['минуту', 'минуты', 'минут'], sec:['секунду', 'секунды', 'секунд'], episode: ['серия', 'серии', 'серий'], chapter: ['глава', 'главы', 'глав'], volume:['том', 'тома', 'томов'], reply: ['ответ', 'ответа', 'ответов'], user:['пользователь', 'пользователя', 'пользователей'] };
                return `${num} ${getPlural(num, forms[match[2].toLowerCase()])}`;
            }

            if ((match = cleanText.match(rxRecent))) return `${match[1]} недавно ${match[2].toLowerCase() === 'watched' ? 'смотрели' : 'читали'}`;
            if ((match = cleanText.match(rxReviewBy))) return `отзыв от ${match[1]}`;
            if ((match = cleanText.match(rxDayDate))) return `${days[match[1]]}, ${match[3]} ${monthsFull[match[2]]} ${match[4]} г.`;
            if ((match = cleanText.match(rxAgo))) {
                const units = { second:['секунду', 'секунды', 'секунд'], minute:['минуту', 'минуты', 'минут'], hour: ['час', 'часа', 'часов'], day:['день', 'дня', 'дней'], week: ['неделю', 'недели', 'недель'], month:['месяц', 'месяца', 'месяцев'], year: ['год', 'года', 'лет'] };
                return `${match[1]} ${getPlural(parseInt(match[1]), units[match[2].toLowerCase()])} назад`;
            }

            if ((match = cleanText.match(rxListAdded))) {
                const title = (Object.prototype.hasOwnProperty.call(dictionary, match[1]) ? dictionary[match[1]] : null) || match[1];
                const listsMap = { completed: 'Просмотрено', watching: 'Смотрю', reading: 'Читаю', planning: 'В планах', dropped: 'Брошено', paused: 'Отложено' };
                return `«${title}» добавлено в список «${listsMap[match[2].toLowerCase()] || match[2]}»`;
            }

            if ((match = cleanText.match(rxListUpdated))) {
                const title = (Object.prototype.hasOwnProperty.call(dictionary, match[1]) ? dictionary[match[1]] : null) || match[1];
                return `Запись «${title}» обновлена`;
            }

            return null;
        }

        function translateNode(node) {
            if (!node) return;
            // Не трогаем свой UI (напр. поля редактора словаря — иначе перевод сам в себя).
            if (node.nodeType === Node.ELEMENT_NODE && node.closest && node.closest('.am-notr')) return;
            if (node.nodeType === Node.ELEMENT_NODE && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(node.tagName)) {
                ['placeholder', 'title', 'aria-label', 'value', 'label'].forEach(attr => {
                    const val = node.getAttribute(attr);
                    if (val) {
                        const tr = translateAdvanced(val);
                        if (tr && val !== tr) {
                            node.setAttribute(attr, tr);
                            if (attr === 'value' && ('value' in node)) node.value = tr;
                        }
                    }
                });
                if ((node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && node.value) {
                    const trValue = translateAdvanced(node.value);
                    if (trValue && node.value !== trValue) node.value = trValue;
                }
                node.childNodes.forEach(translateNode);
            } else if (node.nodeType === Node.TEXT_NODE) {
                const clean = node.nodeValue.trim();
                if (clean) {
                    const tr = translateAdvanced(clean);
                    if (tr && node.nodeValue.trim() !== tr) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), tr);
                }
            }
        }

        // Перехват Vue-инпутов: переопределяем нативный сеттер, чтобы текст не сбрасывался реактивностью
        function setupVueInputInterceptor() {
            const inputDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (!inputDescriptor || !inputDescriptor.set) return;

            const originalSet = inputDescriptor.set;
            Object.defineProperty(HTMLInputElement.prototype, 'value', {
                configurable: true, enumerable: true, get: inputDescriptor.get,
                set: function(val) {
                    let finalVal = val;
                    try {
                        if (typeof val === 'string' && val.trim() !== '' && this.classList && this.classList.contains('el-input__inner')) {
                            const trValue = translateAdvanced(val);
                            if (trValue && trValue !== val) finalVal = trValue;
                        }
                    } catch (e) { Logger('WARN', 'setupVueInputInterceptor: сбой перевода значения инпута', e); }
                    return originalSet.call(this, finalVal);
                }
            });
        }

        function processTooltip(tooltipNode) {
            const titleEl = tooltipNode.querySelector('.title');
            if (!titleEl) return;

            const hovers = document.querySelectorAll(':hover');
            if (hovers.length === 0) return;

            const deepest = hovers[hovers.length - 1];
            let targetLink = deepest.closest('a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]');

            if (!targetLink) {
                const card = deepest.closest('.media-card, .character-card, .staff-card, .relation-card, .studio-anime');
                if (card) {
                    targetLink = card.querySelector('a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]');
                }
            }

            if (targetLink) {
                const href = targetLink.getAttribute('href');
                let targetId = null;
                let targetType = null;
                let extra = false;

                let matchMed = href.match(/\/(anime|manga)\/(\d+)/);
                let matchChar = href.match(/\/character\/(\d+)\/([^/]+)/);
                let matchStaff = href.match(/\/staff\/(\d+)\/([^/]+)/);

                if (matchMed && settings.translateTitles) { targetId = matchMed[2]; targetType = 'MED2'; }
                else if (matchChar && settings.translateCharacters) { targetId = matchChar[1]; targetType = 'CHR2'; extra = matchChar[2]; }
                else if (matchStaff && settings.translateStaff) { targetId = matchStaff[1]; targetType = 'STF3'; extra = matchStaff[2]; }

                if (targetId) {
                    if (titleEl.dataset.translated === String(targetId)) return;
                    titleEl.dataset.translatingId = String(targetId);
                    return queueContent(targetId, targetType, titleEl, extra);
                }
            }
        }

        function debouncedFindContent() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!settings.translateTitles && !settings.translateCharacters && !settings.translateStaff) return;

                document.querySelectorAll('a[href^="/anime/"], a[href^="/manga/"], a[href^="/character/"], a[href^="/staff/"]').forEach(link => {
                    if (link.querySelector('img') || link.closest('.nav') || link.classList.contains('cover')) return;

                    const href = link.getAttribute('href');
                    const isMedia = href.startsWith('/anime/') || href.startsWith('/manga/');
                    if (isMedia && (link.classList.contains('relation-title') || link.closest('.relations') || link.closest('.role'))) return;

                    let match;
                    if ((match = href.match(/\/(anime|manga)\/(\d+)/)) && settings.translateTitles) {
                        if (link.dataset.translated === match[2]) return;
                        queueContent(match[2], 'MED2', link);
                    } else if ((match = href.match(/\/character\/(\d+)\/([^/]+)/)) && settings.translateCharacters) {
                        if (link.dataset.translated === match[1]) return;
                        queueContent(match[1], 'CHR2', link, match[2]);
                    } else if ((match = href.match(/\/staff\/(\d+)\/([^/]+)/)) && settings.translateStaff) {
                        if (link.dataset.translated === match[1]) return;
                        queueContent(match[1], 'STF3', link, match[2]);
                    }
                });

                const url = location.href;
                if (settings.translateTitles) {
                    const m = url.match(/\/(anime|manga)\/(\d+)/);
                    if (m) {
                        const h1 = document.querySelector('.header .content h1');
                        if (h1 && h1.dataset.translated !== m[2]) queueContent(m[2], 'MED2', h1, true);

                        const desc = document.querySelector('.description');
                        if (desc && (!desc.querySelector('.ru-desc') || desc.dataset.translated !== m[2])) queueContent(m[2], 'MED2', desc);
                    }
                }

                if (settings.translateCharacters) {
                    const m = url.match(/\/character\/(\d+)\/([^/]+)/);
                    if (m) {
                        const h1 = document.querySelector('.header .names h1.name, .header h1.name, .header .content h1');
                        if (h1 && h1.dataset.translated !== m[1]) queueContent(m[1], 'CHR2', h1, true);

                        const desc = document.querySelector('.description');
                        if (desc && (!desc.querySelector('.ru-desc') || desc.dataset.translated !== m[1])) queueContent(m[1], 'CHR2', desc, m[2]);
                    }
                }

                if (settings.translateStaff) {
                    const m = url.match(/\/staff\/(\d+)\/([^/]+)/);
                    if (m) {
                        const h1 = document.querySelector('.header .names h1.name, .header h1.name, .header .content h1');
                        if (h1 && h1.dataset.translated !== m[1]) queueContent(m[1], 'STF3', h1, true);

                        const desc = document.querySelector('.description');
                        if (desc && (!desc.querySelector('.ru-desc') || desc.dataset.translated !== m[1])) queueContent(m[1], 'STF3', desc, m[2]);
                    }
                }
            }, 300);
        }

        async function queueContent(id, type, el, extra = false) {
            if (el.dataset.queued === String(id)) return;
            el.dataset.queued = String(id);

            const key = `${type}_${id}`;
            if (!queue.has(key)) {
                queue.set(key,[]);
            }

            const isAlreadyInQueue = queue.get(key).some(item => item.el === el);
            if (!isAlreadyInQueue) {
                queue.get(key).push({ el, extra });
            }

            const cached = await dbGet('shikiCache', key);
            if (cached && (Date.now() - cached.ts < CACHE_TIME)) {
                const ageMins = Math.round((Date.now() - cached.ts) / 60000);
                Logger('DB', `[Cache HIT] ${key} (возраст ${ageMins} мин)`);
                applyTranslation(type, id, cached.data);
                return;
            }

            Logger('QUEUE', `[Cache MISS] ${key} ➜ Помещено в очередь перевода`);

            if (type === 'MED2') pending.MED2.add(id);
            else if (type === 'CHR2') pending.CHR2.set(id, extra);
            else if (type === 'STF3') pending.STF3.set(id, extra);

            if (!isProcessing) {
                isProcessing = true;
                setTimeout(processTransQueue, 500);
            }
        }

        async function processTransQueue() {
            if (!processTransQueue.activeRound) {
                const total = pending.MED2.size + pending.CHR2.size + pending.STF3.size;
                Logger('QUEUE', `[Process] Запуск обработки. В ожидании: ${total} элементов.`);
                processTransQueue.activeRound = true;
            }

            if (Date.now() < alRateLimitPause || Date.now() < shikiRateLimitPause) {
                return setTimeout(processTransQueue, 1000 + Math.floor(Math.random() * 500));
            }

            if (pending.MED2.size > 0) {
                const ids = Array.from(pending.MED2).slice(0, 40);
                const query = `query ($ids:[Int]) { Page { media(id_in: $ids) { id type idMal seasonYear title { romaji } } } }`;
                const res = await anilistQuery(query, { ids: ids.map(i => parseInt(i)) });

                for (const m of (res?.data?.Page?.media ||[])) {
                    pending.MED2.delete(m.id.toString());
                    if (m.idMal) {
                        dbSet('malCache', { id: m.id, data: m });
                        const resolved = await resolveTitle(m.idMal, m.type);
                        if (resolved) {
                            const data = { ru: resolved.russian, desc: cleanShikiBB(resolved.description, resolved.url, resolved.sourceName) };
                            dbSet('shikiCache', { key: `MED2_${m.id}`, data, ts: Date.now() });
                            applyTranslation('MED2', m.id, data);
                        } else {
                            dbSet('shikiCache', { key: `MED2_${m.id}`, data: { ru: 'NOT_FOUND' }, ts: Date.now() });
                            applyTranslation('MED2', m.id, { ru: 'NOT_FOUND' });
                        }
                    } else {
                        applyTranslation('MED2', m.id, { ru: 'NOT_FOUND' });
                    }
                }
                await new Promise(r => setTimeout(r, 250));
            }
            else if (pending.CHR2.size > 0) {
                const ids = Array.from(pending.CHR2.keys()).slice(0, 10);
                const query = `query ($ids:[Int]) { Page(page:1, perPage:10) { characters(id_in: $ids) { id name { full native } media(sort: POPULARITY_DESC, page: 1, perPage: 6) { nodes { idMal type } } } } }`;
                const res = await anilistQuery(query, { ids: ids.map(i => parseInt(i)) });

                const charMap = {};
                if (res?.data?.Page?.characters) res.data.Page.characters.forEach(c => charMap[c.id] = c);

                for (const id of ids) {
                    if (Date.now() < shikiRateLimitPause || Date.now() < alRateLimitPause) break;
                    const fallbackName = pending.CHR2.get(id);
                    pending.CHR2.delete(id);

                    const charData = charMap[id];
                    let searchName = charData ? charData.name.full : (typeof fallbackName === 'string' ? fallbackName : "");
                    let nativeName = charData ? charData.name.native : "";

                    let shikiItem = null;
                    if (charData) shikiItem = await resolveShikiPersonByMedia(charData, 'characters');

                    if (!shikiItem) {
                        const targetMalIds = charData ? ((charData.media && charData.media.nodes) || []).map(n => n.idMal).filter(Boolean) : [];
                        const sRes = await fetchShikiPersonREST('characters', searchName, nativeName, targetMalIds);
                        if (sRes.status === 200 && sRes.data) shikiItem = sRes.data;
                        else if (sRes.status === 429) { shikiRateLimitPause = Date.now() + 6000; pending.CHR2.set(id, fallbackName); break; }
                    } else {
                        let det = await fetchShiki(`/api/characters/${shikiItem.id}`);
                        if (det.data) shikiItem = { ...shikiItem, description: det.data.description, url: det.data.url, domain: det.domain };
                    }

                    if (shikiItem && shikiItem.russian) {
                        const data = { ru: shikiItem.russian, desc: cleanShikiBB(shikiItem.description, `https://${shikiItem.domain || SHIKI_DOMAINS[0]}${shikiItem.url}`) };
                        dbSet('shikiCache', { key: `CHR2_${id}`, data, ts: Date.now() });
                        applyTranslation('CHR2', id, data);
                    } else {
                        dbSet('shikiCache', { key: `CHR2_${id}`, data: { ru: 'NOT_FOUND' }, ts: Date.now() });
                        applyTranslation('CHR2', id, { ru: 'NOT_FOUND' });
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            }
            else if (pending.STF3.size > 0) {
                const ids = Array.from(pending.STF3.keys()).slice(0, 10);
                const query = `query ($ids:[Int]) { Page(page:1, perPage:10) { staff(id_in: $ids) { id name { full native } staffMedia(sort: POPULARITY_DESC, page: 1, perPage: 6) { nodes { idMal type } } } } }`;
                const res = await anilistQuery(query, { ids: ids.map(i => parseInt(i)) });

                const staffMap = {};
                if (res?.data?.Page?.staff) res.data.Page.staff.forEach(s => staffMap[s.id] = s);

                for (const id of ids) {
                    if (Date.now() < shikiRateLimitPause || Date.now() < alRateLimitPause) break;
                    const fallbackName = pending.STF3.get(id);
                    pending.STF3.delete(id);

                    const staffData = staffMap[id];
                    let searchName = staffData ? staffData.name.full : (typeof fallbackName === 'string' ? fallbackName : "");
                    let nativeName = staffData ? staffData.name.native : "";

                    let shikiItem = null;
                    if (staffData) shikiItem = await resolveShikiPersonByMedia(staffData, 'people');

                    if (!shikiItem) {
                        const targetMalIds = staffData ? ((staffData.staffMedia && staffData.staffMedia.nodes) || []).map(n => n.idMal).filter(Boolean) : [];
                        const sRes = await fetchShikiPersonREST('people', searchName, nativeName, targetMalIds);
                        if (sRes.status === 200 && sRes.data) shikiItem = sRes.data;
                        else if (sRes.status === 429) { shikiRateLimitPause = Date.now() + 6000; pending.STF3.set(id, fallbackName); break; }
                    } else {
                        let det = await fetchShiki(`/api/people/${shikiItem.id}`);
                        if (det.data) shikiItem = { ...shikiItem, description: det.data.description, url: det.data.url, domain: det.domain };
                    }

                    if (shikiItem && shikiItem.russian) {
                        const data = { ru: shikiItem.russian, desc: cleanShikiBB(shikiItem.description, `https://${shikiItem.domain || SHIKI_DOMAINS[0]}${shikiItem.url}`) };
                        dbSet('shikiCache', { key: `STF3_${id}`, data, ts: Date.now() });
                        applyTranslation('STF3', id, data);
                    } else {
                        dbSet('shikiCache', { key: `STF3_${id}`, data: { ru: 'NOT_FOUND' }, ts: Date.now() });
                        applyTranslation('STF3', id, { ru: 'NOT_FOUND' });
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            if (pending.MED2.size > 0 || pending.CHR2.size > 0 || pending.STF3.size > 0) {
                setTimeout(processTransQueue, 1000 + Math.floor(Math.random() * 500));
            } else {
                Logger('QUEUE', '[Process] Очередь пуста. Ожидание новых элементов.');
                processTransQueue.activeRound = false;
                isProcessing = false;
            }
        }

        function safelySetText(el, text) {
            for (let n of el.childNodes) {
                if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim().length > 0) {
                    n.nodeValue = text;
                    return true;
                }
            }
            return false;
        }

        function applyTranslation(type, id, data) {
            const key = `${type}_${id}`;
            const items = queue.get(key) ||[];

            if (data && data.ru && data.ru !== 'NOT_FOUND') {
                items.forEach(item => {
                    if (!document.body.contains(item.el)) return;

                    if (item.el.classList && item.el.classList.contains('title') && item.el.closest('.tooltip')) {
                        if (item.el.dataset.translatingId === String(id)) {
                            item.el.dataset.ru = data.ru;
                            if (!safelySetText(item.el, data.ru)) item.el.innerText = data.ru;
                        }
                    }
                    else if (item.extra === true) {
                        if (!safelySetText(item.el, data.ru)) item.el.innerText = data.ru;
                        document.title = `${data.ru} · AniList`;
                    }
                    else if (item.el.classList && item.el.classList.contains('description') && data.desc) {
                        if (!item.el.querySelector('.ru-desc')) {
                            const origHTML = item.el.innerHTML;
                            // data.desc (cleanShikiBB) и origHTML — доверенные HTML.
                            item.el.innerHTML = html`<div class="ru-desc" style="margin-bottom:20px;">${rawHTML(data.desc)}</div><details style="opacity:0.85;font-size:0.9em;background:rgba(128,128,128,0.15);padding:10px;border-radius:5px;"><summary style="cursor:pointer;color:#3dbbee;font-weight:bold;outline:none;">Оригинальное описание (AniList)</summary><div style="margin-top:10px;">${rawHTML(origHTML)}</div></details>`;
                        }
                    }
                    else {
                        let targetEl = item.el.querySelector('.name') || item.el;
                        safelySetText(targetEl, data.ru);
                        if (item.el.hasAttribute('title')) item.el.setAttribute('title', data.ru);
                        if (item.el.hasAttribute('aria-label')) item.el.setAttribute('aria-label', data.ru);
                    }

                    item.el.dataset.translated = String(id);
                });
            } else {
                items.forEach(item => {
                    if (item.el) item.el.dataset.translated = String(id);
                });
            }
            queue.delete(key);
        }

        // MutationObserver: новые элементы
        let mutationQueue =[];
        let rAF_ID = null;

        const processMutations = () => {
            let changed = false;

            mutationQueue.forEach((m) => {
               if (m.addedNodes.length) {
                    m.addedNodes.forEach(node => {
                        translateNode(node);
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.classList && node.classList.contains('description-length-toggle')) node.click();
                            else node.querySelectorAll('.description-length-toggle').forEach(btn => btn.click());

                            if (node.classList && node.classList.contains('tooltip')) {
                                processTooltip(node);
                            } else {
                                node.querySelectorAll('.tooltip').forEach(processTooltip);
                            }
                        }
                    });
                    changed = true;
                }
                if (m.type === 'characterData') {
                    translateNode(m.target);
                    const parent = m.target.parentNode;
                    if (parent && parent.closest && parent.closest('.tooltip')) processTooltip(parent.closest('.tooltip'));
                    changed = true;
                }
                if (m.type === 'childList' && m.target.nodeType === Node.ELEMENT_NODE) {
                    if (m.target.classList && m.target.classList.contains('tooltip')) processTooltip(m.target);
                    else if (m.target.closest && m.target.closest('.tooltip')) processTooltip(m.target.closest('.tooltip'));
                }
                if (m.type === 'attributes' && ['title', 'aria-label', 'placeholder', 'value', 'label'].includes(m.attributeName)) {
                    translateNode(m.target);
                    changed = true;
                }
            });

            mutationQueue =[];
            rAF_ID = null;

            if (changed) {
                debouncedFindContent();
                if (typeof ensureWidgets === 'function') {
                    clearTimeout(ensureWidgetsTimer);
                    ensureWidgetsTimer = setTimeout(ensureWidgets, 200);
                }
            }
        };

        const obs = new MutationObserver((mutations) => {
            mutationQueue.push(...mutations);
            // Мутации порциями, чтобы не вешать UI
            if (!rAF_ID) rAF_ID = requestAnimationFrame(() => {
                const startTimer = performance.now();
                processMutations();
                const diff = performance.now() - startTimer;
                // Метрика перфа
                if (diff > 50) Logger('INFO', `[Performance] Обновление интерфейса заняло ${diff.toFixed(2)}ms`, { totalMutations: mutations.length });
            });
        });

        obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter:['title', 'aria-label', 'placeholder', 'value', 'label'] });
        setupVueInputInterceptor();
        // Ре-скан страницы обновлённым словарём (после правки записей).
        amRetranslate = () => { try { translateNode(document.body); } catch (e) { Logger('WARN', 'Ре-скан перевода не удался', e); } };
        translateNode(document.body);
        debouncedFindContent();
    }

    // ==========================================
    // 6. МЕДИА (ПЛЕЕР, РЕЙТИНГИ, ФРАНШИЗА)
    // ==========================================
    let currentMediaId = null;
    let currentMediaData = null;

    async function injectMediaExtensions() {
        const path = window.location.pathname.split('/');
        if (!(path[1] === 'anime' || path[1] === 'manga') || !path[2]) return;

        const aniId = parseInt(path[2]);

        // Auto: акцент из постера тайтла (best-effort)

        if (currentMediaId === aniId && currentMediaData) {
            ensureWidgets();
            return;
        }

        // Чистка старых виджетов при смене роута
        if (currentMediaId !== aniId) {
            document.querySelectorAll('.animori-ratings, .animori-franchise, .animori-themes, .animori-extlinks').forEach(el => el.remove());
            const playBtn = document.getElementById('ru-player-btn');
            if (playBtn) playBtn.style.display = 'none';
        }

        currentMediaId = aniId;
        currentMediaData = null;

        Logger('INFO', `[Widget] Открыта страница медиа ID: ${aniId}`);

        let malData = (await dbGet('malCache', aniId))?.data;
        if (currentMediaId !== aniId) return;

        // Нет MAL ID / averageScore в кэше — из GraphQL
        if (!malData || !malData.averageScore) {
            const q = `query($id:Int){Media(id:$id){id type idMal seasonYear averageScore title{romaji english}}}`;
            malData = (await anilistQuery(q, { id: aniId }))?.data?.Media;

            if (currentMediaId !== aniId) return;
            if (malData) dbSet('malCache', { id: aniId, data: malData });
        }

        if (!malData || !malData.idMal) {
            Logger('INFO', 'MAL ID отсутствует, виджеты отключены.');
            return;
        }

        const endpoint = malData.type === 'MANGA' ? 'mangas' : 'animes';
        let shikiData = (await dbGet('shikiCache', `FULL_${aniId}`))?.data;
        if (currentMediaId !== aniId) return;

        let usedDomain = SHIKI_DOMAINS[0];

        if (!shikiData) {
            const res = await fetchShiki(`/api/${endpoint}/${malData.idMal}`);
            if (currentMediaId !== aniId) return;

            shikiData = res.data;
            usedDomain = res.domain || usedDomain;
            if (shikiData) dbSet('shikiCache', { key: `FULL_${aniId}`, data: shikiData, ts: Date.now() });
        }

        currentMediaData = { malData, shikiData, franchiseBox: null };
        ensureWidgets();

        // Дерево франшизы
        if (settings.enableFranchise && shikiData) {
            const fRes = await fetchShiki(`/api/${endpoint}/${malData.idMal}/franchise`);
            if (currentMediaId !== aniId) return;

            if (fRes.data && fRes.data.nodes && fRes.data.nodes.length > 1) {
                const sorted = fRes.data.nodes.sort((a, b) => {
                    const yA = a.year || Infinity;
                    const yB = b.year || Infinity;
                    if (yA !== yB) return yA - yB;
                    return (a.id || 0) - (b.id || 0);
                });

                const malIds = sorted.map(n => n.id);
                const qMap = `query($m:[Int],$t:MediaType){Page{media(idMal_in:$m,type:$t){id idMal type mediaListEntry{status}}}}`;
                const mapRes = await anilistQuery(qMap, { m: malIds, t: malData.type }, true);
                if (currentMediaId !== aniId) return;

                let alMap = {};
                mapRes?.data?.Page?.media.forEach(m => alMap[m.idMal] = m);

                let franchiseBox = document.createElement('div'); franchiseBox.classList.add('am-accent-scope');
                franchiseBox.className = 'animori-franchise';
                const fTitle = document.createElement('h2');
                fTitle.textContent = 'Хронология Франшизы';
                franchiseBox.appendChild(fTitle);

                const list = document.createElement('div');
                list.className = 'franchise-list';
                franchiseBox.appendChild(list);

                sorted.forEach(node => {
                    const alItem = alMap[node.id];
                    const alId = alItem ? alItem.id : null;
                    const listStatus = alItem && alItem.mediaListEntry ? alItem.mediaListEntry.status : null;

                    const link = document.createElement('a');
                    link.href = alId ? `/${malData.type.toLowerCase()}/${alId}` : `https://${usedDomain}${node.url}`;
                    link.className = `franchise-node ${node.id === malData.idMal ? 'active' : ''}`;

                    let statusText = ''; let statusColor = '';
                    let isShikiOnly = !alId; let isCurrentPage = node.id === malData.idMal;

                    if (isShikiOnly) {
                        statusText = ' (Только на Shiki)'; statusColor = '#a0aec0';
                        link.classList.add('shiki-only'); link.target = "_blank";
                    } else if (listStatus) {
                        const isManga = alItem.type === 'MANGA';
                        switch (listStatus) {
                            case 'COMPLETED': statusText = isManga ? ' (Прочитано)' : ' (Просмотрено)'; statusColor = '#a6e3a1'; break;
                            case 'CURRENT':   statusText = isManga ? ' (Читаю)' : ' (Смотрю)'; statusColor = '#89b4fa'; break;
                            case 'PLANNING':  statusText = ' (В планах)'; statusColor = '#cba6f7'; break;
                            case 'REPEATING': statusText = isManga ? ' (Перечитываю)' : ' (Пересматриваю)'; statusColor = '#f5c2e7'; break;
                            case 'PAUSED':    statusText = ' (Отложено)'; statusColor = '#f9e2af'; break;
                            case 'DROPPED':   statusText = ' (Брошено)'; statusColor = '#f38ba8'; break;
                        }
                        if (!isCurrentPage) {
                            link.style.borderLeftColor = statusColor; link.style.background = `${statusColor}15`;
                        }
                    }

                    const divYear = document.createElement('div'); divYear.className = 'node-year'; divYear.textContent = node.year || '???';
                    const divTitle = document.createElement('div'); divTitle.className = 'node-title';
                    const spanTitle = document.createElement('span'); spanTitle.textContent = node.name; divTitle.appendChild(spanTitle);

                    if (statusText) {
                        const spanStatus = document.createElement('span');
                        spanStatus.textContent = statusText; spanStatus.style.color = statusColor;
                        spanStatus.style.fontSize = '0.85em'; spanStatus.style.fontWeight = 'bold'; spanStatus.style.marginLeft = '8px';
                        divTitle.appendChild(spanStatus);
                    }

                    if (isCurrentPage) {
                        const spanHere = document.createElement('span');
                        spanHere.textContent = ' ⬅ Сейчас здесь'; spanHere.style.color = 'rgb(var(--color-blue))';
                        spanHere.style.fontSize = '0.85em'; spanHere.style.fontWeight = 'bold'; spanHere.style.marginLeft = statusText ? '4px' : '8px';
                        divTitle.appendChild(spanHere);
                    }

                    const divKind = document.createElement('div'); divKind.className = 'node-kind'; divKind.textContent = node.kind;
                    link.append(divYear, divTitle, divKind);
                    list.appendChild(link);
                });

                if (sorted.length > 5) {
                    // Верхняя «Свернуть» (sticky): при 50–100 тайтлах нижняя кнопка улетает вниз → дублируем сверху.
                    const topToggle = document.createElement('button');
                    topToggle.className = 'franchise-toggle franchise-toggle-top';
                    topToggle.innerText = 'Свернуть ▲';
                    topToggle.style.display = 'none';
                    fTitle.after(topToggle);

                    const bottomToggle = document.createElement('button');
                    bottomToggle.className = 'franchise-toggle';
                    bottomToggle.innerText = `Развернуть (${sorted.length}) ▼`;

                    let expanded = false;
                    const setExpanded = (state) => {
                        expanded = state;
                        list.classList.toggle('expanded', expanded);
                        topToggle.style.display = expanded ? 'block' : 'none';
                        bottomToggle.innerText = expanded ? 'Свернуть ▲' : `Развернуть (${sorted.length}) ▼`;
                        if (!expanded) {
                            setTimeout(() => {
                                const activeNode = list.querySelector('.active');
                                if (activeNode) list.scrollTop = activeNode.offsetTop - (list.clientHeight / 2) + (activeNode.clientHeight / 2);
                                franchiseBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            }, 50);
                        }
                    };
                    topToggle.onclick = () => setExpanded(false);
                    bottomToggle.onclick = () => setExpanded(!expanded);
                    franchiseBox.appendChild(bottomToggle);
                }

                currentMediaData.franchiseBox = franchiseBox;
                ensureWidgets();
            }
        }
    }

    // Размещение виджетов (рейтинги, темы, франшиза, плеер)
    window.ensureWidgets = function() {
        if (!currentMediaData) return;
        const path = window.location.pathname.split('/');
        if (!(path[1] === 'anime' || path[1] === 'manga') || parseInt(path[2]) !== currentMediaId) return;

        const { malData, shikiData, franchiseBox } = currentMediaData;
        const sidebar = document.querySelector('.sidebar');

        // Виджет рейтингов (Shiki/MAL/AniList)
        if (sidebar && settings.enableRatings && shikiData && !document.querySelector('.animori-ratings')) {
            const ratesBox = document.createElement('div');
            ratesBox.className = 'animori-ratings am-accent-scope';
            let pureScore = "N/A", votes = 0;
            if (shikiData.rates_scores_stats) {
                let sum = 0;
                shikiData.rates_scores_stats.forEach(s => { sum += parseInt(s.name) * s.value; votes += s.value; });
                if (votes > 0) pureScore = (sum / votes).toFixed(2);
            }

            const shikiLink = `https://${shikiData.domain || 'shikimori.io'}${shikiData.url}`;
            const malLink = `https://myanimelist.net/${malData.type === 'MANGA' ? 'manga' : 'anime'}/${malData.idMal}`;

            // Средняя AniList → 10-балльная
            let alScoreText = "N/A";
            if (malData.averageScore) {
                alScoreText = (malData.averageScore / 10).toFixed(2);
            }

            ratesBox.innerHTML = html`
                <a href="${shikiLink}" target="_blank" rel="noopener noreferrer" class="rating-item shiki-badge"><span class="rating-star">★</span><span class="rating-label">SHIKIMORI</span><span class="rating-value">${pureScore}</span></a>
                <a href="${malLink}" target="_blank" rel="noopener noreferrer" class="rating-item mal-badge"><span class="rating-star">★</span><span class="rating-label">MYANIMELIST</span><span class="rating-value">${shikiData.score || 'N/A'}</span></a>
                <div class="rating-item al-badge" title="Официальная средняя оценка AniList" style="cursor:default;"><span class="rating-star">★</span><span class="rating-label">ANILIST</span><span class="rating-value al-score-val">${alScoreText}</span></div>
            `;
            sidebar.prepend(ratesBox);

            // Гистограмма оценок (1..10). В бейдж: цвет столбиков от --rate-c, слева от ярлычка (.am-histo).
            const buildHisto = (label, map) => {
                let mx = 0, total = 0;
                for (let i = 1; i <= 10; i++) { const v = map[i] || 0; if (v > mx) mx = v; total += v; }
                if (mx <= 0) return null;
                const histo = document.createElement('div'); histo.className = 'am-histo';
                const head = document.createElement('div'); head.className = 'am-histo-head';
                head.innerHTML = `<span>${escapeHTML(label)}</span><span>${total.toLocaleString('ru-RU')} ${getPlural(total, ['голос', 'голоса', 'голосов'])}</span>`;
                const bars = document.createElement('div'); bars.className = 'am-histo-bars';
                for (let i = 1; i <= 10; i++) {
                    const v = map[i] || 0; const h = Math.round((v / mx) * 100);
                    const bar = document.createElement('div'); bar.className = 'am-histo-bar'; bar.title = `${i}: ${v.toLocaleString('ru-RU')}`;
                    const fill = document.createElement('div'); fill.className = 'am-histo-fill'; fill.style.height = Math.max(h, 2) + '%';
                    bar.appendChild(fill); bars.appendChild(bar);
                }
                const axis = document.createElement('div'); axis.className = 'am-histo-axis';
                axis.innerHTML = '<span>1</span><span>10</span>';
                histo.append(head, bars, axis);
                return histo;
            };

            // Гистограмма Shikimori
            try {
                const map = {};
                (shikiData.rates_scores_stats || []).forEach(x => { const k = parseInt(x.name); if (k >= 1 && k <= 10) map[k] = x.value; });
                const histo = buildHisto('SHIKIMORI', map);
                // К бейджу MAL (не Shiki), чтобы не срезался шапкой; показ через .shiki-badge:hover ~ .mal-badge.
                const anchor = ratesBox.querySelector('.mal-badge') || ratesBox.querySelector('.shiki-badge');
                if (histo && anchor) { histo.classList.add('am-histo-shiki'); anchor.appendChild(histo); }
            } catch (e) { Logger('WARN', 'Гистограмма Shikimori не построена', e); }
        }

        // Блок франшизы
        if (franchiseBox) {
            const existing = document.querySelector('.animori-franchise:not(.animori-themes):not(.animori-extlinks)');
            const relations = document.querySelector('.relations');
            let justAdded = false;
            if (!existing) {
                if (relations) relations.before(franchiseBox);
                else if (sidebar) sidebar.append(franchiseBox);
                justAdded = true;
            } else if (relations && existing.parentNode === sidebar) {
                relations.before(existing);
                justAdded = true;
            }
            if (justAdded) {
                setTimeout(() => {
                    const list = franchiseBox.querySelector('.franchise-list');
                    if (list && !list.classList.contains('expanded')) {
                        const active = list.querySelector('.active');
                        if (active) list.scrollTop = active.offsetTop - (list.clientHeight / 2) + (active.clientHeight / 2);
                    }
                }, 100);
            }
        }

        // Муз. темы (VK / YouTube Music)
        if (settings.enableThemes && malData.type === 'ANIME' && sidebar && !document.querySelector('.animori-themes')) {
            const themesBox = document.createElement('div'); themesBox.classList.add('am-accent-scope');
            themesBox.className = 'animori-themes animori-franchise';
            themesBox.style.display = 'none';

            const ratingsBlock = sidebar.querySelector('.animori-ratings');
            if (ratingsBlock) ratingsBlock.after(themesBox);
            else sidebar.prepend(themesBox);

            fetchMalThemes(malData.idMal).then(themes => {
                if (!themes || (!themes.openings.length && !themes.endings.length)) {
        // themesBox не удаляем — прячем (display:none), блокирует повторные ensureWidgets.
        return;
                }

                let activeMusicService = GM_getValue('am_music_service', 'vk');
                const headerFlex = document.createElement('div');
                headerFlex.style.cssText = 'display: flex; flex-direction: column; align-items: center; margin-bottom: 12px; gap: 10px;';

                const titleEl = document.createElement('h2');
                titleEl.textContent = 'Музыкальные темы'; titleEl.style.margin = '0'; titleEl.style.width = '100%'; titleEl.style.textAlign = 'center';

                // Поисковая ссылка под сервис
                const musicUrl = (svc, q) => {
                    const eq = encodeURIComponent(q);
                    if (svc === 'vk') return `https://vk.com/audio?q=${eq}`;
                    if (svc === 'spotify') return `https://open.spotify.com/search/${eq}`;
                    if (svc === 'sc') return `https://soundcloud.com/search?q=${eq}`;
                    return `https://music.youtube.com/search?q=${eq}`;
                };
                // Брендовые иконки (монохром, fill от кнопки)
                const svcIcons = {
                    vk: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M13.16 18.06c-6.27 0-9.85-4.3-10-11.45h3.14c.1 5.25 2.42 7.47 4.25 7.93V6.61h2.96v4.53c1.81-.19 3.71-2.26 4.35-4.53h2.96c-.49 2.8-2.56 4.87-4.03 5.72 1.47.69 3.83 2.49 4.73 5.73h-3.26c-.7-2.18-2.44-3.87-4.75-4.09v4.09h-.36z"/></svg>',
                    yt: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm-1.75 14.5v-9l6 4.5-6 4.5z"/></svg>',
                    spotify: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.59 14.42a.62.62 0 0 1-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.81-.87 7.08-.5 9.72 1.11.29.18.39.57.21.86zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.98-1.17a.78.78 0 1 1-.45-1.49c3.64-1.1 8.16-.57 11.24 1.33.37.22.49.71.26 1.07zm.11-2.85C14.72 8.95 9.5 8.76 6.53 9.66a.94.94 0 1 1-.54-1.8c3.41-1.03 9.17-.83 12.79 1.31a.94.94 0 0 1-.96 1.62z"/></svg>',
                    sc: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M1.4 13.2c-.08 0-.14.06-.15.15l-.18 1.85.18 1.82c.01.08.07.14.15.14.08 0 .14-.06.15-.15l.21-1.81-.21-1.85c-.01-.08-.07-.15-.15-.15zm1.02-.95c-.09 0-.16.07-.17.16l-.24 2.79.24 2.7c.01.09.08.16.17.16.09 0 .16-.07.17-.16l.27-2.7-.27-2.79c-.01-.09-.08-.16-.17-.16zm7.72-3.13c-.14 0-.25.11-.26.25l-.3 6.63.3 3.6c.01.14.12.25.26.25.14 0 .25-.11.26-.25l.34-3.6-.34-6.63c-.01-.14-.12-.25-.26-.25zm-2.5.9c-.13 0-.23.1-.24.23l-.27 5.98.27 3.63c.01.13.11.23.24.23s.23-.1.24-.24l.31-3.62-.31-5.98c-.01-.13-.11-.23-.24-.23zm-2.48.62c-.11 0-.2.09-.21.21l-.28 5.38.28 3.65c.01.12.1.21.21.21.11 0 .2-.09.21-.21l.31-3.65-.31-5.38c-.01-.12-.1-.21-.21-.21zm-1.24-.12c-.11 0-.19.08-.2.2l-.26 5.31.26 3.64c.01.11.09.2.2.2.1 0 .19-.09.2-.2l.29-3.64-.29-5.31c-.01-.12-.1-.2-.2-.2zm8.75-1.03c-.15 0-.27.12-.28.28l-.27 6.28.27 3.58c.01.16.13.28.28.28.15 0 .27-.12.28-.28l.3-3.58-.3-6.28c-.01-.16-.13-.28-.28-.28zm2.71 10.7c1.86 0 3.37-1.5 3.37-3.35 0-1.86-1.51-3.36-3.37-3.36-.46 0-.9.09-1.3.26-.27-3.04-2.83-5.43-5.95-5.43-.76 0-1.5.15-2.16.4-.26.1-.33.2-.33.4v11.09c0 .21.16.38.36.4h9.38z"/></svg>'
                };
                const svcTitles = { vk: 'VK Музыка', yt: 'YouTube Music', spotify: 'Spotify', sc: 'SoundCloud' };

                const serviceToggle = document.createElement('div');
                serviceToggle.className = 'am-service-toggle';
                // svcIcons[v] — доверенный SVG → rawHTML()
                serviceToggle.innerHTML = ['vk', 'yt', 'spotify', 'sc'].map(v =>
                    html`<div class="am-service-btn ${activeMusicService === v ? 'active' : ''}" data-val="${v}" title="${svcTitles[v]}" aria-label="${svcTitles[v]}">${rawHTML(svcIcons[v])}</div>`
                ).join('');

                headerFlex.appendChild(titleEl); headerFlex.appendChild(serviceToggle);

                const listEl = document.createElement('div');
                listEl.className = 'themes-list'; listEl.style.cssText = 'display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; padding: 4px 0;';

                // Пилюля в стиле бейджей: полоса, лейбл OP/ED, тайтл + исполнитель, ▶ справа.
                const renderTrack = (track, type) => {
                    const cleanTitle = (track.title || '').replace(/^\d+:\s*/, '').replace(/"/g, '').trim();
                    const artist = (track.artist || '').trim();
                    // Исполнитель в запросе — точнее находит трек
                    const searchQ = [cleanTitle.replace(/\s*\(eps.*?\)/i, ''), artist].filter(Boolean).join(' ').trim();
                    const label = `${type}${track.seq || ''}`;

                    const wrap = document.createElement('a');
                    wrap.className = 'am-theme-track'; wrap.classList.add(type === 'OP' ? 'is-op' : 'is-ed');
                    wrap.dataset.query = searchQ;
                    wrap.href = musicUrl(activeMusicService, searchQ);
                    wrap.target = '_blank';

                    const badge = document.createElement('span'); badge.className = 'am-theme-label';
                    badge.textContent = label;

                    const info = document.createElement('span'); info.className = 'am-theme-info';
                    const titleSpan = document.createElement('span'); titleSpan.className = 'am-theme-title';
                    titleSpan.textContent = cleanTitle;
                    info.appendChild(titleSpan);
                    if (artist) {
                        const artistSpan = document.createElement('span'); artistSpan.className = 'am-theme-artist';
                        artistSpan.textContent = artist;
                        info.appendChild(artistSpan);
                    }

                    // Копирование «Название — Исполнитель». Внутри ссылки: гасим переход/всплытие.
                    const copyBtn = document.createElement('span'); copyBtn.className = 'am-theme-copy';
                    copyBtn.title = 'Скопировать трек'; copyBtn.setAttribute('aria-label', 'Скопировать трек');
                    copyBtn.innerHTML = '<svg class="am-copy-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="am-check-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
                    copyBtn.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        const text = [cleanTitle, artist].filter(Boolean).join(' — ');
                        amCopy(text, copyBtn);
                    });

                    // ▶ убрана. Лейбл OP/ED и кнопка копирования делят позицию: при hover лейбл прячется, кнопка проступает.
                    const lead = document.createElement('span'); lead.className = 'am-theme-lead';
                    lead.append(badge, copyBtn);

                    wrap.append(lead, info);
                    applyMarquee(titleSpan);
                    if (artist) applyMarquee(info.querySelector('.am-theme-artist'));
                    return wrap;
                };

                if (themes.openings.length > 0) themes.openings.forEach(op => listEl.appendChild(renderTrack(op, 'OP')));
                if (themes.endings.length > 0) themes.endings.forEach(ed => listEl.appendChild(renderTrack(ed, 'ED')));

                themesBox.appendChild(headerFlex); themesBox.appendChild(listEl); themesBox.style.display = 'block';

                serviceToggle.querySelectorAll('.am-service-btn').forEach(btn => {
                    btn.onclick = () => {
                        serviceToggle.querySelectorAll('.am-service-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        activeMusicService = btn.dataset.val; GM_setValue('am_music_service', activeMusicService);

                        listEl.querySelectorAll('.am-theme-track').forEach(tr => {
                            tr.href = musicUrl(activeMusicService, tr.dataset.query);
                        });
                    };
                });
            });
        }

        // Внешние ссылки
        if (settings.enableExtLinks && (malData.type === 'ANIME' || malData.type === 'MANGA') && sidebar && !document.querySelector('.animori-extlinks')) {
            const extBox = document.createElement('div'); extBox.className = 'animori-extlinks animori-franchise am-accent-scope';
            const pTitle = document.createElement('h2'); pTitle.textContent = malData.type === 'ANIME' ? 'Где посмотреть' : 'Где почитать';
            pTitle.style.textAlign = 'center'; pTitle.style.marginBottom = '15px'; extBox.appendChild(pTitle);

            const pList = document.createElement('div'); pList.style.cssText = 'display:flex; flex-direction:column; gap:8px;';

            const romaji = malData.title.romaji; const ruTitle = shikiData?.russian || romaji;
            const yummyDomain = settings.yummyDomain || 'yummyanime.tv'; const animegoDomain = settings.animegoDomain || 'animego.org'; const mangalibDomain = settings.mangalibDomain || 'mangalib.me';

            // token — тема-токен AniList (blue/red/...), цвет чипа под тему. Стили — .am-extlink.
            // Фолбэк-триплы, если тема не задаёт часть --color-*
            const tokenFallback = { blue: '61, 187, 238', red: '252, 129, 129', green: '166, 227, 161', orange: '246, 193, 119', pink: '243, 139, 168', purple: '183, 148, 244' };
            // colorSpec: {token:'orange'} (встроенные, под тему) или {triple:'r,g,b'} (свои). opts: {custom, domain}.
            const createExtLink = (name, colorSpec, href, opts = {}) => {
                const a = document.createElement('a');
                a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
                a.className = 'am-extlink';
                if (colorSpec && colorSpec.token) a.style.setProperty('--c', `var(--color-${colorSpec.token}, ${tokenFallback[colorSpec.token] || '120, 130, 150'})`);
                else a.style.setProperty('--c', (colorSpec && colorSpec.triple) || '120,130,150');

                const av = document.createElement('span'); av.className = 'am-extlink-av';
                av.textContent = (name.trim()[0] || '?').toUpperCase();

                const info = document.createElement('span'); info.className = 'am-extlink-info';
                const nm = document.createElement('span'); nm.className = 'am-extlink-name';
                nm.appendChild(document.createTextNode(name));
                if (opts.custom) { const tag = document.createElement('span'); tag.className = 'am-extlink-tag'; tag.textContent = 'своя'; nm.appendChild(tag); }
                const dom = document.createElement('span'); dom.className = 'am-extlink-domain';
                let domain = opts.domain || '';
                if (!domain) { try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch (e) { /* игнор */ } }
                dom.textContent = domain;
                info.append(nm, dom);

                const arrow = document.createElement('span'); arrow.className = 'am-extlink-arrow'; arrow.textContent = '↗';
                a.append(av, info, arrow);
                applyMarquee(nm); applyMarquee(dom);
                return a;
            };

            let linksAdded = 0;
            if (settings.enableLinkRutracker) { pList.appendChild(createExtLink('RuTracker', {token:'orange'}, `https://rutracker.org/forum/tracker.php?nm=${encodeURIComponent(romaji)}`)); linksAdded++; }
            if (malData.type === 'ANIME') {
                if (settings.enableLinkYummy) { pList.appendChild(createExtLink('YummyAnime', {token:'pink'}, `https://${yummyDomain}/index.php?do=search&subaction=search&story=${encodeURIComponent(ruTitle)}`)); linksAdded++; }
                if (settings.enableLinkAnimego) { pList.appendChild(createExtLink('AnimeGO', {token:'purple'}, `https://${animegoDomain}/search/anime?q=${encodeURIComponent(ruTitle)}`)); linksAdded++; }
            } else if (malData.type === 'MANGA') {
                if (settings.enableLinkMangalib) { pList.appendChild(createExtLink('MangaLib', {token:'blue'}, `https://${mangalibDomain}/ru/catalog?q=${encodeURIComponent(ruTitle)}`)); linksAdded++; }
            }

            // Свои ссылки: {ru}/{romaji}/{query}
            const customLinks = getCustomLinks();
            const clQuery = ruTitle || romaji;
            customLinks.forEach(cl => {
                if (!cl || !cl.name || !cl.url) return;
                const url = String(cl.url)
                    .replace(/\{ru\}/g, encodeURIComponent(ruTitle || ''))
                    .replace(/\{romaji\}/g, encodeURIComponent(romaji || ''))
                    .replace(/\{query\}/g, encodeURIComponent(clQuery || ''));
                pList.appendChild(createExtLink(cl.name, { triple: cl.color || '120,130,150' }, url, { custom: true }));
                linksAdded++;
            });

            if (linksAdded > 0) {
                extBox.appendChild(pList);
                const themesBlock = sidebar.querySelector('.animori-themes'); const ratingsBlock = sidebar.querySelector('.animori-ratings');
                if (themesBlock) themesBlock.after(extBox); else if (ratingsBlock) ratingsBlock.after(extBox); else sidebar.prepend(extBox);
            }
        }

        // Плеер (Kodik)
        if (settings.enablePlayer && malData.type === 'ANIME') {
            let btn = document.getElementById('ru-player-btn');
            if (!btn) {
                const actionsContainer = document.getElementById('animori-actions');
                if (actionsContainer) {
                    btn = document.createElement('button'); btn.id = 'ru-player-btn'; btn.className = 'am-premium-btn'; btn.innerHTML = '▶ Плеер'; btn.title = 'Смотреть онлайн'; actionsContainer.prepend(btn);
                }
            }

            if (btn) {
                btn.style.display = 'flex';
                if (!document.getElementById('ru-player-overlay')) {
                    const overlay = document.createElement('div'); overlay.id = 'ru-player-overlay'; overlay.classList.add('am-accent-scope');
                    overlay.innerHTML = html`<div id="ru-player-shell"><div id="ru-stage-col"><div id="ru-info-panel"><div id="ru-title-wrap"><div id="ru-title-track"><span id="info-anime-title">Загрузка...</span></div></div><span id="ru-ep-chip" style="display:none;"></span></div><div id="ru-player-container"><iframe id="ru-p-iframe" allowfullscreen allow="autoplay; fullscreen"></iframe></div></div><div id="ru-sidebar"><div id="ru-sidebar-head"><span class="ru-sb-title">Озвучка</span><div id="ru-player-close">&times;</div></div><div id="ru-translations-panel" style="display:none;"></div><div id="ru-eps-label" style="display:none;">Эпизоды</div><div id="ru-episodes-panel" style="display:none;"></div></div></div>`;
                    document.body.appendChild(overlay);
                    const closeOverlay = () => { overlay.style.display = 'none'; document.getElementById('ru-p-iframe').src = ''; };
                    document.getElementById('ru-player-close').onclick = closeOverlay;
                    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
                }

                btn.onclick = async () => {
                    Logger('INFO', 'Запуск плеера Kodik');
                    const overlay = document.getElementById('ru-player-overlay'); overlay.style.display = 'flex';

                    const rusTitle = shikiData?.russian; const romTitle = malData.title.romaji; const defaultTitle = rusTitle || romTitle;
                    const titleEl = document.getElementById('info-anime-title'); const iframe = document.getElementById('ru-p-iframe');
                    const tPanel = document.getElementById('ru-translations-panel'); const ePanel = document.getElementById('ru-episodes-panel');
                    const epLabel = document.getElementById('ru-eps-label');
                    const epChip = document.getElementById('ru-ep-chip');

                    // SVG-сердечко озвучки (розовое залитое / серый контур)
                    function amHeartSVG(filled) {
                        const c = filled ? 'rgb(var(--color-pink, 243,139,168))' : 'rgb(var(--color-text-light))';
                        return `<svg width="15" height="15" viewBox="0 0 24 24" fill="${filled ? c : 'none'}" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5 4.3 12.6a4.7 4.7 0 0 1 0-6.6 4.5 4.5 0 0 1 6.5 0l1.2 1.2 1.2-1.2a4.5 4.5 0 0 1 6.5 0 4.7 4.7 0 0 1 0 6.6z"/></svg>`;
                    }
                    // Заголовок: бегущая строка при overflow
                    function amSetPlayerTitle(text) {
                        const wrap = document.getElementById('ru-title-wrap');
                        const track = document.getElementById('ru-title-track');
                        if (!titleEl) return;
                        titleEl.textContent = text;
                        if (!wrap || !track) return;
                        track.classList.remove('am-marquee'); wrap.classList.remove('am-mask');
                        track.querySelectorAll('.am-title-dup').forEach(d => d.remove());
                        requestAnimationFrame(() => {
                            if (titleEl.scrollWidth > wrap.clientWidth + 4) {
                                const dup = titleEl.cloneNode(true); dup.removeAttribute('id'); dup.classList.add('am-title-dup');
                                track.appendChild(dup); track.classList.add('am-marquee'); wrap.classList.add('am-mask');
                            }
                        });
                    }

                    iframe.src = ''; tPanel.style.display = 'none'; ePanel.style.display = 'none'; amSetPlayerTitle("Подключение к базе...");

                    let userProgress = 0; let userStatus = null;
                    if (getAlToken()) {
                        try {
                            const progRes = await anilistQuery(`query($id:Int){Media(id:$id){mediaListEntry{progress status}}}`, { id: currentMediaId }, true);
                            if (progRes?.data?.Media?.mediaListEntry) { userProgress = progRes.data.Media.mediaListEntry.progress || 0; userStatus = progRes.data.Media.mediaListEntry.status; }
                        } catch(e) { Logger('ERROR', 'Ошибка получения прогресса AL для плеера', e); }
                    }

                    const fallbackPlayer = (err = '') => {
                        Logger('ERROR', `Срабатывание fallback плеера Kodik: ${err}`);
                        iframe.src = `https://kodikplayer.com/find-player?shikimoriID=${malData.idMal}&types=anime-serial,anime`;
                        amSetPlayerTitle(defaultTitle + (err ? ` (Резерв: ${err})` : ' (Резервный плеер)'));
                        if (epChip) epChip.style.display = 'none';
                    };

                    const kodikToken = '16f20d024a6fa20700b389c44d9ab159';

                    GM_xmlhttpRequest({
                        method: "GET", url: `https://kodik-api.com/search?token=${kodikToken}&shikimori_id=${malData.idMal}`,
                        onload: (res) => {
                            try {
                                const data = JSON.parse(res.responseText);
                                if (data.results && data.results.length > 0) {
                                    const trMap = new Map();
                                    data.results.forEach(r => {
                                        if (r.translation && r.translation.title && !trMap.has(r.translation.title)) {
                                            let link = r.link;
                                            if (link.startsWith('//')) link = 'https:' + link;
                                            // Прячем родные селекторы (свой UI); сериями рулим через API (change_episode) без перезагрузки, даже в фуллскрине.
                                            link += (link.includes('?') ? '&' : '?') + 'hide_selectors=true';

                                            let eps =[];
                                            if (r.seasons) {
                                                const seasonKeys = Object.keys(r.seasons);
                                                if (seasonKeys.length > 0) {
                                                    const firstSeason = r.seasons[seasonKeys[0]];
                                                    if (firstSeason.episodes) eps = Object.keys(firstSeason.episodes).map(Number).sort((a,b) => a - b);
                                                }
                                            }
                                            if (eps.length === 0) {
                                                const max = r.last_episode || r.episodes_count || 1;
                                                for (let i = 1; i <= max; i++) eps.push(i);
                                            }
                                            trMap.set(r.translation.title, { title: r.translation.title, link: link, episodes: eps, type: r.type });
                                        }
                                    });

                                    const translations = Array.from(trMap.values());
                                    if (translations.length === 0) throw new Error("No translations");

                                    let favs = GM_getValue('am_fav_translations',[]); let defaultTr = null;
                                    for (let fav of favs) { const match = translations.find(t => t.title === fav); if (match) { defaultTr = match; break; } }
                                    if (!defaultTr) defaultTr = translations[0];

                                    let activeTranslation = defaultTr;
                                    let activeEpisode = activeTranslation.episodes.length > 0 ? activeTranslation.episodes[0] : 1;
                                    let loadedTranslation = null; // озвучка в iframe

                                    const setTitle = () => {
                                        amSetPlayerTitle(`${defaultTitle} — ${activeTranslation.title}`);
                                        if (epChip) {
                                            if (activeTranslation.type === 'anime-serial') { epChip.style.display = ''; epChip.textContent = `Серия ${activeEpisode}`; }
                                            else epChip.style.display = 'none';
                                        }
                                    };

                                    // seamless=true — смена серии через API без перезагрузки iframe (видео/фуллскрин целы).
                                    // Только внутри загруженной озвучки; смена озвучки = загрузка её ссылки.
                                    const updatePlayer = (seamless = false) => {
                                        const isSerial = activeTranslation.type === 'anime-serial';
                                        if (seamless && isSerial && loadedTranslation === activeTranslation && iframe.contentWindow) {
                                            try {
                                                iframe.contentWindow.postMessage({ key: 'kodik_player_api', value: { method: 'change_episode', episode: activeEpisode } }, '*');
                                            } catch (e) { Logger('ERROR', 'Kodik API change_episode', e); }
                                        } else {
                                            iframe.src = isSerial ? activeTranslation.link + '&episode=' + activeEpisode : activeTranslation.link;
                                            loadedTranslation = activeTranslation;
                                        }
                                        setTitle();
                                    };

                                    const renderEpisodes = () => {
                                        ePanel.innerHTML = '';
                                        if (activeTranslation.type === 'anime' || activeTranslation.episodes.length <= 1) { ePanel.style.display = 'none'; if (epLabel) epLabel.style.display = 'none'; return; }
                                        ePanel.style.display = 'grid'; if (epLabel) epLabel.style.display = '';
                                        const isCompleted = userStatus === 'COMPLETED';

                                        activeTranslation.episodes.forEach(ep => {
                                            const btnEp = document.createElement('div'); btnEp.className = 'ep-btn';
                                            const isWatched = isCompleted || ep <= userProgress;
                                            if (isWatched) btnEp.classList.add('watched');
                                            if (ep === activeEpisode) btnEp.classList.add('active');
                                            btnEp.textContent = ep;
                                            btnEp.onclick = () => { activeEpisode = ep; renderEpisodes(); updatePlayer(true); };
                                            ePanel.appendChild(btnEp);
                                        });
                                    };

                                    const renderTranslations = () => {
                                        tPanel.innerHTML = '';
                                        translations.forEach(tr => {
                                            const isFav = favs.includes(tr.title);
                                            const btnTr = document.createElement('div'); btnTr.className = `tr-btn ${tr.title === activeTranslation.title ? 'active' : ''} ${isFav ? 'favorite' : ''}`;
                                            const nameSpan = document.createElement('span'); nameSpan.className = 'tr-name'; nameSpan.textContent = tr.title;
                                            const heartSpan = document.createElement('span'); heartSpan.className = 'tr-heart'; heartSpan.innerHTML = amHeartSVG(isFav);

                                            btnTr.onclick = (e) => {
                                                if (e.target.closest && e.target.closest('.tr-heart')) return;
                                                activeTranslation = tr;
                                                if (!tr.episodes.includes(activeEpisode)) activeEpisode = tr.episodes[tr.episodes.length - 1] || 1;
                                                renderTranslations(); renderEpisodes(); updatePlayer();
                                            };

                                            heartSpan.onclick = (e) => {
                                                e.stopPropagation();
                                                let currentFavs = GM_getValue('am_fav_translations',[]);
                                                if (currentFavs.includes(tr.title)) currentFavs = currentFavs.filter(f => f !== tr.title);
                                                else currentFavs.unshift(tr.title);
                                                GM_setValue('am_fav_translations', currentFavs);
                                                favs = currentFavs; renderTranslations();
                                            };
                                            btnTr.appendChild(nameSpan); btnTr.appendChild(heartSpan); tPanel.appendChild(btnTr);
                                        });
                                    };

                                    tPanel.style.display = 'flex'; renderTranslations(); renderEpisodes(); updatePlayer();

                                    // Плеер сообщает текущую серию (автопереход/смена изнутри) — подсвечиваем в панели,
                                    // правим заголовок. Слушатель один (снимаем предыдущий).
                                    if (window.__amKodikSync) window.removeEventListener('message', window.__amKodikSync);
                                    window.__amKodikSync = (message) => {
                                        const d = message && message.data;
                                        if (!d || d.key !== 'kodik_player_current_episode' || !d.value) return;
                                        const ep = Number(d.value.episode);
                                        if (!ep || ep === activeEpisode || !activeTranslation.episodes.includes(ep)) return;
                                        activeEpisode = ep; renderEpisodes(); setTitle();
                                    };
                                    window.addEventListener('message', window.__amKodikSync);
                                } else { fallbackPlayer(); }
                            } catch(e) { Logger('ERROR', 'Kodik API: сбой парсинга ответа search', e); fallbackPlayer('API Error'); }
                        },
                        onerror: () => { fallbackPlayer('Network Error'); }
                    });
                };
            }
        } else { const btn = document.getElementById('ru-player-btn'); if (btn) btn.style.display = 'none'; }

        // Акцент к созданным контейнерам
        amApplyAccentToDom();
    };

    // ==========================================
    // 7. РУССКИЙ ПОИСК
    // ==========================================
    // Контекстный захват: выделил текст → кнопка «Перевести» → мини-форма для локальной записи.
    function initDictCapture() {
        let pop = null, form = null, currentSel = '';
        const removePop = () => { if (pop) { pop.remove(); pop = null; } };
        const removeForm = () => { if (form) { form.remove(); form = null; } };
        const inField = (el) => { while (el && el !== document.body) { const t = (el.tagName || '').toUpperCase(); if (t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable) return true; el = el.parentElement; } return false; };
        document.addEventListener('mouseup', (e) => {
            if (form && form.contains(e.target)) return;
            if (pop && pop.contains(e.target)) return;
            setTimeout(() => {
                const sel = window.getSelection();
                const text = sel ? normDictKey(sel.toString()) : '';
                removePop();
                if (!text || text.length < 2 || text.length > 120) return;
                if (inField(e.target)) return;
                if (!/[A-Za-z]/.test(text)) return; // только латиница
                let rect; try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (_) { return; }
                if (!rect || (!rect.width && !rect.height)) return;
                currentSel = text;
                pop = document.createElement('div'); pop.className = 'am-dict-capture am-accent-scope';
                pop.innerHTML = '<button class="am-dict-cap-btn" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>Перевести</button>';
                document.body.appendChild(pop);
                const px = Math.min(Math.max(8, rect.left + rect.width / 2 - pop.offsetWidth / 2), window.innerWidth - pop.offsetWidth - 8);
                pop.style.left = px + 'px';
                pop.style.top = (rect.top + window.scrollY - pop.offsetHeight - 8) + 'px';
                pop.querySelector('.am-dict-cap-btn').onclick = () => { openForm(rect); };
            }, 10);
        });
        const openForm = (rect) => {
            removePop(); removeForm();
            const existing = getUserDict()[currentSel] || '';
            form = document.createElement('div'); form.className = 'am-dict-capform am-accent-scope am-notr';
            form.innerHTML = `
                <div class="am-dict-capform-head">Свой перевод</div>
                <div class="am-dict-capform-src" title="${currentSel.replace(/"/g, '&quot;')}">${currentSel.replace(/</g, '&lt;')}</div>
                <input class="amk-input am-dict-capform-inp" placeholder="Перевод (рус.)" value="${existing.replace(/"/g, '&quot;')}">
                <div class="am-dict-capform-btns">
                    <button class="amk-btn amk-btn-ghost am-dict-capform-cancel" type="button">Отмена</button>
                    <button class="amk-btn amk-btn-primary am-dict-capform-save" type="button">Сохранить</button>
                </div>`;
            document.body.appendChild(form);
            const px = Math.min(Math.max(8, rect.left), window.innerWidth - form.offsetWidth - 8);
            let py = rect.top + window.scrollY - form.offsetHeight - 8;
            if (py < window.scrollY + 8) py = rect.bottom + window.scrollY + 8;
            form.style.left = px + 'px'; form.style.top = py + 'px';
            const inp = form.querySelector('.am-dict-capform-inp');
            inp.focus(); inp.select();
            const save = () => { if (upsertUserDictEntry(currentSel, inp.value)) { removeForm(); const s2 = window.getSelection(); if (s2) s2.removeAllRanges(); } };
            form.querySelector('.am-dict-capform-save').onclick = save;
            form.querySelector('.am-dict-capform-cancel').onclick = removeForm;
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') removeForm(); });
        };
        document.addEventListener('mousedown', (e) => {
            if (pop && !pop.contains(e.target)) removePop();
            if (form && !form.contains(e.target)) removeForm();
        });
        document.addEventListener('scroll', () => { removePop(); }, true);
    }

    function initRussianSearch() {
        let searchTimeout = null; let activeQuery = ""; let cachedHtml = "";

        // Главный инпут поиска AniList
        document.body.addEventListener('input', (e) => {
            const target = e.target;
            if (target.tagName !== 'INPUT' || target.getAttribute('placeholder') !== 'Поиск в AniList') return;

            const query = target.value.trim(); const hasCyrillic = /[а-яА-ЯёЁ]/.test(query);

            if (!hasCyrillic || query.length < 2) {
                document.body.classList.remove('am-ru-search-active'); activeQuery = ""; cachedHtml = ""; removeCustomResults(); return;
            }
            if (query === activeQuery) return;

            activeQuery = query; document.body.classList.add('am-ru-search-active'); clearTimeout(searchTimeout);
            cachedHtml = html`<div class="am-ru-loading">Ищем на Shikimori... 🔍</div>`; renderCustomResults(cachedHtml);
            searchTimeout = setTimeout(() => performRussianSearch(query), 600);
        });

        async function performRussianSearch(query) {
            Logger('INFO', `Русский поиск: ${query}`);
            try {
                const [animeRes, mangaRes, charRes, staffRes] = await Promise.all([
                    fetchShiki(`/api/animes?search=${encodeURIComponent(query)}&limit=4`),
                    fetchShiki(`/api/mangas?search=${encodeURIComponent(query)}&limit=4`),
                    fetchShiki(`/api/characters/search?search=${encodeURIComponent(query)}`),
                    fetchShiki(`/api/people/search?search=${encodeURIComponent(query)}`)
                ]);
                if (activeQuery !== query) return;

                const shikiAnime = animeRes.data || []; const shikiManga = mangaRes.data ||[];
                // /search игнорит &limit — режем на клиенте; помечаем зеркало для абс. URL.
                const tagDomain = (res) => (res.data || []).map(i => ({ ...i, __domain: res.domain || SHIKI_DOMAINS[0] }));
                const shikiChars = tagDomain(charRes).slice(0, 4);
                const shikiStaff = tagDomain(staffRes).slice(0, 4);

                if (shikiAnime.length === 0 && shikiManga.length === 0 && shikiChars.length === 0 && shikiStaff.length === 0) {
                    cachedHtml = html`<div class="am-ru-empty">Ничего не найдено ¯\\_(ツ)_/¯</div>`; renderCustomResults(cachedHtml); return;
                }

                const malIds =[...shikiAnime.map(i => i.id), ...shikiManga.map(i => i.id)];
                // Единый AniList-запрос: медиа по MAL id + персонажи/стафф через алиасы Page.
                // ВАЖНО: корневые Character/Staff дают 404 на пустой результат → оборачиваем в Page (пустой список без 404).
                const varDefs = ['$m:[Int]'];
                const rootFields = ['pm: Page{ media(idMal_in:$m){ id idMal type format seasonYear coverImage{medium} } }'];
                const vars = { m: malIds };
                shikiChars.forEach((c, i) => { varDefs.push(`$c${i}:String`); rootFields.push(`pc${i}: Page(perPage:1){ characters(search:$c${i}){ id image{ large } } }`); vars[`c${i}`] = c.name; });
                shikiStaff.forEach((c, i) => { varDefs.push(`$s${i}:String`); rootFields.push(`ps${i}: Page(perPage:1){ staff(search:$s${i}){ id image{ large } } }`); vars[`s${i}`] = c.name; });
                const alQuery = `query(${varDefs.join(',')}){ ${rootFields.join(' ')} }`;
                const alRes = await anilistQuery(alQuery, vars);
                if (activeQuery !== query) return;

                const alData = alRes?.data?.pm?.media ||[]; const alMap = {};
                alData.forEach(item => { alMap[`${item.type}_${item.idMal}`] = item; });
                const alPersons = alRes?.data || {};

                let resultHtml = '';
                const generateCol = (title, items, typeStr) => {
                    if (items.length === 0) return '';
                    let colHtml = html`<div class="result-col animori-custom-result-col"><h3 class="title">${title}</h3>`;
                    items.forEach(item => {
                        const alItem = alMap[`${typeStr.toUpperCase()}_${item.id}`]; if (!alItem) return;
                        const year = alItem.seasonYear || (item.aired_on ? new Date(item.aired_on).getFullYear() : '???');
                        const format = (alItem.format || typeStr).replace(/_/g, ' ');
                        const coverSafe = rawHTML(encodeURI(alItem.coverImage.medium).replace(/'/g, "%27"));
                        colHtml += html`<div class="result"><div><a href="/${String(alItem.type).toLowerCase()}/${alItem.id}" class=""><div class="image" style="background-image: url('${coverSafe}');"></div><div class="name">${item.russian || item.name}<div class="info"><span>${year}</span> <span>${format}</span></div></div></a></div></div>`;
                    });
                    colHtml += html`</div>`; return colHtml;
                };
                // Персонажи/стафф: ссылка+картинка AniList при совпадении, иначе фоллбэк Shikimori.
                const generatePersonCol = (title, items, aliasPrefix, listKey, alPath) => {
                    if (items.length === 0) return '';
                    let colHtml = html`<div class="result-col animori-custom-result-col"><h3 class="title">${title}</h3>`;
                    items.forEach((item, i) => {
                        const pageNode = alPersons[`${aliasPrefix}${i}`];
                        const node = pageNode && pageNode[listKey] && pageNode[listKey][0];
                        const alId = node && node.id;
                        const href = alId ? `/${alPath}/${alId}` : `https://${item.__domain}${item.url}`;
                        const imgUrl = (alId && node.image && node.image.large) ? node.image.large : `https://${item.__domain}${item.image.preview}`;
                        const coverSafe = rawHTML(encodeURI(imgUrl).replace(/'/g, "%27"));
                        colHtml += html`<div class="result"><div><a href="${href}" class=""><div class="image" style="background-image: url('${coverSafe}');"></div><div class="name">${item.russian || item.name}<div class="info"><span>${item.name}</span></div></div></a></div></div>`;
                    });
                    colHtml += html`</div>`; return colHtml;
                };

                resultHtml += generateCol('Аниме (RU)', shikiAnime, 'Anime'); resultHtml += generateCol('Манга (RU)', shikiManga, 'Manga');
                resultHtml += generatePersonCol('Персонажи (RU)', shikiChars, 'pc', 'characters', 'character');
                resultHtml += generatePersonCol('Стафф (RU)', shikiStaff, 'ps', 'staff', 'staff');
                if (resultHtml === '') resultHtml = html`<div class="am-ru-empty">Совпадений на AniList не найдено</div>`;
                cachedHtml = resultHtml; renderCustomResults(resultHtml);

            } catch (e) {
                if (activeQuery !== query) return;
                cachedHtml = html`<div class="am-ru-empty">Ошибка соединения с базой</div>`; renderCustomResults(cachedHtml);
                Logger('ERROR', 'Ошибка русского поиска', e);
            }
        }

        function renderCustomResults(htmlContent) {
            let resultsContainer = document.querySelector('.results:not(.am-fake-results)');
            if (!resultsContainer) {
                resultsContainer = document.querySelector('.am-fake-results');
                if (!resultsContainer) {
                    const inputWrap = document.querySelector('.input');
                    if (inputWrap && inputWrap.parentNode) {
                        resultsContainer = document.createElement('div'); resultsContainer.className = 'results am-fake-results';
                        const dataAttr = Array.from(inputWrap.attributes).find(a => a.name.startsWith('data-v-'));
                        if (dataAttr) resultsContainer.setAttribute(dataAttr.name, '');
                        inputWrap.parentNode.appendChild(resultsContainer);
                    } else return;
                }
            }

            document.querySelectorAll('.am-ru-injected-container').forEach(el => el.remove());
            // htmlContent — доверенный HTML.
            const wrapper = document.createElement('div'); wrapper.className = 'am-ru-injected-container'; wrapper.innerHTML = html`${rawHTML(htmlContent)}`;
            resultsContainer.appendChild(wrapper);
        }

        function removeCustomResults() {
            document.querySelectorAll('.am-ru-injected-container').forEach(el => el.remove());
            document.querySelectorAll('.am-fake-results').forEach(el => el.remove());
        }

        const observer = new MutationObserver((mutations) => {
            if (document.body.classList.contains('am-ru-search-active') && activeQuery.length >= 2) {
                const realResults = document.querySelector('.results:not(.am-fake-results)');
                const fakeResults = document.querySelector('.am-fake-results');
                if (realResults && fakeResults) fakeResults.remove();

                const resultsContainer = document.querySelector('.results');
                const hasOurContainer = document.querySelector('.am-ru-injected-container');
                if (resultsContainer && !hasOurContainer && cachedHtml) renderCustomResults(cachedHtml);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ==========================================
    // 8. ИНИЦИАЛИЗАЦИЯ И UI НАСТРОЕК
    // ==========================================
    async function init() {
        Logger('INFO', 'Скрипт AniMori загружается...');

        GM_addStyle(`
            /* Акцент тулкита: по умолч. синий AniList, переопределяется пресетом на documentElement */
            :root { --am-accent: var(--color-blue); }
            /* Блок-пилюля кнопок (плеер слева) */
            #animori-actions { position:fixed; bottom:25px; left:25px; z-index:9999; display:flex; align-items:stretch; gap:0; background:rgba(var(--color-foreground),0.8); backdrop-filter:blur(16px) saturate(170%); -webkit-backdrop-filter:blur(16px) saturate(170%); border:1px solid rgba(var(--color-text-light),0.2); border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.18); overflow:hidden; }
            .am-premium-btn { background:transparent; border:none; border-radius:0; box-shadow:none; color:rgb(var(--color-text)); padding:11px 18px; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:background .15s, color .15s; display:flex; align-items:center; justify-content:center; letter-spacing:0.3px; }
            .am-premium-btn + .am-premium-btn { border-left:1px solid rgba(var(--color-text-light),0.14); }
            .am-premium-btn:hover { background:rgba(var(--color-text-light),0.1); color:rgb(var(--am-accent)); }
            #am-set-btn, #am-log-btn, #am-cmp-btn { font-size:15px; width:46px; padding:11px 0; }
            #ru-player-btn { color:rgb(var(--am-accent)); font-weight:700; }
            #ru-player-btn:hover { background:rgba(var(--am-accent),0.14); }
            @keyframes am-pulse { 0% { box-shadow: 0 0 0 0 rgba(var(--am-accent), 0.3); } 70% { box-shadow: 0 0 0 15px rgba(var(--am-accent), 0); border-color: rgba(var(--am-accent), 0.5); } 100% { box-shadow: 0 0 0 0 rgba(var(--am-accent), 0); } }
            /* #am-panel — модалка-overlay */
            @keyframes panel-pop { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            #am-panel::-webkit-scrollbar { width: 6px; } #am-panel::-webkit-scrollbar-thumb { background: rgba(var(--am-accent), 0.4); border-radius: 4px; }

            /* ===== AniMori UI Kit — тема-нативные компоненты ===== */
            .amk-overlay, #am-panel { position:fixed; inset:0; z-index:999999; display:none; align-items:center; justify-content:center; padding:24px; background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); animation:amk-fade .18s ease; }
            @keyframes amk-fade { from{opacity:0} to{opacity:1} }
            @keyframes amk-pop { from{transform:translateY(10px) scale(.985); opacity:0} to{transform:none; opacity:1} }
            .amk-modal { display:flex; flex-direction:column; width:540px; max-width:96vw; max-height:88vh; background:rgba(var(--color-foreground),0.8); backdrop-filter:blur(22px) saturate(170%); -webkit-backdrop-filter:blur(22px) saturate(170%); color:rgb(var(--color-text)); border:1px solid rgba(var(--color-text-light),0.16); border-radius:14px; box-shadow:0 12px 44px rgba(0,0,0,0.22); overflow:hidden; animation:amk-pop .2s cubic-bezier(.2,.8,.2,1); font-family:inherit; font-size:14px; }
            .amk-modal.amk-wide { width:920px; }
            .amk-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border-bottom:1px solid rgba(var(--color-text-light),0.1); flex-wrap:wrap; flex-shrink:0; }
            .amk-title { margin:0; font-size:15px; font-weight:700; letter-spacing:.3px; display:flex; align-items:center; gap:9px; }
            .amk-title .amk-dot { width:9px; height:9px; border-radius:50%; background:rgb(var(--am-accent)); box-shadow:0 0 10px rgba(var(--am-accent),0.6); }
            .amk-sub { font-size:12px; color:rgb(var(--color-text-light)); font-weight:500; }
            .amk-body { padding:16px 18px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; flex:1 1 auto; min-height:0; }
            .amk-body > * { flex-shrink:0; }
            .amk-foot { padding:12px 18px; border-top:1px solid rgba(var(--color-text-light),0.1); display:flex; gap:10px; flex-shrink:0; }
            .amk-body::-webkit-scrollbar { width:8px; } .amk-body::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; }
            #am-panel .amk-modal { width:600px; }
            .amk-body.amk-tabbed { flex-direction:row; padding:0; gap:0; }
            .amk-tabnav { width:168px; flex-shrink:0; border-right:1px solid rgba(var(--color-text-light),0.1); padding:12px 10px; display:flex; flex-direction:column; gap:3px; overflow-y:auto; }
            .amk-tab { display:flex; align-items:center; gap:10px; padding:9px 11px; border-radius:9px; border:none; background:none; cursor:pointer; text-align:left; font-family:inherit; font-size:13px; font-weight:500; color:rgb(var(--color-text-light)); border-left:3px solid transparent; transition:background .15s, color .15s, border-color .15s; width:100%; }
            .amk-tab:hover { background:rgba(var(--color-text-light),0.08); color:rgb(var(--color-text)); }
            .amk-tab.active { background:rgba(var(--am-accent),0.14); color:rgb(var(--color-text)); font-weight:700; border-left-color:rgb(var(--am-accent)); }
            .amk-tab-ic { width:18px; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
            .amk-tab-ic svg { display:block; }
            .amk-tabnav::-webkit-scrollbar { width:6px; } .amk-tabnav::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; }
            .amk-tabpanes { flex:1 1 auto; min-width:0; overflow-y:auto; padding:16px 18px; }
            .amk-tabpanes::-webkit-scrollbar { width:8px; } .amk-tabpanes::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; }
            .amk-pane { display:none; flex-direction:column; gap:14px; }
            .amk-pane.active { display:flex; animation:amk-fade .18s ease; }
            .amk-card { background:rgba(var(--color-background-100),0.55); border:1px solid rgba(var(--color-text-light),0.1); border-radius:10px; padding:2px 12px 6px; }
            .amk-card-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.7px; color:rgb(var(--color-text-light)); padding:10px 2px 4px; }
            .amk-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 2px; }
            .amk-row + .amk-row { border-top:1px solid rgba(var(--color-text-light),0.07); }
            .amk-row-label { display:flex; flex-direction:column; gap:2px; min-width:0; }
            .amk-row-label b { font-weight:600; }
            .amk-row-hint { font-size:11px; color:rgb(var(--color-text-light)); line-height:1.45; }
            .amk-switch { position:relative; width:38px; height:22px; flex-shrink:0; cursor:pointer; display:inline-block; }
            .amk-switch input { position:absolute; opacity:0; width:0; height:0; }
            .amk-track { position:absolute; inset:0; border-radius:6px; background:rgba(var(--color-text-light),0.3); transition:background .18s; }
            .amk-thumb { position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:4px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.35); transition:transform .18s; }
            .amk-switch input:checked ~ .amk-track { background:rgb(var(--am-accent)); }
            .amk-switch input:checked ~ .amk-thumb { transform:translateX(16px); }
            .amk-input, .amk-select { width:100%; box-sizing:border-box; background:rgba(var(--color-background-200),0.7); border:1px solid rgba(var(--color-text-light),0.18); color:rgb(var(--color-text)); border-radius:8px; padding:8px 10px; font-size:13px; font-family:inherit; outline:none; transition:border-color .15s, box-shadow .15s; }
            .amk-input:focus, .amk-select:focus { border-color:rgb(var(--am-accent)); box-shadow:0 0 0 3px rgba(var(--am-accent),0.18); }
            .amk-input.amk-mono { font-family:"Cascadia Code","Fira Code",Consolas,monospace; font-size:12px; }
            .amk-input::placeholder { color:rgba(var(--color-text-light),0.7); }
            .amk-btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:9px 16px; border-radius:8px; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; border:1px solid transparent; transition:all .15s; white-space:nowrap; }
            .amk-btn-primary { background:rgb(var(--am-accent)); color:#fff; }
            .amk-btn-primary:hover { filter:brightness(1.08); box-shadow:0 4px 14px rgba(var(--am-accent),0.35); }
            .amk-btn-ghost { background:rgba(var(--color-text-light),0.08); color:rgb(var(--color-text)); border-color:rgba(var(--color-text-light),0.18); }
            .amk-btn-ghost:hover { background:rgba(var(--color-text-light),0.15); border-color:rgb(var(--am-accent)); color:rgb(var(--am-accent)); }
            .amk-btn-danger { background:rgba(var(--color-red),0.12); color:rgb(var(--color-red)); border-color:rgba(var(--color-red),0.35); }
            .amk-btn-danger:hover { background:rgba(var(--color-red),0.2); }
            .amk-btn:disabled { opacity:.5; cursor:default; }
            .amk-btn-block { width:100%; }
            .amk-close { background:rgba(var(--color-text-light),0.1); border:1px solid rgba(var(--color-text-light),0.18); color:rgb(var(--color-text)); width:30px; height:30px; border-radius:8px; cursor:pointer; font-size:15px; line-height:1; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
            .amk-close:hover { background:rgba(var(--color-red),0.15); color:rgb(var(--color-red)); border-color:rgba(var(--color-red),0.3); }
            .amk-chip { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; background:rgba(var(--color-text-light),0.08); border:1px solid rgba(var(--color-text-light),0.15); color:rgb(var(--color-text)); transition:all .15s; }
            .amk-chip:hover { border-color:rgb(var(--am-accent)); }
            .amk-chip.active { background:rgba(var(--am-accent),0.15); border-color:rgb(var(--am-accent)); color:rgb(var(--am-accent)); }
            .amk-accents { display:flex; flex-wrap:wrap; gap:8px; }
            .am-accent-chip { display:inline-flex; align-items:center; gap:7px; padding:7px 12px; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600; font-family:inherit; color:rgb(var(--color-text-light)); background:rgba(var(--color-text-light),0.06); border:1px solid rgba(var(--color-text-light),0.2); transition:background .15s, border-color .15s, color .15s; }
            .am-accent-chip:hover { border-color:rgb(var(--am-accent)); color:rgb(var(--color-text)); }
            .am-accent-chip.active { background:rgba(var(--am-accent),0.15); border-color:rgb(var(--am-accent)); color:rgb(var(--am-accent)); }
            .am-accent-dot { width:13px; height:13px; border-radius:50%; flex-shrink:0; box-shadow:0 0 0 1px rgba(255,255,255,0.15) inset; }
            .amk-collapse { border:1px solid rgba(var(--color-text-light),0.1); border-radius:10px; overflow:hidden; margin:6px 0; }
            .amk-collapse > summary { list-style:none; cursor:pointer; padding:10px 12px; font-weight:600; font-size:13px; background:rgba(var(--color-background-100),0.5); display:flex; align-items:center; gap:8px; }
            .amk-collapse > summary::-webkit-details-marker { display:none; }
            .amk-collapse > summary:hover { background:rgba(var(--color-text-light),0.06); }
            .amk-collapse[open] > summary { border-bottom:1px solid rgba(var(--color-text-light),0.1); }
            .amk-collapse-body { padding:4px 6px; max-height:340px; overflow:auto; }
            .amk-count { color:rgb(var(--color-text-light)); font-weight:500; }
            .amk-diffrow { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px; border-bottom:1px solid rgba(var(--color-text-light),0.06); font-size:12px; }
            .amk-diffrow .amk-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
            .amk-diffrow .amk-meta { opacity:.85; white-space:nowrap; }
            .amk-x { cursor:pointer; opacity:.5; padding:0 4px; flex-shrink:0; } .amk-x:hover { opacity:1; color:rgb(var(--color-red)); }
            .amk-table { width:100%; border-collapse:collapse; font-size:13px; }
            .amk-table th, .amk-table td { padding:4px 8px; text-align:center; } .amk-table th:first-child, .amk-table td:first-child { text-align:left; }
            .amk-table thead th { border-bottom:1px solid rgba(var(--color-text-light),0.15); font-weight:600; }
            .amk-table tbody tr:not(:last-child) td { border-bottom:1px solid rgba(var(--color-text-light),0.06); }
            #ru-player-overlay { position:fixed; inset:0; width:100vw; height:100vh; background:rgba(0,0,0,0.82); backdrop-filter:blur(14px) saturate(160%); -webkit-backdrop-filter:blur(14px) saturate(160%); z-index:10000; display:none; justify-content:center; align-items:center; gap:12px; animation: player-fade 0.3s ease; }
            @keyframes player-fade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes am-title-marquee { from { transform:translateX(0); } to { transform:translateX(-50%); } }
            #ru-player-shell { display:flex; gap:14px; width:92%; max-width:1200px; height:86vh; max-height:780px; }
            #ru-stage-col { flex:1; min-width:0; display:flex; flex-direction:column; gap:10px; }
            #ru-player-container { flex:1; min-height:0; background:#000; border-radius:12px; overflow:hidden; border:1px solid rgba(var(--am-accent),0.3); position:relative; box-shadow: 0 20px 60px rgba(0,0,0,0.55); }
            #ru-p-iframe { width:100%; height:100%; border:none; }
            #ru-info-panel { display:flex; align-items:center; gap:10px; min-width:0; background:rgba(var(--color-foreground),0.85); backdrop-filter:blur(14px) saturate(160%); -webkit-backdrop-filter:blur(14px) saturate(160%); border-radius:10px; padding:10px 14px; border:1px solid rgba(var(--color-text-light),0.15); flex-shrink:0; }
            #ru-title-wrap { position:relative; overflow:hidden; flex:1; min-width:0; }
            #ru-title-wrap.am-mask { -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%); mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%); }
            #ru-title-track { display:block; max-width:100%; }
            #ru-title-track.am-marquee { display:inline-flex; gap:48px; white-space:nowrap; padding-left:16px; animation:am-title-marquee 16s linear infinite; }
            #info-anime-title { color:rgb(var(--am-accent)); font-weight:bold; font-size:15px; text-transform:uppercase; letter-spacing:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; }
            #ru-title-track.am-marquee #info-anime-title, .am-title-dup { overflow:visible; text-overflow:clip; }
            #ru-ep-chip { flex-shrink:0; color:rgb(var(--am-accent)); font-weight:700; font-size:12px; padding:3px 9px; border-radius:6px; background:rgba(var(--am-accent),0.14); white-space:nowrap; }
            #ru-player-close { width:34px; height:34px; display:flex; align-items:center; justify-content:center; line-height:1; color:rgb(var(--color-text-light)); font-size:20px; cursor:pointer; border-radius:8px; background:rgba(var(--color-foreground),0.6); border:1px solid rgba(var(--color-text-light),0.15); transition:all .18s; flex-shrink:0; }
            #ru-player-close:hover { color:#fff; background:rgb(var(--color-red)); border-color:rgb(var(--color-red)); transform:scale(1.05); }
            #ru-sidebar { width:264px; flex-shrink:0; display:flex; flex-direction:column; gap:12px; background:rgba(var(--color-foreground),0.85); backdrop-filter:blur(14px) saturate(160%); -webkit-backdrop-filter:blur(14px) saturate(160%); border-radius:12px; border:1px solid rgba(var(--color-text-light),0.15); padding:12px; }
            #ru-sidebar-head { display:flex; align-items:center; gap:8px; }
            #ru-sidebar-head .ru-sb-title { flex:1; color:rgb(var(--color-text)); font-weight:700; }
            #ru-translations-panel { display:flex; flex-direction:column; gap:6px; max-height:42%; overflow-y:auto; padding-right:4px; }
            #ru-eps-label { color:rgb(var(--color-text-light)); font-size:11px; text-transform:uppercase; letter-spacing:0.6px; font-weight:700; }
            #ru-episodes-panel { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; overflow-y:auto; flex:1; align-content:start; padding-right:4px; }
            .tr-btn { display:flex; align-items:center; gap:8px; background:rgba(var(--color-foreground),0.6); border:1px solid rgba(var(--color-text-light),0.18); padding:7px 10px; border-radius:8px; cursor:pointer; transition:all .18s; color:rgb(var(--color-text)); font-weight:600; font-size:13px; }
            .tr-btn:hover { border-color:rgba(var(--am-accent),0.5); } .tr-btn.active { border-color:rgb(var(--am-accent)); background:rgba(var(--am-accent),0.15); color:rgb(var(--am-accent)); } .tr-btn.favorite { border-color:rgb(var(--color-pink, 243,139,168)); color:rgb(var(--color-pink, 243,139,168)); background:rgba(var(--color-pink, 243,139,168),0.06); } .tr-btn.favorite.active { background:rgba(var(--color-pink, 243,139,168),0.16); }
            .tr-heart { display:flex; align-items:center; transition:transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275); user-select:none; flex-shrink:0; } .tr-heart:hover { transform:scale(1.25); } .tr-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .ep-btn { height: 34px; display: flex; justify-content: center; align-items: center; background: rgba(var(--color-foreground),0.6); border: 1px solid rgba(var(--color-text-light),0.18); color: rgb(var(--color-text)); font-weight: 700; font-size: 13px; border-radius: 8px; cursor: pointer; transition: all .18s; }
            .ep-btn:hover { border-color: rgba(var(--am-accent), 0.5); } .ep-btn.active { background: rgb(var(--am-accent)); color: #fff; border-color: rgb(var(--am-accent)); box-shadow: 0 4px 12px rgba(var(--am-accent), 0.3); }
            .ep-btn.watched { border-color: rgb(var(--color-green, 166,227,161)); color: rgb(var(--color-green, 166,227,161)); } .ep-btn.watched:hover { background: rgba(var(--color-green, 166,227,161),0.12); } .ep-btn.watched.active { background: rgb(var(--color-green, 166,227,161)); color: rgb(var(--color-background, 17,17,27)); border-color: rgb(var(--color-green, 166,227,161)); box-shadow: 0 4px 12px rgba(var(--color-green, 166,227,161),0.3); }
            .animori-ratings { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px; }
            .rating-item { position:relative; display:inline-flex; align-items:center; gap:7px; padding:6px 12px; border-radius:8px; font-family:inherit; text-decoration:none; transition:transform .15s; background:rgba(var(--rate-c),0.12); border:1px solid rgba(var(--rate-c),0.35); border-left:3px solid rgb(var(--rate-c)); color:rgb(var(--rate-c)); }
            .rating-item:hover { transform:translateY(-3px); }
            .rating-star { font-size:12px; line-height:1; }
            .rating-label { font-size:11px; font-weight:800; letter-spacing:.8px; }
            .rating-value { font-size:14px; font-weight:800; color:rgb(var(--color-text)); }
            .am-histo { position:absolute; right:calc(100% + 10px); left:auto; top:50%; transform:translateY(-50%); display:none; flex-direction:column; width:200px; padding:12px; background:rgba(var(--color-background-200),0.98); border:1px solid rgba(var(--color-text-light),0.18); border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.4); z-index:9999; backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); }
            .rating-item:hover > .am-histo:not(.am-histo-shiki) { display:flex; }
            /* График Shiki к бейджу MAL (не срезается шапкой), по наведению на Shiki */
            .shiki-badge:hover ~ .mal-badge > .am-histo-shiki { display:flex; }
            .am-histo-shiki { --rate-c:224,82,100; }
            .am-histo-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-size:11px; color:rgb(var(--color-text-light)); }
            .am-histo-bars { display:flex; align-items:flex-end; gap:3px; height:56px; }
            .am-histo-bar { flex:1; height:100%; display:flex; align-items:flex-end; }
            .am-histo-fill { width:100%; background:rgb(var(--rate-c, 224 82 100)); border-radius:3px 3px 0 0; min-height:2px; transition:height .2s; }
            .am-histo-axis { display:flex; justify-content:space-between; margin-top:4px; font-size:10px; color:rgb(var(--color-text-light)); }
            .animori-ratings .rating-item.shiki-badge { --rate-c:224,82,100; }
            .animori-ratings .rating-item.mal-badge { --rate-c:90,127,212; }
            .animori-ratings .rating-item.al-badge { --rate-c:61,180,242; }
            .animori-franchise { margin:0 0 20px; background:rgba(var(--color-foreground),1); border-radius:12px; padding:16px; border:1px solid rgba(var(--color-text-light),0.1); box-shadow:0 1px 3px rgba(0,0,0,0.06); }
            .animori-franchise h2 { font-size:1.2rem; margin:0 0 12px; color:rgb(var(--color-text)); font-weight:700; letter-spacing:.3px; }

            .franchise-list { max-height:300px; overflow-y:auto; scroll-behavior:smooth; padding-right:4px; position:relative; transition:max-height .4s ease; display:flex; flex-direction:column; gap:4px; } .franchise-list.expanded { max-height:none; }
            .franchise-list::-webkit-scrollbar, .themes-list::-webkit-scrollbar { width:6px; } .franchise-list::-webkit-scrollbar-track, .themes-list::-webkit-scrollbar-track { background:transparent; } .franchise-list::-webkit-scrollbar-thumb, .themes-list::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; } .franchise-list::-webkit-scrollbar-thumb:hover, .themes-list::-webkit-scrollbar-thumb:hover { background:rgba(var(--am-accent),0.6); }
            .franchise-node { display:flex; gap:10px; padding:8px 10px; border-radius:8px; text-decoration:none !important; border-left:3px solid transparent; align-items:center; transition:background .15s, border-color .15s; background:rgba(var(--color-text-light),0.04); } .franchise-node:hover { background:rgba(var(--color-text-light),0.1); } .franchise-node.active { background:rgba(var(--am-accent),0.12); border-left:3px solid rgb(var(--am-accent)); } .franchise-node.shiki-only { border-left:3px dashed rgba(var(--color-text-light),0.5); opacity:0.8; }
            .node-year { font-size:0.95rem; color:rgb(var(--color-text-light)); min-width:38px; font-weight:600; font-variant-numeric:tabular-nums; } .node-title { font-size:1.15rem; color:rgb(var(--color-text)); flex-grow:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; } .node-kind { font-size:0.85rem; padding:3px 8px; background:rgba(var(--color-text-light),0.12); color:rgb(var(--color-text-light)); border-radius:6px; text-transform:uppercase; font-weight:700; letter-spacing:.5px; flex-shrink:0; }
            .franchise-toggle { display:block; width:100%; text-align:center; padding:9px; margin-top:10px; background:rgba(var(--color-text-light),0.08); border-radius:8px; color:rgb(var(--am-accent)); cursor:pointer; font-weight:600; font-size:1rem; transition:background .15s, border-color .15s; border:1px solid rgba(var(--am-accent),0.25); outline:none; } .franchise-toggle:hover { background:rgba(var(--am-accent),0.12); border-color:rgb(var(--am-accent)); }

            /* ===== AniMori: таймлайн хронологии (scoped на .franchise-list) ===== */
            .franchise-list .franchise-node { position:relative; flex-wrap:wrap; column-gap:8px; row-gap:6px; align-items:center; padding:10px 12px 10px 30px; border-left:none; background:rgba(var(--color-background-100),0.5); border:1px solid rgba(var(--color-text-light),0.1); }
            .franchise-list .franchise-node::before { content:''; position:absolute; left:13px; top:-3px; bottom:-3px; width:2px; background:rgba(var(--am-accent),0.35); }
            .franchise-list .franchise-node:first-child::before { top:50%; }
            .franchise-list .franchise-node:last-child::before { bottom:50%; }
            .franchise-list .franchise-node::after { content:''; position:absolute; left:8px; top:50%; transform:translateY(-50%); width:12px; height:12px; border-radius:50%; background:rgb(var(--color-background-200)); border:2px solid rgba(var(--am-accent),0.7); z-index:1; box-sizing:border-box; }
            .franchise-list .franchise-node:hover { background:rgba(var(--color-text-light),0.1); }
            .franchise-list .franchise-node.active { background:rgba(var(--am-accent),0.12); border-color:rgba(var(--am-accent),0.5); box-shadow:0 4px 18px rgba(var(--am-accent),0.18); }
            .franchise-list .franchise-node.active::after { background:rgb(var(--am-accent)); border-color:rgba(255,255,255,0.6); box-shadow:0 0 12px rgba(var(--am-accent),0.7); }
            .franchise-list .franchise-node.shiki-only { opacity:1; }
            .franchise-list .franchise-node.shiki-only::after { background:rgb(var(--color-foreground)); border-style:dashed; border-color:rgba(var(--color-text-light),0.6); box-shadow:none; }
            .franchise-list .node-title { order:-1; flex-basis:100%; width:100%; white-space:normal; overflow:visible; text-overflow:clip; line-height:1.3; font-weight:600; }
            .franchise-list .franchise-node.active .node-title { font-weight:700; }
            .franchise-list .node-year { min-width:0; padding:2px 9px; border-radius:6px; background:rgba(var(--color-text-light),0.1); font-size:0.85rem; }
            .franchise-list .franchise-node.active .node-year { color:rgb(var(--am-accent)); background:rgba(var(--am-accent),0.16); }

            /* ===== AniMori: акцентные скроллбары (контейнеры тулкита) ===== */
            .franchise-list, .themes-list, #ru-episodes-panel, #ru-translations-panel, #am-log-container, .amk-body, #am-panel { scrollbar-width:thin; scrollbar-color:rgba(var(--am-accent),0.5) transparent; }
            .franchise-list::-webkit-scrollbar, .themes-list::-webkit-scrollbar, #ru-episodes-panel::-webkit-scrollbar, #ru-translations-panel::-webkit-scrollbar, #am-log-container::-webkit-scrollbar, .amk-body::-webkit-scrollbar, #am-panel::-webkit-scrollbar { width:8px; height:8px; }
            .franchise-list::-webkit-scrollbar-track, .themes-list::-webkit-scrollbar-track, #ru-episodes-panel::-webkit-scrollbar-track, #ru-translations-panel::-webkit-scrollbar-track, #am-log-container::-webkit-scrollbar-track, .amk-body::-webkit-scrollbar-track, #am-panel::-webkit-scrollbar-track { background:rgba(var(--color-text-light),0.08); border-radius:8px; }
            .franchise-list::-webkit-scrollbar-thumb, .themes-list::-webkit-scrollbar-thumb, #ru-episodes-panel::-webkit-scrollbar-thumb, #ru-translations-panel::-webkit-scrollbar-thumb, #am-log-container::-webkit-scrollbar-thumb, .amk-body::-webkit-scrollbar-thumb, #am-panel::-webkit-scrollbar-thumb { background:rgba(var(--am-accent),0.45); border-radius:8px; border:2px solid transparent; background-clip:padding-box; }
            .franchise-list::-webkit-scrollbar-thumb:hover, .themes-list::-webkit-scrollbar-thumb:hover, #ru-episodes-panel::-webkit-scrollbar-thumb:hover, #ru-translations-panel::-webkit-scrollbar-thumb:hover, #am-log-container::-webkit-scrollbar-thumb:hover, .amk-body::-webkit-scrollbar-thumb:hover, #am-panel::-webkit-scrollbar-thumb:hover { background:rgba(var(--am-accent),0.8); background-clip:padding-box; }
            .franchise-toggle-top { margin-top:0; margin-bottom:12px; position:sticky; top:0; z-index:2; background:rgba(var(--color-foreground),0.92); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); }
            /* ===== AniMori: внешние ссылки — строки-пилюли ===== */
            .am-extlink { --c:120,130,150; display:flex; align-items:center; gap:12px; padding:9px 12px; border-radius:8px; text-decoration:none !important; background:rgba(var(--c),0.12); border:1px solid rgba(var(--c),0.35); border-left:3px solid rgb(var(--c)); transition:transform .15s, background .15s, border-color .15s; }
            .am-extlink:hover { transform:translateY(-2px); background:rgba(var(--c),0.2); border-color:rgb(var(--c)); }
            .am-extlink-av { width:30px; height:30px; flex-shrink:0; border-radius:8px; display:flex; align-items:center; justify-content:center; background:rgba(var(--c),0.16); border:1px solid rgba(var(--c),0.5); color:rgb(var(--c)); font-weight:800; font-size:14px; }
            .am-extlink-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
            .am-extlink-name { color:rgb(var(--color-text)); font-weight:600; display:flex; align-items:center; gap:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .am-extlink-tag { font-size:9px; text-transform:uppercase; letter-spacing:.5px; padding:1px 5px; border-radius:4px; background:rgba(var(--c),0.2); color:rgb(var(--c)); font-weight:700; flex-shrink:0; }
            .am-extlink-domain { color:rgb(var(--color-text-light)); font-size:0.8rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .am-extlink-arrow { flex-shrink:0; color:rgb(var(--c)); font-size:13px; }
            /* Редактор своих ссылок */
            .am-cl-row { background:rgba(var(--color-background-100),0.5); border:1px solid rgba(var(--color-text-light),0.1); border-radius:10px; padding:10px; margin-bottom:8px; }
            .am-cl-swatches { display:flex; gap:6px; align-items:center; }
            .am-cl-sw { width:20px; height:20px; border-radius:6px; cursor:pointer; border:2px solid transparent; box-sizing:border-box; }
            .am-cl-sw.active { border-color:rgb(var(--color-text)); box-shadow:0 0 0 1px rgba(var(--color-text),0.3); }
            .am-cl-del { flex-shrink:0; }
            .am-service-toggle { display:flex; width:100%; box-sizing:border-box; background:rgba(var(--color-text-light),0.1); border-radius:8px; padding:3px; border:1px solid rgba(var(--color-text-light),0.15); gap:3px; margin:0 auto; } .am-service-btn { flex:1 1 0; min-width:0; display:flex; align-items:center; justify-content:center; padding:8px 0; border-radius:6px; cursor:pointer; transition:all .15s; color:rgb(var(--color-text-light)); user-select:none; } .am-service-btn svg { display:block; } .am-service-btn:hover:not(.active) { color:rgb(var(--color-text)); background:rgba(var(--color-text-light),0.1); } .am-service-btn.active { color:#fff; }
            .am-service-btn.active[data-val="vk"] { background:#3db4f2; box-shadow:0 2px 8px rgba(61,180,242,0.35); }
            .am-service-btn.active[data-val="yt"] { background:rgb(var(--color-red)); box-shadow:0 2px 8px rgba(var(--color-red),0.35); }
            .am-service-btn.active[data-val="spotify"] { background:rgb(var(--color-green)); box-shadow:0 2px 8px rgba(var(--color-green),0.35); }
            .am-service-btn.active[data-val="sc"] { background:rgb(var(--color-orange)); box-shadow:0 2px 8px rgba(var(--color-orange),0.35); }
            /* ===== AniMori: муз. темы — пилюли в стиле бейджей рейтингов ===== */
            .am-theme-track { --tc:var(--am-accent); display:flex; align-items:center; gap:12px; padding:9px 12px; border-radius:8px; text-decoration:none !important; cursor:pointer; background:rgba(var(--tc),0.12); border:1px solid rgba(var(--tc),0.35); border-left:3px solid rgb(var(--tc)); transition:transform .15s, background .15s, border-color .15s; }
            .am-theme-track.is-ed { --tc:var(--color-red); }
            .am-theme-track:hover { transform:translateY(-2px); background:rgba(var(--tc),0.2); border-color:rgb(var(--tc)); }
            .am-theme-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
            .am-theme-title { color:rgb(var(--color-text)); font-weight:600; font-size:1rem; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .am-theme-artist { color:rgb(var(--color-text-light)); font-size:0.92rem; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            /* Лейбл OP/ED и копирование делят позицию слева */
            .am-theme-lead { position:relative; flex-shrink:0; width:30px; height:26px; display:flex; align-items:center; }
            .am-theme-label { font-size:11px; font-weight:800; letter-spacing:.8px; color:rgb(var(--tc)); transition:opacity .16s; }
            .am-theme-copy { position:absolute; inset:0; display:inline-flex; align-items:center; justify-content:flex-start; padding-left:5px; border-radius:6px; color:rgb(var(--tc)); cursor:pointer; opacity:0; pointer-events:none; transition:opacity .16s, background .16s; }
            .am-theme-track:hover .am-theme-label { opacity:0; }
            .am-theme-lead:has(.am-theme-copy.am-copied) .am-theme-label { opacity:0; }
            .am-theme-track:hover .am-theme-copy { opacity:0.85; pointer-events:auto; }
            .am-theme-copy:hover { opacity:1; background:rgba(var(--tc),0.16); }
            .am-theme-copy .am-check-ic { display:none; }
            .am-theme-copy.am-copied { opacity:1 !important; pointer-events:auto; color:rgb(var(--color-green, 102,187,106)); background:rgba(var(--color-green, 102,187,106),0.18); }
            .am-theme-copy.am-copied .am-copy-ic { display:none; }
            .am-theme-copy.am-copied .am-check-ic { display:inline; }
            /* Бегущая строка (ping-pong) при overflow */
            .am-marq { overflow:hidden; }
            .am-marq .am-marq-inner { display:inline-block; white-space:nowrap; will-change:transform; }
            .am-marq.am-marq-on .am-marq-inner { animation: am-marq-pp var(--am-marq-dur, 8s) ease-in-out infinite alternate; }
            @keyframes am-marq-pp { from { transform:translateX(0); } to { transform:translateX(var(--am-marq-shift, 0)); } }
            @media (prefers-reduced-motion: reduce) { .am-marq.am-marq-on .am-marq-inner { animation:none; } }
            body.am-ru-search-active .results .result-col:not(.animori-custom-result-col) { display: none !important; } body.am-ru-search-active .quick-search.visible .results { overflow: visible !important; } .am-ru-injected-container .animori-custom-result-col { flex: 1 1 0 !important; min-width: 0 !important; max-width: none !important; width: auto !important; padding: 0 10px; } .am-ru-loading { text-align: center; padding: 20px; color: rgb(var(--color-text-light)); font-weight: bold; animation: am-pulse 1.5s infinite; width: 100%; } .am-ru-empty { text-align: center; padding: 20px; color: #fc8181; font-weight: bold; width: 100%; } body.am-ru-search-active .am-ru-injected-container { position: fixed !important; left: 50% !important; transform: translateX(-50%); top: 150px; z-index: 200; display: flex; flex-wrap: nowrap; gap: 8px; align-items: flex-start; box-sizing: border-box; width: 92vw; max-width: 1200px; padding: 16px; border-radius: 4px; background: rgb(var(--color-foreground)); box-shadow: 0 4px 30px rgba(0,0,0,.45); max-height: 70vh; overflow-y: auto; }

            #am-logger-overlay { position:fixed; inset:0; z-index:999999; display:flex; justify-content:center; align-items:center; padding:24px; background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); animation:amk-fade .18s ease; }
            .am-logger-modal { background:rgba(var(--color-foreground),0.8); backdrop-filter:blur(22px) saturate(170%); -webkit-backdrop-filter:blur(22px) saturate(170%); color:rgb(var(--color-text)); width:920px; max-width:96vw; height:82vh; border-radius:14px; border:1px solid rgba(var(--color-text-light),0.16); display:flex; flex-direction:column; overflow:hidden; box-shadow:0 12px 44px rgba(0,0,0,0.22); animation:amk-pop .2s cubic-bezier(.2,.8,.2,1); }
            .am-logger-header { padding:14px 18px; border-bottom:1px solid rgba(var(--color-text-light),0.1); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; }
            .am-logger-header h2 { margin:0; color:rgb(var(--color-text)); font-size:15px; font-weight:700; display:flex; align-items:center; gap:9px; }
            #am-log-search { background:rgba(var(--color-background-200),0.7) !important; border:1px solid rgba(var(--color-text-light),0.18) !important; color:rgb(var(--color-text)) !important; }
            .am-logger-filters { display:flex; gap:4px; background:rgba(var(--color-text-light),0.08); padding:4px; border-radius:8px; }
            .am-log-filter { background:transparent; border:none; color:rgb(var(--color-text-light)); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; transition:.15s; } .am-log-filter:hover { background:rgba(var(--color-text-light),0.1); color:rgb(var(--color-text)); } .am-log-filter.active { background:rgba(var(--am-accent),0.18); color:rgb(var(--am-accent)); }
            .am-logger-actions { display:flex; gap:8px; } .am-logger-actions button { background:rgba(var(--color-text-light),0.08); border:1px solid rgba(var(--color-text-light),0.18); color:rgb(var(--color-text)); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; transition:.15s; } .am-logger-actions button:hover { background:rgba(var(--color-text-light),0.15); border-color:rgb(var(--am-accent)); color:rgb(var(--am-accent)); }
            #am-log-close { background:rgba(var(--color-red),0.14) !important; color:rgb(var(--color-red)) !important; border-color:rgba(var(--color-red),0.3) !important; } #am-log-close:hover { background:rgba(var(--color-red),0.24) !important; }
            #am-log-container { flex:1; overflow-y:auto; padding:14px; font-family:"Cascadia Code","Fira Code",Consolas,monospace; font-size:12px; background:rgba(var(--color-background),0.35); }
            #am-log-container::-webkit-scrollbar { width:8px; } #am-log-container::-webkit-scrollbar-thumb { background:rgba(var(--color-text-light),0.25); border-radius:4px; }
            .am-log-entry { margin-bottom:6px; border-radius:8px; background:rgba(var(--color-text-light),0.04); border:1px solid transparent; }
            .am-log-header { padding:8px 12px; display:flex; align-items:center; gap:10px; } .am-log-header:hover { background:rgba(var(--color-text-light),0.06); }
            .am-log-time { color:rgb(var(--color-text-light)); font-size:11px; flex-shrink:0; } .am-log-badge { padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px; flex-shrink:0; width:50px; text-align:center; text-transform:uppercase; } .am-log-msg { color:rgb(var(--color-text)); flex-grow:1; word-break:break-word; } .am-log-expand { color:rgb(var(--color-text-light)); font-size:10px; transition:.2s; user-select:none; }
            .am-log-details { padding:10px 12px; background:rgba(var(--color-background),0.4); border-top:1px solid rgba(var(--color-text-light),0.08); border-radius:0 0 8px 8px; font-family:inherit; font-size:11.5px; line-height:1.4; }
            .am-log-details details summary::-webkit-details-marker { display:none; }
            .type-info .am-log-badge { background:rgba(var(--am-accent),0.15); color:rgb(var(--am-accent)); border:1px solid rgba(var(--am-accent),0.3); } .type-api .am-log-badge { background:rgba(var(--color-purple),0.15); color:rgb(var(--color-purple)); border:1px solid rgba(var(--color-purple),0.3); } .type-db .am-log-badge { background:rgba(var(--color-green),0.15); color:rgb(var(--color-green)); border:1px solid rgba(var(--color-green),0.3); } .type-queue .am-log-badge { background:rgba(var(--color-orange),0.15); color:rgb(var(--color-orange)); border:1px solid rgba(var(--color-orange),0.3); } .type-error .am-log-badge { background:rgba(var(--color-red),0.15); color:rgb(var(--color-red)); border:1px solid rgba(var(--color-red),0.3); } .type-error { border-color:rgba(var(--color-red),0.2); background:rgba(var(--color-red),0.05); }
            /* WARN — жёлтый (--color-orange занят под QUEUE). DEBUG — приглушённый нейтральный. */
            .type-warn .am-log-badge { background:rgba(250,204,21,0.15); color:rgb(250,204,21); border:1px solid rgba(250,204,21,0.35); } .type-warn { border-color:rgba(250,204,21,0.2); background:rgba(250,204,21,0.05); }
            .type-debug .am-log-badge { background:rgba(var(--color-text-light),0.12); color:rgb(var(--color-text-light)); border:1px solid rgba(var(--color-text-light),0.3); }
            .am-log-path { color:rgb(var(--color-text-light)); font-size:10px; max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; background:rgba(var(--color-text-light),0.08); padding:2px 4px; border-radius:4px; cursor:default; }
            .am-log-btn-stack { font-size:10px; color:rgb(var(--color-red)); cursor:pointer; transition:.2s; user-select:none; font-weight:700; background:rgba(var(--color-red),0.1); padding:2px 4px; border-radius:4px; border:1px solid rgba(var(--color-red),0.3); }
            .am-log-btn-stack:hover { background:rgba(var(--color-red),0.24); }
            /* ==== Локальный словарь ==== */
            .amk-tab-count { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; padding:0 5px; margin-left:auto; border-radius:9px; background:rgba(var(--am-accent),0.18); color:rgb(var(--am-accent)); font-size:11px; font-weight:700; }
            .amk-tab.active .amk-tab-count { background:rgba(var(--am-accent),0.28); }
            .am-dict-row { display:flex; gap:8px; align-items:center; }
            .am-dict-row .amk-input { flex:1; }
            .am-dict-del { flex-shrink:0; padding:0 10px; }
            /* Контекстный захват выделения */
            .am-dict-capture { position:absolute; z-index:2147483000; }
            .am-dict-cap-btn { display:inline-flex; align-items:center; gap:6px; background:rgb(var(--am-accent)); color:#fff; border:none; border-radius:8px; padding:6px 10px; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 6px 18px rgba(0,0,0,0.35); }
            .am-dict-cap-btn:hover { filter:brightness(1.08); }
            .am-dict-capform { position:absolute; z-index:2147483000; width:280px; background:rgb(var(--color-background-200,var(--color-foreground))); border:1px solid rgba(var(--color-text-light),0.18); border-radius:12px; padding:12px; box-shadow:0 12px 34px rgba(0,0,0,0.45); }
            .am-dict-capform-head { font-size:12px; font-weight:700; color:rgb(var(--color-text)); margin-bottom:6px; }
            .am-dict-capform-src { font-size:12px; color:rgb(var(--color-text-light)); background:rgba(var(--color-text-light),0.1); padding:6px 8px; border-radius:6px; margin-bottom:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .am-dict-capform-inp { width:100%; margin-bottom:10px; }
            .am-dict-capform-btns { display:flex; gap:8px; justify-content:flex-end; }
        `);

        if (IS_SHIKI) {
            initExporter();
        } else if (IS_ANILIST) {
            const actionsRoot = document.createElement('div'); actionsRoot.id = 'animori-actions'; actionsRoot.classList.add('am-accent-scope'); document.body.appendChild(actionsRoot);
            const btnSet = document.createElement('button'); btnSet.id = 'am-set-btn'; btnSet.className = 'am-premium-btn'; btnSet.innerHTML = '⚙'; btnSet.title = 'Настройки AniMori';
            btnSet.onclick = () => { const p = document.getElementById('am-panel'); p.style.display = window.getComputedStyle(p).display === 'none' ? 'flex' : 'none'; };
            actionsRoot.appendChild(btnSet);

            // Кнопка логгера
            if (settings.enableLogger) {
                const btnLog = document.createElement('button'); btnLog.id = 'am-log-btn'; btnLog.className = 'am-premium-btn'; btnLog.innerHTML = '&lt;/&gt;'; btnLog.title = 'Открыть логгер (AniMori)'; btnLog.onclick = openLoggerModal; actionsRoot.appendChild(btnLog);
            }

            // Кнопка сравнения списков (сканер дельты)
            const btnCmp = document.createElement('button'); btnCmp.id = 'am-cmp-btn'; btnCmp.className = 'am-premium-btn'; btnCmp.innerHTML = '⇄'; btnCmp.title = 'Сравнить списки Shikimori и AniList (AniMori)'; btnCmp.onclick = openCompareModal; actionsRoot.appendChild(btnCmp);

            // sw() — доверенный HTML → rawHTML()
            const sw = (id, on, extra = '') => rawHTML(`<label class="amk-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${extra}><span class="amk-track"></span><span class="amk-thumb"></span></label>`);
            const panel = document.createElement('div'); panel.id = 'am-panel'; panel.classList.add('am-accent-scope');
            panel.innerHTML = html`
                <div class="amk-modal">
                    <div class="amk-head">
                        <h2 class="amk-title"><span class="amk-dot"></span>AniMori <span class="amk-sub">настройки</span></h2>
                        <button class="amk-close" id="am-set-close" title="Закрыть">✕</button>
                    </div>
                    <div class="amk-body amk-tabbed">
                        <nav class="amk-tabnav">
                            <button type="button" class="amk-tab active" data-tab="translate"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/></svg></span>Перевод</button>
                            <button type="button" class="amk-tab" data-tab="dict"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></span>Словарь<span class="amk-tab-count" id="am-dict-count" hidden>0</span></button>
                            <button type="button" class="amk-tab" data-tab="modules"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg></span>Модули</button>
                            <button type="button" class="amk-tab" data-tab="appearance"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z"/></svg></span>Оформление</button>
                            <button type="button" class="amk-tab" data-tab="links"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-2 2"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l2-2"/></svg></span>Ссылки</button>
                            <button type="button" class="amk-tab" data-tab="account"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="M16 7l3 3"/></svg></span>Аккаунт</button>
                            <button type="button" class="amk-tab" data-tab="misc"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg></span>Прочее</button>
                            <button type="button" class="amk-tab" data-tab="support"><span class="amk-tab-ic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg></span>Поддержать</button>
                        </nav>
                        <div class="amk-tabpanes">
                        <div class="amk-pane active" data-pane="translate">
                        <div class="amk-card">
                            <div class="amk-card-title">Перевод</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Интерфейс</b></span>${sw('set_interface', settings.translateInterface)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Тайтлы и описания</b><span class="amk-row-hint">основной источник · фоллбэк</span></span></div>
                            <div class="amk-row" style="gap:8px; border-top:none; padding-top:0;">
                                <select class="amk-select" id="set_title_primary" style="flex:1;">
                                    <option value="shikimori">Shikimori</option>
                                    <option value="anime365">anime365</option>
                                    <option value="off">Выключено (оригинал)</option>
                                </select>
                                <select class="amk-select" id="set_title_fallback" style="flex:1;">
                                    <option value="none">Без фоллбэка</option>
                                    <option value="shikimori">Shikimori</option>
                                    <option value="anime365">anime365</option>
                                </select>
                            </div>
                            <div class="amk-row"><span class="amk-row-label"><b>Персонажи</b><span class="amk-row-hint">с Shikimori</span></span>${sw('set_chars', settings.translateCharacters)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Персонал</b><span class="amk-row-hint">с Shikimori</span></span>${sw('set_staff', settings.translateStaff)}</div>
                        </div>
                        </div>
                        <div class="amk-pane am-notr" data-pane="dict">
                        <div class="amk-card">
                            <div class="amk-card-title">Локальный словарь</div>
                            <div class="amk-row-hint" style="padding:2px 2px 8px; line-height:1.5;">Свои переводы поверх общего словаря. Применяются на странице сразу, без перезагрузки. Регистр сохраняется.</div>
                            <div style="display:flex; gap:8px; margin-bottom:8px;">
                                <input class="amk-input" id="am-dict-src" placeholder="Оригинал (англ.)" style="flex:1;">
                                <input class="amk-input" id="am-dict-tr" placeholder="Перевод (рус.)" style="flex:1;">
                                <button class="amk-btn amk-btn-primary" id="am-dict-add">＋</button>
                            </div>
                            <input class="amk-input" id="am-dict-search" placeholder="Поиск по своим записям…" style="margin-bottom:8px;">
                            <div id="am-dict-list" style="display:flex; flex-direction:column; gap:6px; max-height:260px; overflow:auto;"></div>
                            <div id="am-dict-empty" class="amk-row-hint" style="padding:14px 2px; text-align:center; display:none;">Пока нет своих записей. Добавьте перевод выше или выделите текст на странице.</div>
                        </div>
                        <div class="amk-card">
                            <div class="amk-card-title">Импорт / Экспорт</div>
                            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                                <button class="amk-btn amk-btn-ghost" id="am-dict-export" style="flex:1;">Экспорт</button>
                                <button class="amk-btn amk-btn-ghost" id="am-dict-import" style="flex:1;">Импорт</button>
                                <button class="amk-btn amk-btn-ghost" id="am-dict-copy" style="flex:1;">Копировать</button>
                            </div>
                            <button class="amk-btn amk-btn-primary amk-btn-block" id="am-dict-share" style="margin-top:8px; display:inline-flex; align-items:center; justify-content:center; gap:8px;"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>Предложить в общую базу</button>
                            <div class="amk-row-hint" style="padding:8px 2px 2px; line-height:1.5;">Экспорт скачивает JSON, «Копировать» кладёт его в буфер для отправки другим. Импорт объединяет с текущими записями.</div>
                        </div>
                        </div>
                        <div class="amk-pane" data-pane="modules">
                        <div class="amk-card">
                            <div class="amk-card-title">Модули</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Аниме-плеер</b></span>${sw('set_player', settings.enablePlayer)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Рейтинги MAL и Shiki</b></span>${sw('set_ratings', settings.enableRatings)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Дерево франшизы</b></span>${sw('set_franchise', settings.enableFranchise)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Музыкальные темы</b></span>${sw('set_themes', settings.enableThemes)}</div>
                        </div>
                        </div>
                        <div class="amk-pane" data-pane="appearance">
                        <div class="amk-card">
                            <div class="amk-card-title">Оформление</div>
                            <div class="amk-row-hint" style="padding:2px 2px 8px;">Акцентный цвет тулкита — тему AniList не меняет</div>
                            <div class="amk-accents" id="am-accent-chips"></div>
                        </div>
                        </div>
                        <div class="amk-pane" data-pane="links">
                        <div class="amk-card">
                            <div class="amk-card-title">Внешние ссылки</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Показывать ссылки</b></span>${sw('set_extlinks', settings.enableExtLinks)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>RuTracker</b></span>${sw('set_link_rutracker', settings.enableLinkRutracker)}</div>
                            <div class="amk-row"><span class="amk-row-label"><b>YummyAnime</b></span>${sw('set_link_yummy', settings.enableLinkYummy)}</div>
                            <input class="amk-input amk-mono" id="set_yummy_domain" placeholder="yummyanime.tv" style="margin:2px 0 8px;">
                            <div class="amk-row"><span class="amk-row-label"><b>AnimeGO</b></span>${sw('set_link_animego', settings.enableLinkAnimego)}</div>
                            <input class="amk-input amk-mono" id="set_animego_domain" placeholder="animego.org" style="margin:2px 0 8px;">
                            <div class="amk-row"><span class="amk-row-label"><b>MangaLib</b></span>${sw('set_link_mangalib', settings.enableLinkMangalib)}</div>
                            <input class="amk-input amk-mono" id="set_mangalib_domain" placeholder="mangalib.me" style="margin:2px 0 6px;">
                        </div>
                        <div class="amk-card">
                            <div class="amk-card-title">Свои ссылки</div>
                            <div id="am-custom-links-list" style="display:flex; flex-direction:column; gap:10px;"></div>
                            <button class="amk-btn amk-btn-ghost" id="am-custom-add" style="width:100%; margin-top:10px;">＋ Добавить свою ссылку</button>
                            <div class="amk-row-hint" style="padding:10px 2px 2px; line-height:1.5;">В URL-шаблоне подставляются: <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;">{ru}</code> — русское название, <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;">{romaji}</code> — ромадзи, <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;">{query}</code> — авто (ru → romaji). Всё кодируется автоматически.</div>
                        </div>
                        </div>
                        <div class="amk-pane" data-pane="account">
                        <div class="amk-card">
                            <div class="amk-card-title">Авторизация AniList</div>
                            <div class="amk-row-hint" style="padding:8px 2px 6px;">Токен нужен для экспорта и сравнения списков. Создайте Client <a href="https://anilist.co/settings/developer" target="_blank" style="color:rgb(var(--color-blue));text-decoration:none;">здесь</a>, redirect URL: <code style="background:rgba(var(--color-text-light),0.12);padding:1px 5px;border-radius:4px;">https://anilist.co/api/v2/oauth/pin</code></div>
                            <input class="amk-input amk-mono" type="password" id="set_al_token" placeholder="Токен AniList" style="margin-bottom:8px;">
                            <div style="display:flex; gap:8px; margin-bottom:6px;"><input class="amk-input amk-mono" id="set_al_client" placeholder="Client ID" style="flex:1;"><button class="amk-btn amk-btn-ghost" id="set_al_gen" title="Создать ссылку авторизации">Ссылка</button></div>
                            <div id="set_al_link_wrap" style="text-align:center; font-size:12px;"></div>
                        </div>
                        </div>
                        <div class="amk-pane" data-pane="misc">
                        <div class="amk-card">
                            <div class="amk-card-title">Прочее</div>
                            <div class="amk-row"><span class="amk-row-label"><b>Логгер</b><span class="amk-row-hint">отслеживание действий скрипта (для отладки)</span></span>${sw('set_logger', settings.enableLogger)}</div>
                        </div>
                        </div>
                        <div class="amk-pane" data-pane="support">
                        <div class="amk-card">
                            <div class="amk-card-title">Поддержать проект</div>
                            <div class="amk-row-hint" style="padding:2px 2px 10px; line-height:1.55;">AniMori — бесплатный проект, я делаю его из любви к японским мультикам. Денег не нужно. Если тулкит вам пригодился, лучшая благодарность — пара действий ниже. Это правда помогает.</div>
                            <button class="amk-btn amk-btn-primary amk-btn-block" id="am-sup-star" style="margin-bottom:8px; gap:8px;"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>Star на GitHub</button>
                            <button class="amk-btn amk-btn-ghost amk-btn-block" id="am-sup-review" style="margin-bottom:8px; gap:8px;"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Оценить на Greasy Fork</button>
                            <div class="amk-row-hint" style="padding:2px 2px 6px; line-height:1.5;">Отзыв двигает скрипт в выдаче — так его находят новые пользователи.</div>
                        </div>
                        <div class="amk-card">
                            <div class="amk-card-title">Поделиться</div>
                            <div class="amk-row-hint" style="padding:2px 2px 8px; line-height:1.5;">Рассказать друзьям — тоже поддержка. Ссылка на установку:</div>
                            <div style="display:flex; gap:8px;">
                                <input class="amk-input amk-mono" id="am-sup-link" readonly value="https://greasyfork.org/scripts/572948" style="flex:1;">
                                <button class="amk-btn amk-btn-primary" id="am-sup-copy" style="gap:7px;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Копировать</span></button>
                            </div>
                        </div>
                        </div>
                        </div>
                    </div>
                    <div class="amk-foot">
                        <button class="amk-btn amk-btn-primary amk-btn-block" id="am-apply">Применить и перезагрузить</button>
                        <button class="amk-btn amk-btn-danger" id="am-clear">Очистить кэш</button>
                    </div>
                </div>
            `;
            document.body.appendChild(panel);

            // Переключение вкладок настроек
            panel.querySelectorAll('.amk-tab').forEach(tb => {
                tb.onclick = () => {
                    const key = tb.dataset.tab;
                    panel.querySelectorAll('.amk-tab').forEach(x => x.classList.toggle('active', x === tb));
                    panel.querySelectorAll('.amk-pane').forEach(pn => pn.classList.toggle('active', pn.dataset.pane === key));
                };
            });

            // Вкладка «Поддержать»
            const SUP_GITHUB = 'https://github.com/foulnike/AniMori-AniList-Toolkit';
            const SUP_GREASY = 'https://greasyfork.org/scripts/572948';
            const supStar = document.getElementById('am-sup-star');
            if (supStar) supStar.onclick = () => window.open(SUP_GITHUB, '_blank', 'noopener');
            const supReview = document.getElementById('am-sup-review');
            if (supReview) supReview.onclick = () => window.open(SUP_GREASY + '/feedback', '_blank', 'noopener');
            const supCopy = document.getElementById('am-sup-copy');
            if (supCopy) supCopy.onclick = () => {
                amCopy(SUP_GREASY, supCopy);
                const lbl = supCopy.querySelector('span');
                if (lbl) { const prev = lbl.textContent; lbl.textContent = 'Скопировано ✓'; setTimeout(() => { lbl.textContent = prev; }, 1200); }
            };

            // Чипы выбора акцента
            const accWrap = document.getElementById('am-accent-chips');
            if (accWrap) {
                Object.keys(AM_ACCENTS).forEach(key => {
                    const a = AM_ACCENTS[key];
                    const chip = document.createElement('button');
                    chip.type = 'button';
                    chip.className = 'am-accent-chip' + (settings.accentPreset === key ? ' active' : '');
                    chip.dataset.key = key;
                    chip.innerHTML = `<span class="am-accent-dot" style="background:${a.dot};"></span>${a.name}`;
                    chip.onclick = () => {
                        settings.accentPreset = key;
                        GM_setValue('am_accent', key);
                        accWrap.querySelectorAll('.am-accent-chip').forEach(c => c.classList.remove('active'));
                        chip.classList.add('active');
                        amSetAccent(key);
                    };
                    accWrap.appendChild(chip);
                });
            }
            // Сохранённый акцент к контейнерам (FAB, панель)
            amSetAccent(settings.accentPreset);

            document.getElementById('set_yummy_domain').value = settings.yummyDomain; document.getElementById('set_animego_domain').value = settings.animegoDomain; document.getElementById('set_mangalib_domain').value = settings.mangalibDomain;

            // Источники перевода тайтлов: значения + связка (фоллбэк != основной).
            { const tp = document.getElementById('set_title_primary'), tf = document.getElementById('set_title_fallback');
              if (tp && tf) {
                tp.value = settings.titlePrimary; tf.value = settings.titleFallback;
                const syncTitleSrc = () => {
                    const off = tp.value === 'off';
                    tf.disabled = off;
                    Array.from(tf.options).forEach(o => { o.disabled = (o.value !== 'none' && o.value === tp.value); });
                    if (off || tf.value === tp.value) tf.value = 'none';
                };
                syncTitleSrc();
                tp.onchange = () => { GM_setValue('set_title_primary', tp.value); syncTitleSrc(); GM_setValue('set_title_fallback', tf.value); };
                tf.onchange = () => { GM_setValue('set_title_fallback', tf.value); };
              }
            }

            // Закрытие: клик по оверлею или ✕.
            panel.addEventListener('click', (e) => { if (e.target === panel) panel.style.display = 'none'; });
            { const c = document.getElementById('am-set-close'); if (c) c.onclick = () => { panel.style.display = 'none'; }; }

            // Сохранение настроек
            const booleanSettings =['set_interface', 'set_chars', 'set_staff', 'set_player', 'set_ratings', 'set_franchise', 'set_themes', 'set_extlinks', 'set_link_rutracker', 'set_link_yummy', 'set_link_animego', 'set_link_mangalib', 'set_logger'];
            booleanSettings.forEach(id => { const el = document.getElementById(id); if (el) el.onchange = (e) => GM_setValue(id, e.target.checked); });

            const textSettings =['set_yummy_domain', 'set_animego_domain', 'set_mangalib_domain'];
            textSettings.forEach(id => { const el = document.getElementById(id); if (el) el.onchange = (e) => GM_setValue(id, e.target.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')); });

            // Редактор своих ссылок
            const renderCustomLinksEditor = () => {
                const list = document.getElementById('am-custom-links-list');
                if (!list) return;
                const links = getCustomLinks();
                list.innerHTML = '';
                links.forEach((cl, idx) => {
                    const row = document.createElement('div'); row.className = 'am-cl-row';
                    const top = document.createElement('div'); top.style.cssText = 'display:flex; gap:8px; align-items:center;';
                    const nameIn = document.createElement('input'); nameIn.className = 'amk-input'; nameIn.placeholder = 'Название'; nameIn.value = cl.name || ''; nameIn.style.flex = '1';
                    const del = document.createElement('button'); del.className = 'amk-btn amk-btn-ghost am-cl-del'; del.textContent = '✕'; del.title = 'Удалить';
                    top.append(nameIn, del);
                    const urlIn = document.createElement('input'); urlIn.className = 'amk-input amk-mono'; urlIn.placeholder = 'https://site.com/search?q={query}'; urlIn.value = cl.url || ''; urlIn.style.marginTop = '6px';
                    const sw = document.createElement('div'); sw.className = 'am-cl-swatches';
                    CL_COLORS.forEach(c => {
                        const s2 = document.createElement('span'); s2.className = 'am-cl-sw' + (cl.color === c ? ' active' : '');
                        s2.style.background = `rgb(${c})`;
                        s2.onclick = () => { const arr = getCustomLinks(); if (arr[idx]) { arr[idx].color = c; setCustomLinks(arr); renderCustomLinksEditor(); } };
                        sw.appendChild(s2);
                    });
                    const save = () => { const arr = getCustomLinks(); if (arr[idx]) { arr[idx].name = nameIn.value.trim(); arr[idx].url = urlIn.value.trim(); setCustomLinks(arr); } };
                    nameIn.onchange = save; urlIn.onchange = save;
                    del.onclick = () => { const arr = getCustomLinks(); arr.splice(idx, 1); setCustomLinks(arr); renderCustomLinksEditor(); };
                    row.append(top, urlIn, sw);
                    list.appendChild(row);
                });
            };
            renderCustomLinksEditor();
            { const addBtn = document.getElementById('am-custom-add'); if (addBtn) addBtn.onclick = () => { const arr = getCustomLinks(); arr.push({ name: '', url: '', color: CL_COLORS[arr.length % CL_COLORS.length] }); setCustomLinks(arr); renderCustomLinksEditor(); }; }

            // ==== Редактор локального словаря ====
            const dictListEl = document.getElementById('am-dict-list');
            const dictEmptyEl = document.getElementById('am-dict-empty');
            const dictSearchEl = document.getElementById('am-dict-search');
            const renderDictEditor = () => {
                if (!dictListEl) return;
                const ud = getUserDict();
                const total = Object.keys(ud).length;
                const badge = document.getElementById('am-dict-count');
                if (badge) { badge.textContent = String(total); badge.hidden = total === 0; }
                const q = normDictKey(dictSearchEl ? dictSearchEl.value : '').toLowerCase();
                const keys = Object.keys(ud).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                    .filter(k => !q || k.toLowerCase().includes(q) || String(ud[k]).toLowerCase().includes(q));
                dictListEl.innerHTML = '';
                if (dictEmptyEl) dictEmptyEl.style.display = Object.keys(ud).length ? 'none' : 'block';
                keys.forEach(k => {
                    const row = document.createElement('div'); row.className = 'am-dict-row';
                    const srcIn = document.createElement('input'); srcIn.className = 'amk-input'; srcIn.value = k; srcIn.style.flex = '1';
                    const trIn = document.createElement('input'); trIn.className = 'amk-input'; trIn.value = ud[k]; trIn.style.flex = '1';
                    const del = document.createElement('button'); del.className = 'amk-btn amk-btn-ghost am-dict-del'; del.textContent = '✕'; del.title = 'Удалить';
                    const commit = () => {
                        const nk = normDictKey(srcIn.value), nv = normDictKey(trIn.value);
                        if (!nk || !nv) return;
                        if (nk !== k) removeUserDictEntry(k);
                        upsertUserDictEntry(nk, nv);
                        if (nk !== k) renderDictEditor();
                    };
                    srcIn.onchange = commit; trIn.onchange = commit;
                    del.onclick = () => { removeUserDictEntry(k); renderDictEditor(); };
                    row.append(srcIn, trIn, del);
                    dictListEl.appendChild(row);
                });
            };
            if (dictSearchEl) dictSearchEl.oninput = renderDictEditor;
            renderDictEditor();
            {
                const addBtn = document.getElementById('am-dict-add');
                const srcEl = document.getElementById('am-dict-src');
                const trEl = document.getElementById('am-dict-tr');
                if (addBtn && srcEl && trEl) {
                    addBtn.onclick = () => {
                        if (upsertUserDictEntry(srcEl.value, trEl.value)) {
                            srcEl.value = ''; trEl.value = ''; srcEl.focus(); renderDictEditor();
                        }
                    };
                    trEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
                }
                const expBtn = document.getElementById('am-dict-export');
                if (expBtn) expBtn.onclick = () => {
                    const data = JSON.stringify(getUserDict(), null, 2);
                    const blob = new Blob([data], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = 'animori-dictionary.json';
                    document.body.appendChild(a); a.click(); a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 2000);
                };
                const copyBtn = document.getElementById('am-dict-copy');
                if (copyBtn) copyBtn.onclick = () => {
                    try { GM_setClipboard(JSON.stringify(getUserDict(), null, 2)); const t = copyBtn.textContent; copyBtn.textContent = '✓ Скопировано'; setTimeout(() => copyBtn.textContent = t, 1400); } catch (e) { /* noop */ }
                };
                const impBtn = document.getElementById('am-dict-import');
                if (impBtn) impBtn.onclick = () => {
                    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
                    inp.onchange = () => {
                        const f = inp.files && inp.files[0]; if (!f) return;
                        const fr = new FileReader();
                        fr.onload = () => {
                            try {
                                const obj = JSON.parse(String(fr.result));
                                if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bad');
                                const ud = getUserDict();
                                Object.keys(obj).forEach(k => { const nk = normDictKey(k), nv = normDictKey(obj[k]); if (nk && nv) ud[nk] = nv; });
                                setUserDict(ud); rebuildDictionary();
                                if (typeof amRetranslate === 'function') amRetranslate();
                                renderDictEditor();
                            } catch (e) { alert('Не удалось разобрать файл словаря (ожидается JSON вида {"English":"Русский"}).'); }
                        };
                        fr.readAsText(f);
                    };
                    inp.click();
                };
                const shareBtn = document.getElementById('am-dict-share');
                if (shareBtn) shareBtn.onclick = () => {
                    const ud = getUserDict();
                    const n = Object.keys(ud).length;
                    if (!n) { alert('Пока нечем делиться — добавьте хотя бы одну запись.'); return; }
                    const json = JSON.stringify(ud, null, 2);
                    const title = `[Словарь] ${n} ${n === 1 ? 'запись' : (n < 5 ? 'записи' : 'записей')} от пользователя`;
                    const body = `Предлагаю добавить эти переводы в общий словарь AniMori:\n\n\u0060\u0060\u0060json\n${json}\n\u0060\u0060\u0060\n`;
                    const base = 'https://github.com/foulnike/AniMori-AniList-Toolkit/issues/new';
                    const url = `${base}?title=${encodeURIComponent(title)}&labels=dictionary&body=${encodeURIComponent(body)}`;
                    // Лимит URL GitHub (~8 КБ): большой словарь → JSON в буфер, открываем пустую форму issue.
                    if (url.length > 7000) {
                        try { GM_setClipboard(json); } catch (e) { /* noop */ }
                        const short = `${base}?title=${encodeURIComponent(title)}&labels=dictionary&body=${encodeURIComponent('Словарь скопирован в буфер обмена — вставьте его сюда внутри блока \u0060\u0060\u0060json ... \u0060\u0060\u0060')}`;
                        alert('Словарь большой и не помещается в ссылку — он скопирован в буфер обмена. Откроется форма issue, вставьте (Ctrl+V) содержимое в тело.');
                        window.open(short, '_blank');
                    } else {
                        window.open(url, '_blank');
                    }
                };
            }

            const tokenInput = document.getElementById('set_al_token');
            if (tokenInput) { tokenInput.value = GM_getValue("AL_TOKEN", ""); tokenInput.onchange = (e) => GM_setValue("AL_TOKEN", e.target.value.trim()); }

            const genBtn = document.getElementById('set_al_gen');
            if (genBtn) {
                genBtn.onclick = () => {
                    const cid = document.getElementById('set_al_client').value.trim();
                    if (!cid) return alert("Введите Client ID (его можно создать в настройках AniList -> Developer)");
                    const authLink = document.createElement('a');
                    authLink.href = `https://anilist.co/api/v2/oauth/authorize?client_id=${cid}&response_type=token`;
                    authLink.target = "_blank"; authLink.style.cssText = "color:rgb(var(--color-blue)); text-decoration:none; font-weight:bold; display:block; padding:6px; border:1px dashed rgb(var(--color-blue)); border-radius:6px; margin-top:5px; transition: 0.2s;";
                    authLink.textContent = "👉 Клик: Перейти к авторизации";
                    const wrap = document.getElementById('set_al_link_wrap'); wrap.innerHTML = ''; wrap.appendChild(authLink);
                };
            }

            document.getElementById('am-apply').onclick = () => { location.reload(); };
            document.getElementById('am-clear').onclick = async () => { await clearCache(); alert('Кэш сброшен!'); location.reload(); };

            await openDB();

            // Старт перевода + загрузка словаря
            if (settings.translateInterface || settings.translateTitles || settings.translateCharacters || settings.translateStaff) {
                Logger('API', 'Загрузка словаря интерфейса...');
                GM_xmlhttpRequest({
                    method: "GET", url: DICT_URL,
                    onload: (res) => {
                        if (res.status === 200) { try { remoteDict = Object.assign(Object.create(null), JSON.parse(res.responseText)); Logger('INFO', 'Словарь загружен и распарсен'); } catch (e) { Logger('ERROR', 'Ошибка парсинга словаря', e); } }
                        rebuildDictionary();
                        initTranslator();
                    },
                    onerror: (e) => { Logger('ERROR', 'Сетевая ошибка при загрузке словаря', e); rebuildDictionary(); initTranslator(); }
                });
            } else { rebuildDictionary(); initTranslator(); }

            initRussianSearch();
            initDictCapture();

            // Перехват SPA-навигации → инъекция виджетов
            const originalPushState = history.pushState;
            history.pushState = function() {
                originalPushState.apply(this, arguments);
                Logger('INFO', `[Router] Переход по ссылке на ${location.pathname}`);
                setTimeout(injectMediaExtensions, 50);
            };

            const originalReplaceState = history.replaceState;
            history.replaceState = function() {
                originalReplaceState.apply(this, arguments);
                Logger('INFO', `[Router] Обновление роута ${location.pathname}`);
                setTimeout(injectMediaExtensions, 50);
            };

            window.addEventListener('popstate', () => {
                Logger('INFO', `[Router] Кнопка Назад/Вперед ➜ ${location.pathname}`);
                setTimeout(injectMediaExtensions, 50);
            });

            // Страховочный пулинг URL
            let lastUrl = location.href;
            setInterval(() => {
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    const path = location.pathname.split('/');
                    if (!(path[1] === 'anime' || path[1] === 'manga')) {
                        document.querySelectorAll('.animori-ratings, .animori-franchise, .animori-themes, .animori-extlinks').forEach(el => el.remove());
                        const playBtn = document.getElementById('ru-player-btn'); if (playBtn) playBtn.style.display = 'none';
                        const iframe = document.getElementById('ru-p-iframe'); if (iframe) iframe.src = '';
                    }
                    injectMediaExtensions();
                }
            }, 800);

            injectMediaExtensions();

            // Очистка старого кэша через 15с
            setTimeout(runGarbageCollector, 15000);
        }
    }

    // Запуск
    init();
})();