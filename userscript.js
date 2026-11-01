// ==UserScript==
// @name         Apple Music 歌词增强
// @namespace    https://github.com/akashiwest/AML-Enhancer
// @version      1.300
// @description  为网页版 Apple Music 提供翻译歌词，数据来源为网易云音乐
// @author       Akashi
// @license      GNU GPL 3.0
// @match        https://*.music.apple.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      music.163.com
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // 只在顶层页面运行，避免 iframe 里重复创建歌词窗口
    if (window.top !== window.self) return;

    /* ==================================================================
     * 常量
     * ================================================================== */
    const VERSION = '1.3.0';
    const ABOUT_URL = 'https://imakashi.com/blog/archives/AML_Enhancer.html';
    const PLAYER_ID = 'apple-music-player';

    const HEIGHT_MIN = 150;   // 缩小时窗口总高度（含底部按钮栏）
    const HEIGHT_MAX = 280;   // 放大时窗口总高度

    const KEY_OFFSETS = 'lyricsOffsets';   // 沿用旧版键名，保留已有的偏移数据
    const KEY_SETTINGS = 'aml_settings';
    const KEY_MATCHES = 'aml_matches';
    const KEY_STATS = 'aml_stats';
    const KEY_TCACHE = 'aml_tcache';        // 机器翻译缓存

    const MATCH_LIMIT_STEPS = [0, 20, 50, 100, 200, 500, 1000];
    const FONT_SCALE_MIN = 70;
    const FONT_SCALE_MAX = 160;
    const STATS_KEEP_DAYS = 90;

    const DEFAULT_SETTINGS = {
        fontScale: 100,        // 字体大小百分比
        blur: true,            // 模糊非当前歌词
        showTranslation: true, // 显示翻译
        autoTranslate: true,   // 没有翻译时用浏览器内置翻译自动翻译
        theme: 'auto',         // auto | light | dark
        maxMatches: 200,       // 最多记住多少首手动匹配（0 = 不再记住新的）
        minimized: true,       // 窗口是否处于缩小状态
        pos: null              // 拖动后的位置 {left, top}
    };

    /* ==================================================================
     * 存储
     * ================================================================== */
    const store = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                if (!raw) return fallback;
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object' ? parsed : fallback;
            } catch (e) {
                console.error('[AML] 读取存储失败:', key, e);
                return fallback;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (e) {
                console.error('[AML] 写入存储失败:', key, e);
            }
        }
    };

    const settings = Object.assign({}, DEFAULT_SETTINGS, store.get(KEY_SETTINGS, {}));
    function saveSettings() { store.set(KEY_SETTINGS, settings); }

    // ---- 每首歌的时间偏移 ----
    function saveOffset(title, offset) {
        if (!title) return;
        const all = store.get(KEY_OFFSETS, {});
        if (offset === 0) delete all[title]; else all[title] = offset;
        store.set(KEY_OFFSETS, all);
    }
    function loadOffset(title) {
        if (!title) return 0;
        const v = store.get(KEY_OFFSETS, {})[title];
        return typeof v === 'number' ? v : 0;
    }

    // ---- 手动匹配记忆（标题 -> 网易云歌曲） ----
    function getMatch(title) {
        return store.get(KEY_MATCHES, {})[title] || null;
    }
    function countMatches() {
        return Object.keys(store.get(KEY_MATCHES, {})).length;
    }
    function saveMatch(title, song) {
        if (!title || settings.maxMatches <= 0) return;
        const all = store.get(KEY_MATCHES, {});
        all[title] = { id: song.id, name: song.name, artist: song.artist, t: Date.now() };
        const keys = Object.keys(all);
        if (keys.length > settings.maxMatches) {
            // 超出上限：淘汰最久没用过的
            keys.sort((a, b) => all[b].t - all[a].t)
                .slice(settings.maxMatches)
                .forEach(k => delete all[k]);
        }
        store.set(KEY_MATCHES, all);
    }
    function touchMatch(title) {
        const all = store.get(KEY_MATCHES, {});
        if (all[title]) {
            all[title].t = Date.now();
            store.set(KEY_MATCHES, all);
        }
    }
    function removeMatch(title) {
        const all = store.get(KEY_MATCHES, {});
        if (title in all) {
            delete all[title];
            store.set(KEY_MATCHES, all);
        }
    }

    /* ==================================================================
     * 听歌统计（按天累计实际播放秒数）
     * ================================================================== */
    let pending = {};   // 尚未写入存储的增量：{ 'YYYY-MM-DD': { s, songs: {title: sec} } }
    let lastTick = 0;

    function pad2(n) { return String(n).padStart(2, '0'); }
    function dayKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
    function startOfWeek(d) {          // 周一为一周的开始
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
        return x;
    }

    function readStats() {
        const s = store.get(KEY_STATS, { days: {} });
        if (!s.days || typeof s.days !== 'object') s.days = {};
        return s;
    }
    function mergePending(stats) {
        for (const [k, p] of Object.entries(pending)) {
            const d = stats.days[k] || (stats.days[k] = { s: 0, songs: {} });
            if (!d.songs) d.songs = {};
            d.s = (d.s || 0) + p.s;
            for (const [t, sec] of Object.entries(p.songs)) d.songs[t] = (d.songs[t] || 0) + sec;
        }
        return stats;
    }
    function flushStats() {
        if (Object.keys(pending).length === 0) return;
        // 先读后写再合并增量，避免多个标签页互相覆盖
        const stats = mergePending(readStats());
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - STATS_KEEP_DAYS);
        const cutoffKey = dayKey(cutoff);
        Object.keys(stats.days).forEach(k => { if (k < cutoffKey) delete stats.days[k]; });
        store.set(KEY_STATS, stats);
        pending = {};
    }
    function addPlaytime(sec) {
        const k = dayKey(new Date());
        const p = pending[k] || (pending[k] = { s: 0, songs: {} });
        p.s += sec;
        if (currentSongTitle) p.songs[currentSongTitle] = (p.songs[currentSongTitle] || 0) + sec;
    }
    function tickStats(audio) {
        if (audio.paused || audio.ended) { lastTick = 0; return; }
        const now = Date.now();
        if (lastTick) {
            const dt = (now - lastTick) / 1000;
            if (dt > 0 && dt < 3) addPlaytime(dt);   // 过大的间隔（暂停/拖动/休眠）不计入
        }
        lastTick = now;
    }
    // 标题形如「歌名 - 艺人」，取第一个分隔符之后的部分作为艺人；没有分隔符则无法判断
    function artistOf(title) {
        let i = title.indexOf(' - ');
        const sepLen = i === -1 ? 1 : 3;
        if (i === -1) i = title.indexOf('-');
        return i === -1 ? '' : title.slice(i + sepLen).trim();
    }
    function getStatsSummary() {
        const stats = mergePending(readStats());
        const now = new Date();
        const today = dayKey(now);
        const weekStart = dayKey(startOfWeek(now));
        let week = 0, todaySec = 0;
        const artists = {};
        for (const [k, d] of Object.entries(stats.days)) {
            if (k >= weekStart) {
                week += d.s || 0;
                for (const [t, sec] of Object.entries(d.songs || {})) {
                    const artist = artistOf(t);
                    if (artist) artists[artist] = (artists[artist] || 0) + sec;
                }
            }
            if (k === today) todaySec = d.s || 0;
        }
        let top = '';
        let topSec = 0;
        for (const [name, sec] of Object.entries(artists)) {
            if (sec > topSec) { top = name; topSec = sec; }
        }
        return { week, today: todaySec, top };
    }
    function fmtDuration(sec) {
        const m = Math.round(sec / 60);
        if (sec > 0 && m === 0) return '不足 1 分钟';
        if (m < 60) return `${m} 分钟`;
        return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
    }
    function fmtMs(ms) {
        const s = Math.round((ms || 0) / 1000);
        return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
    }

    /* ==================================================================
     * 运行状态
     * ================================================================== */
    let currentSongTitle = '';
    let currentSongId = null;
    let currentLyrics = [];       // [{ startTime, text }]
    let translations = [];        // 与 currentLyrics 一一对应的翻译文本
    let lyricsOffset = 0;         // 用户手动设置的时间偏移（秒）
    let songStartOffset = 0;      // 播放器时间轴上当前歌曲的起点（秒）
    let activeIndex = -1;
    let lastTime = 0;
    let loadToken = 0;            // 用于丢弃过期的网络响应
    let hasHumanTranslation = false;   // 网易云提供了翻译
    let machineTranslated = false;     // 当前翻译来自浏览器内置翻译
    let translatingId = null;          // 正在翻译的歌曲 ID，防止重复触发
    let translatorInfo = null;         // 当前这首歌的翻译检测结果，用于在菜单里显示
    let lineLangs = [];                // 每一行歌词的语言（null = 不需要翻译）
    let machinePending = [];           // 还没翻译的语言（语言包没下载 / 创建失败）

    /* ==================================================================
     * 样式
     * ================================================================== */
    const DARK_VARS = `
        --aml-bg: rgba(34, 34, 36, 0.74);
        --aml-fg: #f5f5f7;
        --aml-fg-dim: #b4b4b9;
        --aml-fg-faint: #8e8e93;
        --aml-ctrl: rgba(255, 255, 255, 0.12);
        --aml-ctrl-hover: rgba(255, 255, 255, 0.2);
        --aml-border: rgba(255, 255, 255, 0.12);
        --aml-shadow: 0 5px 30px rgba(0, 0, 0, 0.55);
        --aml-menu-bg: rgba(44, 44, 46, 0.74);
        --aml-sep: rgba(255, 255, 255, 0.14);
        --aml-input-bg: rgba(255, 255, 255, 0.08);
        --aml-seg-on: rgba(255, 255, 255, 0.22);
        --aml-switch-off: rgba(255, 255, 255, 0.22);
        color-scheme: dark;
    `;

    const CSS = `
    .aml-ui {
        --aml-bg: rgba(250, 250, 250, 0.72);
        --aml-fg: #252525;
        --aml-fg-dim: #565656;
        --aml-fg-faint: #888888;
        --aml-ctrl: rgba(0, 0, 0, 0.08);
        --aml-ctrl-hover: rgba(0, 0, 0, 0.15);
        --aml-border: rgba(0, 0, 0, 0.08);
        --aml-shadow: 0 5px 30px rgba(0, 0, 0, 0.4);
        --aml-menu-bg: rgba(246, 246, 246, 0.72);
        --aml-sep: rgba(0, 0, 0, 0.1);
        --aml-input-bg: rgba(255, 255, 255, 0.85);
        --aml-seg-on: #ffffff;
        --aml-switch-off: rgba(0, 0, 0, 0.2);
        --aml-accent: #0a7aff;
        --aml-accent-fg: #ffffff;
        color-scheme: light;
        font-family: var(--aml-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif);
        box-sizing: border-box;
    }
    .aml-ui *, .aml-ui *::before, .aml-ui *::after { box-sizing: border-box; }
    @media (prefers-color-scheme: dark) {
        .aml-ui:not([data-theme="light"]) { ${DARK_VARS} }
    }
    .aml-ui[data-theme="dark"] { ${DARK_VARS} }

    /* ---------- 歌词窗口 ---------- */
    #aml-root {
        position: fixed;
        right: 20px;
        top: 60px;
        width: min(850px, calc(100vw - 40px));
        overflow: hidden;
        border-radius: 20px;
        border: 1px solid var(--aml-border);
        background: var(--aml-bg);
        -webkit-backdrop-filter: saturate(200%) blur(25px);
        backdrop-filter: saturate(200%) blur(25px);
        box-shadow: var(--aml-shadow);
        color: var(--aml-fg-dim);
        text-align: center;
        z-index: 9999;
        user-select: none;
        transition: height 0.3s ease;
    }
    #aml-root.aml-dragging { cursor: grabbing; transition: none; }
    .aml-viewport {
        position: absolute;
        inset: 0;
        overflow: hidden;
        padding: 0 30px;
        cursor: grab;
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16%, #000 84%, transparent 100%);
        mask-image: linear-gradient(to bottom, transparent 0, #000 16%, #000 84%, transparent 100%);
    }
    .aml-content {
        position: relative;
        transition: transform 0.3s ease-out;
        will-change: transform;
    }
    .aml-content.aml-msg {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transform: none !important;
    }
    .aml-msg-text {
        font-size: calc(26px * var(--aml-scale, 1));
        font-weight: 600;
        color: var(--aml-fg);
    }

    .aml-msg-sub {
        font-size: calc(14px * var(--aml-scale, 1));
        color: var(--aml-fg-faint);
    }

    .aml-group { padding: 8px 0; }
    .aml-main,
    .aml-trans {
        transform-origin: center;
        transition: transform 0.25s ease, color 0.25s ease;
    }
    .aml-main {
        font-size: calc(28px * var(--aml-scale, 1));
        font-weight: 600;
        line-height: 1.3;
        color: var(--aml-fg-dim);
    }
    .aml-trans {
        margin-top: 4px;
        font-size: calc(20px * var(--aml-scale, 1));
        font-weight: 500;
        line-height: 1.3;
        color: var(--aml-fg-faint);
    }
    .aml-group { transition: filter 0.25s ease; }
    .aml-group.active .aml-main { color: var(--aml-fg); transform: scale(1.14); }
    .aml-group.active .aml-trans { color: var(--aml-fg); opacity: 0.85; transform: scale(1.2); }
    .aml-blur .aml-group:not(.active) { filter: blur(3px); }
    .aml-blur .aml-group:not(.active):hover { filter: none; }
    .aml-no-trans .aml-trans { display: none; }

    /* ---------- 底部按钮栏 ---------- */
    .aml-bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 1;
        pointer-events: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 10px 10px;
    }
    .aml-bar-group { display: flex; align-items: center; gap: 5px; }
    .aml-bar .aml-btn { pointer-events: auto; }
    .aml-btn {
        border: none;
        border-radius: 15px;
        background: var(--aml-ctrl);
        color: var(--aml-fg-dim);
        font: inherit;
        font-size: 12px;
        line-height: 1.2;
        padding: 5px 10px;
        min-width: 30px;
        cursor: pointer;
        opacity: 0.85;
    }
    .aml-btn:hover { opacity: 1; background: var(--aml-ctrl-hover); }
    .aml-btn.aml-btn-wide { min-width: 52px; }
    .aml-btn.aml-static { cursor: default; opacity: 0.6; }
    .aml-btn.aml-static:hover { background: var(--aml-ctrl); opacity: 0.6; }

    /* ---------- 弹出菜单 / 搜索面板 ---------- */
    .aml-pop {
        position: fixed;
        z-index: 10001;
        min-width: 300px;
        max-width: 380px;
        padding: 5px;
        overflow-y: auto;
        border-radius: 10px;
        border: 0.5px solid var(--aml-border);
        background: var(--aml-menu-bg);
        -webkit-backdrop-filter: saturate(180%) blur(30px);
        backdrop-filter: saturate(180%) blur(30px);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
        color: var(--aml-fg);
        font-size: 13px;
        text-align: left;
        user-select: none;
    }
    .aml-head {
        padding: 6px 10px 2px;
        font-size: 11px;
        font-weight: 600;
        color: var(--aml-fg-faint);
    }
    .aml-sep { height: 1px; margin: 5px 8px; background: var(--aml-sep); }
    .aml-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 26px;
        padding: 3px 10px;
        border-radius: 5px;
    }
    .aml-item.aml-click { cursor: default; }
    .aml-item.aml-click:hover { background: var(--aml-accent); color: var(--aml-accent-fg); }
    .aml-item.aml-click:hover .aml-val { color: inherit; }
    .aml-item.aml-disabled { opacity: 0.4; pointer-events: none; }
    .aml-val { color: var(--aml-fg-faint); font-variant-numeric: tabular-nums; }
    .aml-ellip { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .aml-stepper { display: flex; align-items: center; gap: 4px; }
    .aml-stepper button {
        width: 22px; height: 22px; padding: 0;
        border: none; border-radius: 6px;
        background: var(--aml-ctrl); color: inherit;
        font-size: 14px; line-height: 1; cursor: pointer;
    }
    .aml-stepper button:hover { background: var(--aml-ctrl-hover); }
    .aml-stepper span { min-width: 46px; text-align: center; font-variant-numeric: tabular-nums; }

    .aml-seg { display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: var(--aml-ctrl); }
    .aml-seg button {
        padding: 2px 9px; border: none; border-radius: 5px;
        background: transparent; color: inherit;
        font: inherit; font-size: 12px; cursor: pointer;
    }
    .aml-seg button.on { background: var(--aml-seg-on); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }

    .aml-switch {
        position: relative; width: 36px; height: 20px; padding: 0;
        border: none; border-radius: 10px;
        background: var(--aml-switch-off); cursor: pointer;
        transition: background 0.2s;
    }
    .aml-switch::after {
        content: ''; position: absolute; top: 2px; left: 2px;
        width: 16px; height: 16px; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        transition: transform 0.2s;
    }
    .aml-switch.on { background: #34c759; }
    .aml-switch.on::after { transform: translateX(16px); }

    .aml-search { width: 440px; max-width: calc(100vw - 16px); padding: 10px; }
    .aml-search-row { display: flex; gap: 6px; }
    .aml-input {
        flex: 1 1 auto; min-width: 0;
        padding: 6px 10px;
        border: 1px solid var(--aml-border); border-radius: 8px;
        background: var(--aml-input-bg); color: var(--aml-fg);
        font: inherit; font-size: 13px;
        outline: none; user-select: text;
    }
    .aml-input:focus { border-color: var(--aml-accent); }
    .aml-primary {
        padding: 6px 14px; border: none; border-radius: 8px;
        background: var(--aml-accent); color: #fff;
        font: inherit; font-size: 13px; cursor: pointer;
    }
    .aml-results { margin-top: 8px; max-height: min(320px, 50vh); overflow-y: auto; }
    .aml-result {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 10px; border-radius: 6px; cursor: default;
    }
    .aml-result:hover { background: var(--aml-accent); color: var(--aml-accent-fg); }
    .aml-result .aml-check { width: 12px; flex: 0 0 12px; font-size: 12px; }
    .aml-result .aml-result-main { flex: 1 1 auto; min-width: 0; }
    .aml-result .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aml-result .s { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aml-result .d { flex: 0 0 auto; font-size: 11px; opacity: 0.7; font-variant-numeric: tabular-nums; }
    .aml-status { padding: 8px 4px 0; font-size: 12px; color: #ff9f0a; }
    .aml-status:empty { display: none; }
    .aml-result.aml-nolyric { opacity: 0.45; }
    .aml-result.aml-nolyric:hover { background: transparent; color: inherit; }
    .aml-hint { padding: 8px 4px 0; font-size: 11px; color: var(--aml-fg-faint); }
    .aml-hint.aml-center { padding: 18px 4px; text-align: center; font-size: 12px; }
    `;

    function injectCss(css) {
        if (typeof GM_addStyle === 'function') {
            try { GM_addStyle(css); return; } catch (e) { /* 回退 */ }
        }
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            return;
        } catch (e) { /* 回退 */ }
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    /* ==================================================================
     * DOM 小工具
     * ================================================================== */
    function h(tag, attrs, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        for (const c of children.flat()) if (c != null && c !== false) node.append(c);
        return node;
    }

    function applyTheme(node) {
        if (settings.theme === 'light' || settings.theme === 'dark') node.dataset.theme = settings.theme;
        else delete node.dataset.theme;
    }

    /* ==================================================================
     * 歌词窗口
     * ================================================================== */
    injectCss(CSS);

    const ui = buildUI();

    function buildUI() {
        const root = h('div', { id: 'aml-root', class: 'aml-ui' });
        const viewport = h('div', { class: 'aml-viewport' });
        const content = h('div', { class: 'aml-content' });
        viewport.append(content);

        const settingsBtn = h('button', {
            class: 'aml-btn', text: '设置', title: '设置',
            onclick: e => { e.stopPropagation(); toggleMenu(); }
        });
        const searchBtn = h('button', {
            class: 'aml-btn', text: '重新搜索', title: '歌词不对或没找到？手动搜索并选择',
            onclick: e => { e.stopPropagation(); toggleSearch(); }
        });
        const tipBtn = h('button', { class: 'aml-btn', text: '' });
        tipBtn.style.display = 'none';
        const minusBtn = h('button', {
            class: 'aml-btn', text: '−', title: '歌词提前 0.2 秒',
            onclick: e => { e.stopPropagation(); changeOffset(-0.2); }
        });
        const offsetBtn = h('button', {
            class: 'aml-btn aml-btn-wide', text: '+0.0s', title: '点击归零',
            onclick: e => { e.stopPropagation(); changeOffset(0, true); }
        });
        const plusBtn = h('button', {
            class: 'aml-btn', text: '+', title: '歌词延后 0.2 秒',
            onclick: e => { e.stopPropagation(); changeOffset(0.2); }
        });
        const toggleBtn = h('button', {
            class: 'aml-btn', text: '放大',
            onclick: e => {
                e.stopPropagation();
                settings.minimized = !settings.minimized;
                saveSettings();
                applySize();
            }
        });

        const bar = h('div', { class: 'aml-bar' },
            h('div', { class: 'aml-bar-group' }, settingsBtn, searchBtn, tipBtn),
            h('div', { class: 'aml-bar-group' }, minusBtn, offsetBtn, plusBtn, toggleBtn)
        );

        root.append(viewport, bar);
        document.body.appendChild(root);
        return { root, viewport, content, settingsBtn, searchBtn, tipBtn, offsetBtn, toggleBtn };
    }

    function applySize() {
        ui.root.style.height = (settings.minimized ? HEIGHT_MIN : HEIGHT_MAX) + 'px';
        ui.toggleBtn.textContent = settings.minimized ? '放大' : '缩小';
    }

    function applySettings() {
        ui.root.style.setProperty('--aml-scale', (settings.fontScale / 100).toFixed(2));
        ui.root.classList.toggle('aml-blur', !!settings.blur);
        ui.root.classList.toggle('aml-no-trans', !settings.showTranslation);
        document.querySelectorAll('.aml-ui').forEach(applyTheme);
        requestAnimationFrame(() => centerActive(true));
    }

    // ---- 位置 / 拖拽 ----
    function setPosition(left, top) {
        const w = ui.root.offsetWidth;
        const x = Math.max(0, Math.min(left, window.innerWidth - w));
        const y = Math.max(0, Math.min(top, window.innerHeight - 48));
        ui.root.style.left = x + 'px';
        ui.root.style.top = y + 'px';
        ui.root.style.right = 'auto';
        return { left: x, top: y };
    }

    let drag = null;
    ui.root.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('button, input')) return;
        const rect = ui.root.getBoundingClientRect();
        drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        ui.root.setPointerCapture(e.pointerId);
        ui.root.classList.add('aml-dragging');
        e.preventDefault();
    });
    ui.root.addEventListener('pointermove', e => {
        if (!drag) return;
        setPosition(e.clientX - drag.dx, e.clientY - drag.dy);
        if (pop) placePopover(pop.el, pop.anchor);
    });
    const endDrag = e => {
        if (!drag) return;
        drag = null;
        ui.root.classList.remove('aml-dragging');
        try { ui.root.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        const rect = ui.root.getBoundingClientRect();
        settings.pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
        saveSettings();
    };
    ui.root.addEventListener('pointerup', endDrag);
    ui.root.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
        if (settings.pos) setPosition(settings.pos.left, settings.pos.top);
        if (pop) placePopover(pop.el, pop.anchor);
        centerActive(true);
    });

    // ---- 偏移 ----
    function refreshOffsetButton() {
        const v = lyricsOffset;
        ui.offsetBtn.textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + 's';
    }
    function changeOffset(delta, reset) {
        lyricsOffset = reset ? 0 : Math.round((lyricsOffset + delta) * 10) / 10;
        refreshOffsetButton();
        saveOffset(currentSongTitle, lyricsOffset);
        updateLyricScroll(lastTime, true);
    }

    // 让歌词窗口沿用 Apple Music 页面自己的字体：统计页面上文字最常用的 font-family
    const FONT_FALLBACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif';
    let pageFontReady = false;
    function detectPageFont() {
        const counts = new Map();
        let total = 0;
        const nodes = document.querySelectorAll('a, p, h1, h2, h3, span');
        for (let i = 0; i < nodes.length && total < 200; i++) {
            const el = nodes[i];
            if (el.closest('.aml-ui') || !el.textContent.trim()) continue;
            const f = getComputedStyle(el).fontFamily;
            counts.set(f, (counts.get(f) || 0) + 1);
            total++;
        }
        if (total < 10) return;           // 页面还没渲染出足够的文字，稍后再试
        let best = '', bestCount = 0;
        for (const [f, c] of counts) if (c > bestCount) { best = f; bestCount = c; }
        pageFontReady = true;
        if (best) document.documentElement.style.setProperty('--aml-font', `${best}, ${FONT_FALLBACK}`);
    }

    /* ==================================================================
     * 歌词显示
     * ================================================================== */
    // 底部栏上的小提示按钮：无文字时隐藏；有 onClick 时可点击，否则只是状态标签
    function setTip(text, onClick) {
        const b = ui.tipBtn;
        if (!text) { b.style.display = 'none'; b.textContent = ''; b.onclick = null; return; }
        b.style.display = '';
        b.textContent = text;
        b.onclick = onClick ? (e => { e.stopPropagation(); onClick(); }) : null;
        b.classList.toggle('aml-static', !onClick);
    }
    function flashTip(text) {
        setTip(text);
        setTimeout(() => {
            if (ui.tipBtn.textContent === text) restoreTip();
        }, 3000);
    }

    function showMessage(text, withSearch, sub) {
        setTip(null);
        currentLyrics = [];
        translations = [];
        activeIndex = -1;
        ui.content.className = 'aml-content aml-msg';
        ui.content.replaceChildren(...[
            h('div', { class: 'aml-msg-text', text }),
            sub ? h('div', { class: 'aml-msg-sub', text: sub }) : null,
            withSearch ? h('button', {
                class: 'aml-btn', text: '手动搜索',
                onclick: e => { e.stopPropagation(); openSearch(); }
            }) : null
        ].filter(Boolean));
    }

    function renderLyrics() {
        ui.content.className = 'aml-content';
        const frag = document.createDocumentFragment();
        currentLyrics.forEach((lyric, i) => {
            const group = h('div', { class: 'aml-group' },
                h('div', { class: 'aml-main', text: lyric.text })
            );
            if (translations[i]) group.append(h('div', { class: 'aml-trans', lang: 'zh-CN', text: translations[i] }));
            frag.append(group);
        });
        ui.content.replaceChildren(frag);
        activeIndex = -1;
        updateLyricScroll(lastTime, true, true);
    }

    function centerActive(instant) {
        const active = ui.content.querySelector('.aml-group.active');
        if (!active) return;
        const y = active.offsetTop + active.offsetHeight / 2;
        const ty = Math.round(ui.viewport.clientHeight / 2 - y);
        const c = ui.content;
        if (instant) {
            c.style.transition = 'none';
            c.style.transform = `translateY(${ty}px)`;
            void c.offsetHeight;
            c.style.transition = '';
        } else {
            c.style.transform = `translateY(${ty}px)`;
        }
    }

    // 根据播放时间切换当前行；只有当前行变化时才操作 DOM
    function updateLyricScroll(time, force, instant) {
        lastTime = time;
        const n = currentLyrics.length;
        if (n === 0) return;

        const t = time + lyricsOffset;
        let lo = 0, hi = n - 1, idx = 0;
        while (lo <= hi) {                    // 二分查找最后一个 startTime <= t 的行
            const mid = (lo + hi) >> 1;
            if (currentLyrics[mid].startTime <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (!force && idx === activeIndex) return;
        activeIndex = idx;

        const groups = ui.content.children;
        const prev = ui.content.querySelector('.aml-group.active');
        if (prev) prev.classList.remove('active');
        if (groups[idx]) groups[idx].classList.add('active');
        centerActive(!!instant);
    }

    new ResizeObserver(() => centerActive(true)).observe(ui.viewport);

    /* ==================================================================
     * 网易云接口
     * ================================================================== */
    function gmGetJson(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 10000,
                onload: res => {
                    if (res.status < 200 || res.status >= 300) return reject(new Error('HTTP ' + res.status));
                    try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('请求超时'))
            });
        });
    }

    async function searchSongs(keyword, limit) {
        const data = await gmGetJson(
            `https://music.163.com/api/search/pc?s=${encodeURIComponent(keyword)}&offset=0&limit=${limit}&type=1`
        );
        const songs = (data && data.result && data.result.songs) || [];
        return songs.map(s => ({
            id: s.id,
            name: s.name || '',
            artist: (s.artists || s.ar || []).map(a => a.name).join(' / '),
            album: (s.album || s.al || {}).name || '',
            duration: s.duration || s.dt || 0
        }));
    }

    async function fetchLyrics(songId) {
        const data = await gmGetJson(`https://music.163.com/api/song/lyric?lv=1&kv=1&tv=-1&id=${songId}`);
        return {
            main: parseLyrics(data && data.lrc && data.lrc.lyric),
            trans: parseLyrics(data && data.tlyric && data.tlyric.lyric)
        };
    }

    // 解析 LRC：支持一行多个时间戳、1~3 位小数；忽略 [ar:] [ti:] 之类的元数据行
    function parseLyrics(text) {
        if (!text) return [];
        const result = [];
        const leading = /^(?:\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
        const tag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

        for (const line of text.split(/\r?\n/)) {
            const m = line.match(leading);
            if (!m) continue;
            const lyricText = line.slice(m[0].length).trim();
            for (const raw of m[0].match(/\[[^\]]+\]/g)) {
                const p = raw.match(tag);
                if (!p) continue;
                const frac = p[3] ? parseFloat('0.' + p[3]) : 0;   // "5"→0.5 "05"→0.05 "050"→0.05
                result.push({ startTime: parseInt(p[1], 10) * 60 + parseInt(p[2], 10) + frac, text: lyricText });
            }
        }
        return result.sort((a, b) => a.startTime - b.startTime);
    }

    // 为每一行主歌词找时间最接近（0.5 秒内）的翻译
    function alignTranslations(main, trans) {
        return main.map(l => {
            let best = null, bestDiff = 0.5;
            for (const t of trans) {
                const d = Math.abs(t.startTime - l.startTime);
                if (d < bestDiff) { best = t; bestDiff = d; }
            }
            return best ? best.text : '';
        });
    }

    /* ==================================================================
     * 加载流程
     * ================================================================== */
    function applyLyrics(songId, main, trans) {
        currentSongId = songId;
        currentLyrics = main;
        translations = alignTranslations(main, trans);
        hasHumanTranslation = translations.some(Boolean);
        machineTranslated = false;
        machinePending = [];
        lineLangs = [];
        translatorInfo = null;
        setTip(null);
        renderLyrics();
        refreshMenu();
        if (!hasHumanTranslation && settings.autoTranslate && settings.showTranslation) translateCurrent(false);
    }

    async function loadLyricsById(songId, token) {
        if (token == null) token = ++loadToken;
        showMessage('歌词正在加载中 ...');
        try {
            const { main, trans } = await fetchLyrics(songId);
            if (token !== loadToken) return;           // 已经切歌，丢弃
            if (main.length === 0) { showMessage('暂无歌词', true); return; }
            applyLyrics(songId, main, trans);
        } catch (e) {
            if (token !== loadToken) return;
            console.error('[AML] 歌词获取失败:', e);
            showMessage('歌词获取失败', true);
        }
    }

    async function loadLyricsForTitle(title) {
        const token = ++loadToken;
        currentSongId = null;
        showMessage(title);
        try {
            const remembered = getMatch(title);
            if (remembered) {
                showMessage('歌词正在加载中 ...');
                const { main, trans } = await fetchLyrics(remembered.id);
                if (token !== loadToken) return;
                if (main.length > 0) {
                    touchMatch(title);
                    applyLyrics(remembered.id, main, trans);
                    return;
                }
                // 记住的那个版本已经没有可用歌词（比如之前误选了），丢弃后重新自动搜索
                removeMatch(title);
                showMessage(title);
            }
            const results = await searchSongs(title, 1);
            if (token !== loadToken) return;
            if (results.length === 0) { showMessage('未找到歌曲', true); return; }
            await loadLyricsById(results[0].id, token);
        } catch (e) {
            if (token !== loadToken) return;
            console.error('[AML] 搜索歌曲失败:', e);
            showMessage('请求失败', true);
        }
    }

    /* ==================================================================
     * 机器翻译（浏览器内置 Translator API，仅桌面版 Chrome / Edge）
     * ================================================================== */
    const TARGET_LANG = 'zh';
    const TCACHE_LIMIT = 200;
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const translators = new Map();   // 源语言 -> Translator 实例

    function builtin(name) { return window[name] || pageWin[name] || null; }

    function getTCache(songId) {
        const e = store.get(KEY_TCACHE, {})[songId];
        return e && Array.isArray(e.lines) ? e : null;
    }
    function saveTCache(songId, lines) {
        const all = store.get(KEY_TCACHE, {});
        all[songId] = { t: Date.now(), lines };
        const keys = Object.keys(all);
        if (keys.length > TCACHE_LIMIT) {
            keys.sort((a, b) => all[b].t - all[a].t).slice(TCACHE_LIMIT).forEach(k => delete all[k]);
        }
        store.set(KEY_TCACHE, all);
    }

    const LANG_NAMES = { en: '英语', ja: '日语', ko: '韩语', ru: '俄语', th: '泰语', ar: '阿拉伯语', hi: '印地语',
                         es: '西班牙语', fr: '法语', de: '德语', pt: '葡萄牙语', it: '意大利语' };
    const langName = c => LANG_NAMES[c] || c;

    // 按文字系统给单行歌词分类；拉丁字母统一记为 'latin'，具体是哪种语言之后再判断
    function classifyLine(text) {
        const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
        const n = letters.length;
        if (!n) return null;
        const ratio = re => (letters.match(re) || []).length / n;

        if (ratio(/[\u3040-\u30ff]/g) > 0.1) return 'ja';
        if (ratio(/[\uac00-\ud7af]/g) > 0.3) return 'ko';
        if (ratio(/\p{Script=Han}/gu) > 0.5) return 'zh';
        if (ratio(/\p{Script=Cyrillic}/gu) > 0.5) return 'ru';
        if (ratio(/\p{Script=Thai}/gu) > 0.5) return 'th';
        if (ratio(/\p{Script=Arabic}/gu) > 0.5) return 'ar';
        if (ratio(/\p{Script=Devanagari}/gu) > 0.5) return 'hi';
        if (ratio(/\p{Script=Latin}/gu) > 0.5) return 'latin';
        return null;
    }

    // 拉丁字母的歌词交给内置的 LanguageDetector 判断（不可用时当作英语）
    async function detectLatinLang(text) {
        const LD = builtin('LanguageDetector');
        if (LD) {
            try {
                if ((await LD.availability()) === 'available') {
                    const detector = await LD.create();
                    const top = (await detector.detect(text))[0];
                    if (top && top.confidence > 0.6 && top.detectedLanguage !== 'und') {
                        return top.detectedLanguage.split('-')[0];
                    }
                }
            } catch (e) { /* 忽略，退回英语 */ }
        }
        return 'en';
    }

    // 逐行判断语言，这样“英文歌里夹着韩语”这种混合歌词也能各用各的翻译模型
    async function detectLineLangs(lines) {
        const kinds = lines.map(l => classifyLine(l.text));
        const latinText = lines.filter((l, i) => kinds[i] === 'latin').map(l => l.text).join('\n').slice(0, 2000);
        const latin = latinText ? await detectLatinLang(latinText) : 'en';
        return kinds.map(k => (k === 'latin' ? latin : (k === 'zh' ? null : k)));
    }

    async function getTranslator(T, src) {
        if (translators.has(src)) return translators.get(src);
        const translator = await T.create({
            sourceLanguage: src,
            targetLanguage: TARGET_LANG,
            monitor(m) {
                m.addEventListener('downloadprogress', e => setTip(`下载${langName(src)}翻译模型 ${Math.round(e.loaded * 100)}%`));
            }
        });
        translators.set(src, translator);
        return translator;
    }

    // 还有语言没翻译时，提示按钮可以点击继续（下载语言包）；全部完成则显示“机翻”标签
    function restoreTip() {
        if (machinePending.length > 0) setTip('下载翻译模型', () => translateCurrent(true));
        else if (machineTranslated) setTip('机翻');
        else setTip(null);
    }

    function finishMachine(lines) {
        translations = lines;
        machineTranslated = true;
        renderLyrics();
        restoreTip();
    }

    // manual = true 表示由用户点击触发（可以下载语言包）；自动触发时只翻译“已就绪”的语言
    async function translateCurrent(manual) {
        if (hasHumanTranslation || currentLyrics.length === 0) return;
        if (machineTranslated && machinePending.length === 0) return;   // 已经全部翻译完
        const songId = currentSongId;
        const lyrics = currentLyrics;
        const token = loadToken;
        const stale = () => token !== loadToken;
        if (translatingId === songId) return;
        translatingId = songId;
        const resume = machinePending.length > 0;   // 继续上一次没做完的语言

        try {
            if (!resume) {
                const cached = getTCache(songId);
                if (cached && cached.lines.length === lyrics.length) {
                    translatorInfo = { cached: true };
                    finishMachine(cached.lines);
                    return;
                }
            }

            const T = builtin('Translator');
            if (!T) return;

            if (!resume) {
                lineLangs = await detectLineLangs(lyrics);
                if (stale()) return;
            }
            const wanted = resume ? machinePending.slice() : [...new Set(lineLangs.filter(Boolean))];
            if (wanted.length === 0) {
                translatorInfo = { status: {} };
                if (manual) flashTip('中文歌词无需翻译');
                return;
            }

            const status = {};
            for (const lang of wanted) {
                try { status[lang] = await T.availability({ sourceLanguage: lang, targetLanguage: TARGET_LANG }); }
                catch (e) { status[lang] = 'unavailable'; }
            }
            if (stale()) return;
            translatorInfo = { status };

            const needsDownload = l => status[l] === 'downloadable' || status[l] === 'downloading';
            const usable = wanted.filter(l => status[l] === 'available' || (manual && needsDownload(l)));
            const waiting = wanted.filter(l => needsDownload(l) && !usable.includes(l));

            if (usable.length === 0) {
                machinePending = waiting;
                if (waiting.length) restoreTip();          // 等待用户点击下载
                else if (manual) flashTip('不支持该语言的翻译');
                return;
            }

            setTip('翻译中…');
            const out = resume ? translations.slice() : lyrics.map(() => '');
            const failed = [];
            for (const lang of usable) {
                let translator;
                try {
                    translator = await getTranslator(T, lang);
                } catch (e) {
                    console.error('[AML] 创建翻译器失败:', lang, e);
                    failed.push(lang);          // 例如第二个语言包需要再点一次才能下载
                    continue;
                }
                status[lang] = 'available';
                for (let i = 0; i < lyrics.length; i++) {
                    if (lineLangs[i] !== lang) continue;
                    if (stale()) return;
                    try {
                        const r = (await translator.translate(lyrics[i].text)).trim();
                        // 译文和原文一样说明模型没有真正翻译，不显示
                        out[i] = r && r !== lyrics[i].text.trim() ? r : '';
                    } catch (e) {
                        out[i] = '';             // 单行失败不影响其他行
                    }
                }
            }
            if (stale()) return;

            machinePending = [...waiting, ...failed];
            if (!out.some(Boolean)) {
                if (machinePending.length) restoreTip();
                else if (manual) flashTip('没有可用的翻译');
                else setTip(null);
                return;
            }
            if (machinePending.length === 0) saveTCache(songId, out);   // 只缓存完整的结果
            finishMachine(out);
        } catch (e) {
            console.error('[AML] 翻译失败:', e);
            if (!stale()) {
                if (manual) flashTip('翻译失败'); else restoreTip();
            }
        } finally {
            if (translatingId === songId) translatingId = null;
            refreshMenu();
        }
    }

    // 菜单里“浏览器内置翻译”一行：反映当前这首歌的情况，而不是上一次检测的结果
    function translatorStatusText() {
        if (!builtin('Translator')) return '此浏览器不支持';
        if (currentLyrics.length === 0) return '—';
        if (hasHumanTranslation) return '此首歌无需再次翻译';
        if (!translatorInfo) {
            if (translatingId) return '检测中…';
            return settings.autoTranslate ? '—' : '自动翻译已关闭';
        }
        if (translatorInfo.cached) return '已使用缓存的翻译';
        const names = { available: '可用', downloadable: '需下载', downloading: '下载中', unavailable: '不支持' };
        const entries = Object.entries(translatorInfo.status || {});
        if (entries.length === 0) return '中文歌词，无需翻译';
        return entries.map(([lang, st]) => `${langName(lang)}${names[st] || st}`).join(' · ');
    }

    /* ==================================================================
     * 播放器监听
     * ================================================================== */
    // 播放器 title 形如「歌名 - 歌手 - ...」，取到第二个 "-" 之前
    function getCleanTitle(audio) {
        let title = ((audio && audio.title) || '').trim();
        if (!title) return '';
        const first = title.indexOf('-');
        const second = first === -1 ? -1 : title.indexOf('-', first + 1);
        if (second !== -1) title = title.substring(0, second).trim();
        return title;
    }

    function checkSongChange(audio) {
        const title = getCleanTitle(audio);
        if (!title || title === currentSongTitle) return;
        currentSongTitle = title;
        // 播放器时间轴若在切歌时没有归零，就以当前时间作为这首歌的起点
        songStartOffset = audio.currentTime > 5 ? audio.currentTime : 0;
        lyricsOffset = loadOffset(title);
        refreshOffsetButton();
        lastTime = 0;
        loadLyricsForTitle(title);
    }

    function onTimeUpdate(audio) {
        checkSongChange(audio);
        tickStats(audio);
        let eff = audio.currentTime - songStartOffset;
        if (eff < 0) { songStartOffset = 0; eff = audio.currentTime; }
        updateLyricScroll(eff);
    }

    document.addEventListener('timeupdate', e => {
        if (e.target && e.target.id === PLAYER_ID) onTimeUpdate(e.target);
    }, true);
    document.addEventListener('pause', e => {
        if (e.target && e.target.id === PLAYER_ID) lastTick = 0;
    }, true);
    document.addEventListener('ended', e => {
        // 单曲循环 / 时间轴不归零时，重新以当前时间作为起点
        if (e.target && e.target.id === PLAYER_ID) {
            lastTick = 0;
            songStartOffset = e.target.currentTime > 5 ? e.target.currentTime : 0;
        }
    }, true);

    // 播放器元素可能被页面重建：定时查找，并监听 title 属性变化以便更快发现切歌
    let hookedPlayer = null;
    let titleObserver = null;
    setInterval(() => {
        if (!pageFontReady) detectPageFont();
        const audio = document.getElementById(PLAYER_ID);
        if (!audio) return;
        if (audio !== hookedPlayer) {
            if (titleObserver) titleObserver.disconnect();
            titleObserver = new MutationObserver(() => checkSongChange(audio));
            titleObserver.observe(audio, { attributes: true, attributeFilter: ['title'] });
            hookedPlayer = audio;
        }
        checkSongChange(audio);   // 兜底
    }, 1000);

    setInterval(flushStats, 15000);
    window.addEventListener('pagehide', flushStats);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushStats(); });

    /* ==================================================================
     * 弹出层（菜单 / 搜索面板）
     * ================================================================== */
    let pop = null;   // { kind, el, anchor, render }

    function placePopover(el, anchor) {
        const r = anchor.getBoundingClientRect();
        el.style.maxHeight = `${window.innerHeight - 16}px`;
        const w = el.offsetWidth, hgt = el.offsetHeight;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        let top = r.bottom + 6;
        if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }

    function onOutsidePointer(e) {
        if (!pop) return;
        if (pop.el.contains(e.target) || pop.anchor.contains(e.target)) return;
        closePopover();
    }
    function onEscape(e) { if (e.key === 'Escape') closePopover(); }

    function closePopover() {
        if (!pop) return;
        pop.el.remove();
        pop = null;
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('keydown', onEscape, true);
    }

    function openPopover(kind, className, anchor, render) {
        closePopover();
        const el = h('div', { class: 'aml-ui aml-pop ' + className });
        applyTheme(el);
        // 在弹层里按键时不要触发 Apple Music 自己的快捷键（比如空格暂停）
        ['keydown', 'keyup', 'keypress'].forEach(t => el.addEventListener(t, e => e.stopPropagation()));
        document.body.appendChild(el);
        pop = { kind, el, anchor, render };
        render(el);
        placePopover(el, anchor);
        document.addEventListener('pointerdown', onOutsidePointer, true);
        document.addEventListener('keydown', onEscape, true);
        return el;
    }

    /* ==================================================================
     * 设置菜单（macOS 菜单风格）
     * ================================================================== */
    function mRow(label, right) {
        return h('div', { class: 'aml-item' }, h('span', { text: label }), right);
    }
    function mInfo(label, value, ellipsis) {
        return mRow(label, h('span', { class: 'aml-val' + (ellipsis ? ' aml-ellip' : ''), text: value, title: ellipsis ? value : '' }));
    }
    function mStepper(label, text, onMinus, onPlus) {
        return mRow(label, h('div', { class: 'aml-stepper' },
            h('button', { text: '−', onclick: onMinus }),
            h('span', { text }),
            h('button', { text: '+', onclick: onPlus })
        ));
    }
    function mSegment(label, options, current, onPick) {
        return mRow(label, h('div', { class: 'aml-seg' },
            options.map(([value, text]) => h('button', {
                class: value === current ? 'on' : '', text, onclick: () => onPick(value)
            }))
        ));
    }
    function mSwitch(label, on, onToggle) {
        return mRow(label, h('button', {
            class: 'aml-switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), onclick: onToggle
        }));
    }
    function mAction(label, onClick, opts) {
        opts = opts || {};
        return h('div', {
            class: 'aml-item aml-click' + (opts.disabled ? ' aml-disabled' : ''),
            onclick: onClick
        }, h('span', { text: label }), opts.right ? h('span', { class: 'aml-val', text: opts.right }) : null);
    }
    function mSep() { return h('div', { class: 'aml-sep' }); }

    function stepValue(list, cur, dir) {
        if (dir > 0) { const up = list.find(v => v > cur); return up !== undefined ? up : list[list.length - 1]; }
        const lower = list.filter(v => v < cur);
        return lower.length ? lower[lower.length - 1] : list[0];
    }

    function setSetting(key, value) {
        settings[key] = value;
        saveSettings();
        applySettings();
        refreshMenu();
    }

    function renderMenu(el) {
        const st = getStatsSummary();
        const matchCount = countMatches();
        const hasCurrentMatch = !!(currentSongTitle && getMatch(currentSongTitle));

        el.replaceChildren(
            h('div', { class: 'aml-head', text: '听歌统计（仅统计此浏览器）' }),
            mInfo('本周听歌', fmtDuration(st.week)),
            mInfo('今日听歌', fmtDuration(st.today)),
            mInfo('本周最常听', st.top || '—', true),
            mAction('清除听歌统计…', () => {
                if (!confirm('确定要清除所有听歌统计吗？')) return;
                pending = {};
                store.set(KEY_STATS, { days: {} });
                refreshMenu();
            }),
            mSep(),

            h('div', { class: 'aml-head', text: '显示' }),
            mStepper('字体大小', settings.fontScale + '%',
                () => setSetting('fontScale', Math.max(FONT_SCALE_MIN, settings.fontScale - 10)),
                () => setSetting('fontScale', Math.min(FONT_SCALE_MAX, settings.fontScale + 10))),
            mSegment('外观', [['auto', '自动'], ['light', '浅色'], ['dark', '深色']], settings.theme,
                v => setSetting('theme', v)),
            mSwitch('模糊非当前歌词', settings.blur, () => setSetting('blur', !settings.blur)),
            mSwitch('显示翻译', settings.showTranslation, () => setSetting('showTranslation', !settings.showTranslation)),
            mSep(),

            h('div', { class: 'aml-head', text: '翻译' }),
            mSwitch('无翻译时自动翻译', settings.autoTranslate, () => setSetting('autoTranslate', !settings.autoTranslate)),
            mInfo('浏览器内置翻译', translatorStatusText(), true),
            mAction('翻译当前歌曲', () => { closePopover(); translateCurrent(true); },
                { disabled: currentLyrics.length === 0 || hasHumanTranslation || (machineTranslated && machinePending.length === 0) }),
            mSep(),

            h('div', { class: 'aml-head', text: '歌词匹配' }),
            mStepper('记住手动匹配的数量', settings.maxMatches === 0 ? '不记住' : String(settings.maxMatches),
                () => setSetting('maxMatches', stepValue(MATCH_LIMIT_STEPS, settings.maxMatches, -1)),
                () => setSetting('maxMatches', stepValue(MATCH_LIMIT_STEPS, settings.maxMatches, +1))),
            mAction('重新搜索歌词…', () => { closePopover(); openSearch(); }),
            mAction('恢复当前歌曲的自动匹配', () => {
                const title = currentSongTitle;
                closePopover();
                removeMatch(title);
                loadLyricsForTitle(title);
            }, { disabled: !hasCurrentMatch }),
            mAction('清除全部已记住的匹配…', () => {
                if (!confirm(`确定要清除已记住的 ${matchCount} 首歌曲匹配吗？`)) return;
                store.set(KEY_MATCHES, {});
                refreshMenu();
            }, { disabled: matchCount === 0, right: `${matchCount} 首` }),
            mSep(),

            mAction('关于本插件', () => {
                closePopover();
                window.open(ABOUT_URL, '_blank', 'noopener,noreferrer');
            })
        );
    }

    function refreshMenu() {
        if (pop && pop.kind === 'menu') {
            renderMenu(pop.el);
            placePopover(pop.el, pop.anchor);
        }
    }

    function toggleMenu() {
        if (pop && pop.kind === 'menu') { closePopover(); return; }
        flushStats();   // 打开前先把内存里的增量落盘，统计更准确
        openPopover('menu', 'aml-menu', ui.settingsBtn, renderMenu);
    }

    /* ==================================================================
     * 手动搜索面板
     * ================================================================== */
    function toggleSearch() {
        if (pop && pop.kind === 'search') closePopover(); else openSearch();
    }

    function openSearch() {
        const title = currentSongTitle;

        openPopover('search', 'aml-search', ui.searchBtn, el => {
            const input = h('input', { class: 'aml-input', type: 'text', placeholder: '输入歌名或歌手，搜索网易云音乐' });
            input.value = title ? title.split(' - ')[0] : '';
            const results = h('div', { class: 'aml-results' });
            const hint = h('div', {
                class: 'aml-hint',
                text: settings.maxMatches > 0
                    ? '选择后会记住这首歌的匹配，下次播放时自动使用。'
                    : '“记住手动匹配的数量”为 0，这次的选择不会被记住。'
            });
            const status = h('div', { class: 'aml-status' });
            let seq = 0;
            let busy = false;

            // 先确认这个版本确实有歌词，再记住并应用；没有的话留在列表里让用户换一个
            const choose = async (song, row) => {
                if (busy || row.classList.contains('aml-nolyric')) return;
                busy = true;
                status.textContent = '';
                row.style.opacity = '0.6';
                try {
                    const { main, trans } = await fetchLyrics(song.id);
                    if (!pop || pop.el !== el) return;
                    row.style.opacity = '';
                    if (main.length === 0) {
                        row.classList.add('aml-nolyric');
                        row.querySelector('.d').textContent = '无歌词';
                        status.textContent = '这个版本没有滚动歌词，没有记住这次选择，请试试列表里的其他结果。';
                        return;
                    }
                    saveMatch(title, song);
                    closePopover();
                    if (title === currentSongTitle) {
                        ++loadToken;   // 使仍在进行的自动加载失效
                        applyLyrics(song.id, main, trans);
                    }
                } catch (e) {
                    if (!pop || pop.el !== el) return;
                    console.error('[AML] 获取歌词失败:', e);
                    row.style.opacity = '';
                    status.textContent = '歌词获取失败，请检查网络后重试。';
                } finally {
                    busy = false;
                }
            };

            const doSearch = async () => {
                const keyword = input.value.trim();
                if (!keyword) return;
                const mySeq = ++seq;
                results.replaceChildren(h('div', { class: 'aml-hint aml-center', text: '搜索中…' }));
                try {
                    const list = await searchSongs(keyword, 20);
                    if (mySeq !== seq || !pop || pop.el !== el) return;
                    if (list.length === 0) {
                        results.replaceChildren(h('div', { class: 'aml-hint aml-center', text: '没有找到结果，换个关键词试试' }));
                        return;
                    }
                    results.replaceChildren(...list.map(s => {
                        const row = h('div', { class: 'aml-result' },
                            h('span', { class: 'aml-check', text: s.id === currentSongId ? '✓' : '' }),
                            h('div', { class: 'aml-result-main' },
                                h('div', { class: 't', text: s.name }),
                                h('div', { class: 's', text: [s.artist, s.album].filter(Boolean).join(' · ') })
                            ),
                            h('div', { class: 'd', text: fmtMs(s.duration) })
                        );
                        row.addEventListener('click', () => choose(s, row));
                        return row;
                    }));
                } catch (e) {
                    if (mySeq !== seq || !pop || pop.el !== el) return;
                    console.error('[AML] 手动搜索失败:', e);
                    results.replaceChildren(h('div', { class: 'aml-hint aml-center', text: '搜索失败，请检查网络后重试' }));
                }
            };

            input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
            el.replaceChildren(
                h('div', { class: 'aml-search-row' },
                    input,
                    h('button', { class: 'aml-primary', text: '搜索', onclick: doSearch })
                ),
                status,
                results,
                hint
            );
            setTimeout(() => {
                input.focus();
                input.select();
                if (input.value.trim()) doSearch();
            }, 0);
        });
    }

    /* ==================================================================
     * 初始化
     * ================================================================== */
    if (settings.pos) setPosition(settings.pos.left, settings.pos.top);
    detectPageFont();
    applySize();
    applySettings();
    refreshOffsetButton();
    showMessage('Apple Music 歌词增强 v' + VERSION, false, 'by Akashi & Claude');
})();
