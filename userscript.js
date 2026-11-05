// ==UserScript==
// @name         Apple Music 歌词增强
// @namespace    https://github.com/akashiwest/AML-Enhancer
// @version      1.400
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
    const VERSION = '1.4.0';
    const ABOUT_URL = 'https://imakashi.com/blog/archives/AML_Enhancer.html';
    const PLAYER_ID = 'apple-music-player';

    const HEIGHT_MIN = 150;   // 缩小时窗口总高度（含底部按钮栏）
    const HEIGHT_MAX = 280;   // 放大时窗口总高度

    const KEY_OFFSETS = 'lyricsOffsets';   // 沿用旧版键名，保留已有的偏移数据
    const KEY_SETTINGS = 'aml_settings';
    const KEY_MATCHES = 'aml_matches';
    const KEY_STATS = 'aml_stats';
    const KEY_TCACHE = 'aml_tcache';        // 机器翻译缓存
    const KEY_INSTR = 'aml_instrumental';  // 标记为纯音乐的歌曲

    const FONT_SCALE_MIN = 70;
    const FONT_SCALE_MAX = 160;
    const STATS_KEEP_DAYS = 90;

    const DEFAULT_SETTINGS = {
        fontScale: 100,        // 字体大小百分比
        blur: true,            // 模糊非当前歌词
        showTranslation: true, // 显示翻译
        autoTranslate: true,   // 没有翻译时用浏览器内置翻译自动翻译
        theme: 'auto',         // auto | light | dark
        maxMatches: 500,       // 最多记住多少首手动匹配（0 = 不再记住新的）
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
    settings.maxMatches = 500;   // 固定为 500，不受旧存储影响
    delete settings.nativeEmbed;     // 这两个开关已移除，清理旧存储里的值
    delete settings.fallbackLyrics;
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

    // ---- 纯音乐标记（标题 -> 标记时间） ----
    function isInstrumentalTitle(title) {
        return !!title && title in store.get(KEY_INSTR, {});
    }
    function saveInstrumental(title, on) {
        if (!title) return;
        const all = store.get(KEY_INSTR, {});
        if (on) all[title] = { t: Date.now() }; else delete all[title];
        store.set(KEY_INSTR, all);
    }

    /* ==================================================================
     * 听歌统计（按天累计实际播放秒数）
     * ================================================================== */
    let pending = {};   // 尚未写入存储的增量：{ 'YYYY-MM-DD': { s, songs: {title: sec} } }
    let lastTick = 0;

    function pad2(n) { return String(n).padStart(2, '0'); }
    function dayKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
    function startOfMonth(d) {          // 当月 1 日
        return new Date(d.getFullYear(), d.getMonth(), 1);
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
        const monthStart = dayKey(startOfMonth(new Date()));
        let month = 0;
        const artists = {};
        for (const [k, d] of Object.entries(stats.days)) {
            if (k < monthStart) continue;
            month += d.s || 0;
            for (const [t, sec] of Object.entries(d.songs || {})) {
                const artist = artistOf(t);
                if (artist) artists[artist] = (artists[artist] || 0) + sec;
            }
        }
        let top = '';
        let topSec = 0;
        for (const [name, sec] of Object.entries(artists)) {
            if (sec > topSec) { top = name; topSec = sec; }
        }
        return { month, top };
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
    let isInstrumental = false;        // 当前歌曲被标记为纯音乐

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
        --aml-menu-solid: rgba(44, 44, 46, 0.6);
        --aml-scroll-thumb: rgba(255, 255, 255, 0.28);
        --aml-scroll-thumb-hover: rgba(255, 255, 255, 0.45);
        --aml-sep: rgba(255, 255, 255, 0.14);
        --aml-input-bg: rgba(255, 255, 255, 0.08);
        --aml-seg-on: rgba(255, 255, 255, 0.22);
        --aml-switch-off: rgba(255, 255, 255, 0.22);
        --aml-ico-filter: none;
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
        --aml-menu-solid: rgba(246, 246, 246, 0.6);
        --aml-scroll-thumb: rgba(0, 0, 0, 0.24);
        --aml-scroll-thumb-hover: rgba(0, 0, 0, 0.42);
        --aml-sep: rgba(0, 0, 0, 0.1);
        --aml-input-bg: rgba(255, 255, 255, 0.85);
        --aml-seg-on: #ffffff;
        --aml-switch-off: rgba(0, 0, 0, 0.2);
        --aml-ico-filter: brightness(0) opacity(0.62);
        --aml-accent: #0a7aff;
        --aml-accent-fg: #ffffff;
        color-scheme: light;
        font-family: var(--aml-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif);
        box-sizing: border-box;
    }
    .aml-ui *, .aml-ui *::before, .aml-ui *::after { box-sizing: border-box; }
    @supports (-moz-appearance: none) {
        .aml-ui, .aml-ui * { scrollbar-width: thin; scrollbar-color: var(--aml-scroll-thumb) transparent; }
    }
    .aml-ui::-webkit-scrollbar,
    .aml-ui ::-webkit-scrollbar { width: 8px; height: 8px; }
    .aml-ui::-webkit-scrollbar-track,
    .aml-ui ::-webkit-scrollbar-track { background: transparent; }
    .aml-ui::-webkit-scrollbar-thumb,
    .aml-ui ::-webkit-scrollbar-thumb {
        background: var(--aml-scroll-thumb, rgba(0, 0, 0, 0.24));
        border: 2px solid transparent;
        border-radius: 8px;
        background-clip: padding-box;
    }
    .aml-ui::-webkit-scrollbar-thumb:hover,
    .aml-ui ::-webkit-scrollbar-thumb:hover {
        background: var(--aml-scroll-thumb-hover, rgba(0, 0, 0, 0.42));
        border: 2px solid transparent;
        background-clip: padding-box;
    }
    .aml-ui::-webkit-scrollbar-corner,
    .aml-ui ::-webkit-scrollbar-corner { background: transparent; }
    @media (prefers-color-scheme: dark) {
        .aml-ui:not([data-theme="light"]) { ${DARK_VARS} }
    }
    .aml-ui[data-theme="dark"] { ${DARK_VARS} }
    /* 全屏歌词停靠时固定深色，避免浅色主题在黑色播放器上发灰 */
    #aml-root.aml-fs-docked { ${DARK_VARS} }

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
        --aml-active-scale: 1;   /* 全屏歌词当前行额外放大倍数，1 = 关闭 */
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

    .aml-msg-btns { display: flex; gap: 6px; }

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
    /* 离当前行越远越模糊：每行的模糊半径由 JS 写进行内 filter（见 applyLineBlur） */
    .aml-group { transition: filter 0.25s ease; }
    .aml-group.active .aml-main { color: var(--aml-fg); transform: scale(1.14); }
    .aml-group.active .aml-trans { color: var(--aml-fg); opacity: 0.85; transform: scale(1.2); }
    /* 鼠标移到某一行时临时取消模糊，方便看清 */
    .aml-blur .aml-group:not(.active):hover { filter: none !important; }
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
    .aml-btn.aml-btn-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        padding: 5px 8px;
        line-height: 0;
    }
.aml-btn.aml-btn-round {
    width: 24px;
    height: 24px;
    min-width: 0;               /* 覆盖 .aml-btn 的 min-width:30px */
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    border-radius: 50%;
}
    .aml-btn.aml-btn-icon svg { display: block; }
    .aml-btn .aml-ico {
        display: block;
        width: 14px;
        height: 14px;
        object-fit: contain;
        pointer-events: none;
        -webkit-user-drag: none;
        filter: var(--aml-ico-filter, none);
    }
    /* 底部栏里保持「− / 偏移 / + / 放大」的顺序；全屏时用 DOM 顺序（+ / 偏移 / −） */
    .aml-bar-offset .aml-btn-minus { order: 1; }
    .aml-bar-offset .aml-btn-wide { order: 2; }
    .aml-bar-offset .aml-btn-plus { order: 3; }
    .aml-bar-offset .aml-btn-toggle { order: 4; }
    .aml-bar-sep { display: none; }
    .aml-btn:hover { opacity: 1; background: var(--aml-ctrl-hover); }
    .aml-btn.aml-btn-wide { min-width: 52px; }
    .aml-btn.aml-static { cursor: default; opacity: 0.6; }
    .aml-btn.aml-static:hover { background: var(--aml-ctrl); opacity: 0.6; }

    /* ---------- 弹出菜单 / 搜索面板 ---------- */
    .aml-pop {
        position: fixed;
        z-index: 10003;
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
    .aml-pop.aml-pop-narrow { min-width: 220px; max-width: 250px; }
    .aml-search.aml-search-narrow { width: 320px; border-radius: 12px; }
    .aml-pop.aml-pop-narrow,
    .aml-search.aml-search-narrow {
        background: var(--aml-menu-solid, var(--aml-menu-bg));
    }
    .aml-search-row { display: flex; gap: 6px; }

    /* ---------- 全屏歌词按钮上方的提示气泡 ---------- */
    .aml-tip {
        position: fixed;
        z-index: 10005;
        width: 300px;
        max-width: calc(100vw - 56px);
        box-sizing: border-box;
        padding: 10px 24px 10px 11px;
        border: 0.5px solid var(--aml-border);
        border-radius: 14px;
        background: var(--aml-menu-solid, var(--aml-menu-bg));
        -webkit-backdrop-filter: saturate(160%) blur(24px);
        backdrop-filter: saturate(160%) blur(24px);
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
        color: var(--aml-fg);
        text-align: left;
        pointer-events: auto;
        transform: translateX(-50%);
        transition: opacity 0.18s ease;
    }
    .aml-tip-title {
        margin: 0 0 4px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.3;
        color: var(--aml-fg);
    }
    .aml-tip-text {
        font-size: 12px;
        line-height: 1.5;
        color: var(--aml-fg-dim);
    }
    .aml-tip-close {
        position: absolute;
        top: 6px;
        right: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--aml-fg-faint);
        font: inherit;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        opacity: 0.65;
    }
    .aml-tip-close:hover {
        background: var(--aml-ctrl);
        color: var(--aml-fg);
        opacity: 1;
    }
    .aml-tip.aml-tip-status { transform: none; }
    .aml-tip-action {
        margin-top: 9px;
        padding: 4px 11px;
        border: 1px solid var(--aml-border);
        border-radius: 8px;
        background: var(--aml-ctrl);
        color: var(--aml-fg);
        font: inherit;
        font-size: 12px;
        line-height: 1.4;
        cursor: pointer;
    }
    .aml-tip-action:hover { background: var(--aml-ctrl-hover); }
    .aml-tip-note {
        margin-top: 7px;
        font-size: 11px;
        line-height: 1.5;
        color: #ff9f0a;
    }
    .aml-tip.aml-tip-hide { opacity: 0; }
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

    // 控件图标（base64 内嵌，保证脚本单文件即可使用）
    const ICON_MODEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGcAAABkBAMAAABp+zNkAAAACXBIWXMAAC4jAAAuIwF4pT92AAAAElBMVEVHcEz8/Pz8/Pz8/Pz8/Pz8/Py4jSrqAAAABnRSTlMAzIloO6/uDTAjAAACyUlEQVRYw82YS3OjMAyAHXDuVQJ3SMKdkO7dbJs7btP//1e2xA9sI6VyZmdndSPDF1myngjBFdkBHJXIkhJmqfscRmowVI6uFqzs+UwBXvgHPC8QW5WEQEKr3t8vwwEVIbYhNDnirQVSaiHG8Nmd7xc8kJ0QOvmTHxmoYpMAUn9i8mKjIfaEzoQakbgGkSk9yhRGCAltV5C38iO5nuNhOM7SI5D5pX7lRZ616R5WOyWyIEboJt7rjUn7jHidL7dwnn8kOgmrbRrtmIxxWInNEoKxGZ/BU5oaG9ykNnKOTOJ1NAoR0ys83Sv7+II6ucJvSlloQq9zT5ewM+rxFeSKpQkdJuTKsvJ6OdDcAGrXANhQamGfAUmVD0mtbCzyoTcN2VBrLzcL0s9ALozgGU3/KfRvber/libZnUKojMYhCjJlyEFlXCqIiJDmbQedXYuNbUqgwmi2UJmcg9BUmIpjoZYHmfrRFx6NCj1xPNMg9gbSkBR6KjVMgxhmyJT9GwMytb6eIb0aJanjxb0oKdlAZa4EZHoKIFRTrGoSLE2Rqp1gagpVNWxIkkNuCDVUM+8zIBm019Xvimo143qYXkETPtdUgoLwRj2iu4h0Yy8+Ekh0uigdhA8f3z8jS0/h4mqk2hcyZPk5ihioyGFs54sCc/06O1NKQN2HCninIcFMyHb5f82ZR5c31RIyjKVSnoNMtqPm6QfErmVVkj314XgJ7mk43PeI4Xvn676+0vQPRk1f5CSxtXgzitUWtqpj0QCbjJo+V0tqLVLo/tGvTgzI6We5JuWHUhQH9jWGCIs+ksssuwCS+LqLrGXyt4+n0a1781re3Te9y6t6sCU1XlHPz7HeKbqJHEgiLeaBbO7QFdi5skA670vKff+6Zn5I2SJxmQGpJ6CbyIfqDManyJQDlWhH531Sap6A9iJP2txvcc4TjciVoT5xXvsD6eu4Zi0yuskAAAAASUVORK5CYII=';
    const ICON_TRANSLATED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAG0AAABkBAMAAAB+2aOtAAAACXBIWXMAAC4jAAAuIwF4pT92AAAAElBMVEX8/PxHcEz8/Pz8/Pz8/Pz8/PxI5BHgAAAABnRSTlPMALBdMoh/iXVEAAADGklEQVRYw72YX7eiIBDAJ8x3CXp3u/muub1Ldt/Nm9//q6wK0oCo4O7Z6XQynZ8DI8wfgSrh9b29pDAKGeSiJbu0bdv1Uj4n7QQUdQcvIW+DYyn4yhfiAjCA6MOFYAC/Ju4RhAERkuNh5gCOkjsFYoPBgWtcl6bn1x+4ZthzXP3JSkFXhT/vakbxwKlhvqmH8JtUFj2Xj0cF9ROp/eq5VD9ML4uj+jEBHmSO0mo0kwCTE/UWqZ/AWT1JbxkGShI4TUuOhngm6T9B01MTrGD8EQFcgrgATK6TCobhkhBudGQ+cvH/4Jjkml1cM3LRP+K48U94cudUh9f+Fi3Aj/DhmLGNG3BeTyG1z6c62FEds154Em7ujKKrjsjxNlcBUmVTBBMWBzMux6pnMKyv2dPR9DWtfcsz3EoxNnfAXDyzB0vjPFKUAsgmV2FOzw82x3nCJz86YsseN6aUe3M6i0Z4FdjcfJzao5Fxl83n118ou9vnZN2VnpxyzhErEj8uwUuLOdeLk6vw3jmbCWTNXoo9mHit62lkseHfwourVtyyxqV4eg/XgnJyD2yBecYXdeGI9xWhHhxvcCa9zdL4AseMuuSGYuJ6/Kzw8pfx7DqP8+DmrkbR4cgPbnsR1iEF9bQXC6xTUE8uwjqkoMscnsEDF5TsS7jzexqep/+Ka3bWL5ILr5fynfWZ4nbUg4m9v7zqz2p3vRtaX3NVX1MIc8xJ9QGy1DgGDRMOwf2KzE9Fz8ncH4sAbICmfUHemySv2yk1Dv2fbjdJ1pU4oN+7Lhva9u6n/2aXC3xKlIGr7OZVyvdywyn7TWacO8zT+EJ/axqM7bppLoXijFsTs5xcaPxl3/8955bNxej9BO78N8xJx03vQ+rU5PLF1xrCeI/yeaZg1LmmXHRln4DdZBNkLvv97KWuy7IeDgQOFvZWJh9z0VqQsfcW0eaI8OXO0s1s3jSsc6puyWEzdrg4Bts7ec7BO4ftyOHg5h1KCHeluzhC93GvII472pogrgjjKGpxgrhmc2G6uRw8s6HFnXzfUVkc9xvljKOsybwyU/IHz6YsBFRa/pUAAAAASUVORK5CYII=';
    const ICON_SETTINGS = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkBAMAAACCzIhnAAAACXBIWXMAAC4jAAAuIwF4pT92AAAAElBMVEVHcEz7+/v7+/v7+/v7+/v7+/vJ1vWzAAAABnRSTlMAzKVQKXvX2/KTAAADV0lEQVRYw61YS5urIAy1PvYFdS/tzF7szB7r3H2t+v//yhV8BQiKcy8LZ77qgeTkJASCwDGeH4H/iNSTEPVH+CBilkkcIeX4h1OvRYj8LCTkNcIJ8VkmUR9fCLku/x+Ocf7Rsnp5HkBiMa0yWsbkc7RLQaLSCWmpUKuQezU+SF+R2SMnCbEy5kK08ZLm7UFGZmsdcpU/u6keHch/mA6hX+34q9sX4hipE8JdkMwJqV2QK/Z1dQ90sm7MgFS9AVH2roZ9/sjfmjcwrLVokz42IBazRBdCem4zDcmCyVW5aYOea3p/OjlIQPCMjLbMBWLBIQspdC/yiI4IJhoQ+RI1OttbpUCn0wgLb52IyJpU9nzKUSri90pBC6ZvUUdrMzYMUBVagZkKlQGpoQ8Mc2YlpzDmEAs+wyqVLgwOWIxQZ2bjM4P4cnv5chAg9DkoeJlhZVcXAAefJag4AjNgHBgTozSrgGVwS4Fi5CjNF7B4M7yZZkuIFi7lDB2GckuUTA817sz0JrLli9PcrqkR20mC08w3AXArFRNUAJdNmHFrZTZWHGaZUbEGIg8ckTUoE1vZSc0JKQqB4s+sxC0wYQrwxdUilApE/gIsWdgz5hqmgqGI7NDN7Axd91Dj+3uuD7Tc4C+zPNwdG+d9rdImJN2qirVvMgwSSzqYA7MDcSDoIjET4jbs47T7al9u7AI5kzxTPI7hBkmePijs3NDD/0czxhYMQwTTQsFYsowOZekn/hDMk5xIsUmXSpV2Ipd4Iueg2AjPcpFtdeywKNVr6Ut8Sx+zSl+mZz7a3i4FrxkG4l3GP7sSbBZif7OoDU7gloRTrIhNA5wjnGJr4zveXkNDItHxJs6N4JmtgpPiNHA1JOlhQ8KP257W6GIXKeTLisfNVQvqDd7CcRMS0qVR7PBGMZqKy9goFo529IV6kv7nptc6NOOtNWjgc8dkwfljQrlzckP2SKwWsvNHHrkL2gerZvaDPio7wkzum9vx7UsycnB8e3bmudI4JMbv/t+Por898P7iWC0P7w9y6vCudrtTVwTuiwiyY9h83dEn8Loj2jEs6adiQhUT09WKulQR/lc33Pu2p1QeFcvNksedknYNVfpcXSnxR1Pa+F12BfEEpP5Xaou0e9ebv2YpvbTGdi4iAAAAAElFTkSuQmCC';

    const ui = buildUI();

    function buildUI() {
        const root = h('div', { id: 'aml-root', class: 'aml-ui' });
        const viewport = h('div', { class: 'aml-viewport' });
        const content = h('div', { class: 'aml-content' });
        viewport.append(content);

        const settingsBtn = h('button', {
            class: 'aml-btn aml-btn-icon aml-btn-round', title: '设置',
            onclick: e => { e.stopPropagation(); toggleMenu(); }
        });
        settingsBtn.innerHTML = `<img class="aml-ico" src="${ICON_SETTINGS}" alt="" draggable="false">`;

        // 机器翻译状态图标：需要机翻的歌曲才显示（第二版布局）
        const statusBtn = h('button', {
            class: 'aml-btn aml-btn-icon aml-btn-round aml-btn-status', title: '机器翻译',
            onclick: e => { e.stopPropagation(); toggleStatusTip(); }
        });
        statusBtn.style.display = 'none';
        statusBtn.innerHTML = `<img class="aml-ico" src="${ICON_MODEL}" alt="" draggable="false">`;

        const minusBtn = h('button', {
            class: 'aml-btn aml-btn-round aml-btn-minus', text: '−', title: '歌词提前 0.2 秒',
            onclick: e => { e.stopPropagation(); changeOffset(-0.2); }
        });
        const offsetBtn = h('button', {
            class: 'aml-btn aml-btn-wide', text: '+0.0s', title: '点击归零',
            onclick: e => { e.stopPropagation(); changeOffset(0, true); }
        });
        const plusBtn = h('button', {
            class: 'aml-btn aml-btn-round aml-btn-plus', title: '歌词延后 0.2 秒',
            onclick: e => { e.stopPropagation(); changeOffset(0.2); }
        });
        // 用 SVG 画加号，避免字体里的 + 视觉重心偏低
        plusBtn.innerHTML = `<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d="M6 1.2v9.6M1.2 6h9.6" fill="none" stroke="currentColor"
                stroke-width="1.8" stroke-linecap="round"></path>
        </svg>`;
        const toggleBtn = h('button', {
            class: 'aml-btn aml-btn-icon aml-btn-round aml-btn-toggle', title: '放大',
            onclick: e => {
                e.stopPropagation();
                settings.minimized = !settings.minimized;
                saveSettings();
                applySize();
            }
        });

        // 全屏时竖排顺序为：设置 / 机翻状态 / 分隔线 / + / 偏移 / −
        const bar = h('div', { class: 'aml-bar aml-ui' },
            h('div', { class: 'aml-bar-group aml-bar-top' }, settingsBtn, statusBtn),
            h('div', { class: 'aml-bar-sep', 'aria-hidden': 'true' }),
            h('div', { class: 'aml-bar-group aml-bar-offset' }, plusBtn, offsetBtn, minusBtn, toggleBtn)
        );

        root.append(viewport, bar);
        document.body.appendChild(root);
        return { root, viewport, content, bar, settingsBtn, statusBtn, offsetBtn, toggleBtn };
    }

    const ICON_EXPAND = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <polyline points="15 3 21 3 21 9"></polyline>
    <polyline points="9 21 3 21 3 15"></polyline>
    <line x1="21" y1="3" x2="14" y2="10"></line>
    <line x1="3" y1="21" x2="10" y2="14"></line>
</svg>`;

    const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <polyline points="4 14 10 14 10 20"></polyline>
    <polyline points="20 10 14 10 14 4"></polyline>
    <line x1="14" y1="10" x2="21" y2="3"></line>
    <line x1="3" y1="21" x2="10" y2="14"></line>
</svg>`;

    function applySize() {
        ui.root.style.height = (settings.minimized ? HEIGHT_MIN : HEIGHT_MAX) + 'px';
        const expanded = !settings.minimized;          // 当前是放大状态
        ui.toggleBtn.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND;
        ui.toggleBtn.title = expanded ? '缩小' : '放大';
        ui.toggleBtn.setAttribute('aria-label', expanded ? '缩小歌词窗口' : '放大歌词窗口');
    }

    function applySettings() {
        ui.root.style.setProperty('--aml-scale', (settings.fontScale / 100).toFixed(2));
        ui.root.classList.toggle('aml-blur', !!settings.blur);
        ui.root.classList.toggle('aml-no-trans', !settings.showTranslation);
        document.querySelectorAll('.aml-ui').forEach(applyTheme);
        nativeSchedule(true);
        fallbackSync();
        refreshStatus();
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
        if (ui.root.classList.contains('aml-fs-docked')) return;
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
        if (statusTipEl) placeStatusTip();
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
        if (settings.pos && !ui.root.classList.contains('aml-fs-docked')) {
            setPosition(settings.pos.left, settings.pos.top);
        }
        if (pop) placePopover(pop.el, pop.anchor);
        if (statusTipEl) placeStatusTip();
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
    /* ==================================================================
     * 机器翻译状态图标 / 气泡
     *
     * 有自带翻译的歌曲不显示图标（第一版样子）；需要机器翻译时显示
     * 第二版布局：设置下面多一个状态图标，点开是 aml-ui aml-tip 气泡。
     * ================================================================== */
    let tipText = null;        // 临时状态文字（下载进度 / 失败原因等）
    let flashTimer = 0;
    let statusTipEl = null;

    function machineState() {
        if (isInstrumental || currentLyrics.length === 0) return null;
        if (hasHumanTranslation || settings.showTranslation === false) return null;

        // 还有语言包没下完时优先提示下载
        if (machinePending.length) {
            return { kind: 'download', langs: [...new Set(machinePending)] };
        }
        if (machineTranslated) return { kind: 'done' };

        // 语言检测已完成，整首歌没有需要翻译的外语行（纯中文、零星 ad-lib 等）
        if (lineLangs.length > 0 && !lineLangs.some(Boolean)) return null;

        if (translatorInfo && translatorInfo.status) {
            const entries = Object.entries(translatorInfo.status);
            if (entries.length === 0) return null;      // 中文歌词，不需要翻译
            const downloading = entries
                .filter(([, st]) => st === 'downloadable' || st === 'downloading')
                .map(([lang]) => lang);
            if (downloading.length) return { kind: 'download', langs: downloading };
            if (entries.every(([, st]) => st === 'unavailable')) {
                return { kind: 'unsupported', lang: entries[0][0] };
            }
            return null;                                // 已尝试翻译但没有可用译文
        }
        if (translatingId) return translatorInfo ? { kind: 'working' } : { kind: 'detect' };
        if (settings.autoTranslate === false) return null;   // 没开自动翻译时不显示状态
        if (!builtin('Translator')) return { kind: 'unsupported' };
        return { kind: 'detect' };
    }

    function statusInfo() {
        const st = machineState();
        if (!st) return null;
        let title, text, action = null;
        if (st.kind === 'done') {
            title = '已使用机器翻译';
            text = '当前歌曲没有自带翻译，成功使用了浏览器自带的机器翻译。';
        } else if (st.kind === 'working') {
            title = '正在使用机器翻译';
            text = '当前歌曲没有自带翻译，正在使用浏览器自带的机器翻译…';
        } else if (st.kind === 'detect') {
            title = '正在检测翻译模型';
            text = '当前歌曲没有自带翻译，正在确认浏览器可用的机器翻译模型…';
        } else if (st.kind === 'unsupported') {
            title = '不支持翻译模型';
            text = st.lang
                ? `当前语言（${langName(st.lang)}）没有可用的翻译模型，请换用 Chrome 或 Edge 浏览器。`
                : '当前浏览器不支持自带的机器翻译接口，请换用 Chrome 或 Edge 浏览器。';
        } else {
            title = '需下载翻译模型';
            text = '当前歌曲没有自带翻译，将使用浏览器自带的机器翻译。';
            const langs = st.langs || [];
            action = {
                text: langs.length ? `下载${langName(langs[0])}模型` : '下载翻译模型',
                onClick: () => translateCurrent(true)
            };
        }
        return { kind: st.kind, title, text, action };
    }

    function statusNote() {
        if (!tipText) return '';
        if (tipText === '机翻' || tipText === '翻译中…' ||
            tipText === '下载翻译模型' || tipText === '纯音乐') return '';
        return tipText;
    }

    function refreshStatus() {
        if (!ui || !ui.statusBtn) return;
        const info = statusInfo();
        if (!info) {
            ui.statusBtn.style.display = 'none';
            closeStatusTip();
            return;
        }
        ui.statusBtn.style.display = '';
        const src = info.kind === 'done' ? ICON_TRANSLATED : ICON_MODEL;
        const img = ui.statusBtn.querySelector('img');
        if (img && img.getAttribute('src') !== src) img.setAttribute('src', src);
        const note = statusNote();
        ui.statusBtn.title = note ? `${info.title} · ${note}` : info.title;
        ui.statusBtn.setAttribute('aria-label', info.title);
        if (statusTipEl) renderStatusTip();
    }

    function statusTipAnchor() {
        return ui.statusBtn.getBoundingClientRect();
    }

    function placeStatusTip() {
        if (!statusTipEl || !ui.statusBtn) return;
        const fullscreen = ui.bar.classList.contains('aml-fs-bar') ||
            ui.root.classList.contains('aml-fs-docked');
        if (fullscreen) ui.bar.classList.add('aml-fs-measure');
        const r = statusTipAnchor();
        statusTipEl.style.maxHeight = `${window.innerHeight - 16}px`;
        const w = statusTipEl.offsetWidth || 300;
        const hgt = statusTipEl.offsetHeight || 120;

        if (fullscreen) {
            // 全屏：气泡放在图标左边，不挡右侧胶囊
            let left = r.left - w - 22;
            if (left < 8) left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right + 14));
            let top = r.top + r.height / 2 - hgt / 2;
            top = Math.max(8, Math.min(top, window.innerHeight - hgt - 8));
            statusTipEl.style.left = left + 'px';
            statusTipEl.style.top = top + 'px';
            ui.bar.classList.remove('aml-fs-measure');
            return;
        }

        // 悬浮窗模式：气泡放到窗口下面，并留出小间距
        const rootRect = ui.root.getBoundingClientRect();
        const gap = 8;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        let top = rootRect.bottom + gap;
        if (top + hgt > window.innerHeight - 8) top = Math.max(8, rootRect.top - hgt - gap);
        statusTipEl.style.left = left + 'px';
        statusTipEl.style.top = top + 'px';
    }

    function renderStatusTip() {
        if (!statusTipEl) return;
        const info = statusInfo();
        if (!info) { closeStatusTip(); return; }
        const note = statusNote();
        const close = h('button', { class: 'aml-tip-close', type: 'button', 'aria-label': '关闭', text: '×' });
        close.addEventListener('click', e => { e.stopPropagation(); closeStatusTip(); });
        const children = [
            h('div', { class: 'aml-tip-title', text: info.title }),
            h('div', { class: 'aml-tip-text', text: info.text })
        ];
        if (note) children.push(h('div', { class: 'aml-tip-note', text: note }));
        if (info.action) {
            const btn = h('button', { class: 'aml-tip-action', type: 'button', text: info.action.text });
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const run = info.action.onClick;
                closeStatusTip();
                run();
            });
            children.push(btn);
        }
        children.push(close);
        statusTipEl.replaceChildren(...children);
        placeStatusTip();
    }

    function closeStatusTip() {
        if (!statusTipEl) return;
        statusTipEl.remove();
        statusTipEl = null;
        document.removeEventListener('pointerdown', onStatusOutside, true);
        document.removeEventListener('keydown', onStatusEscape, true);
        syncBarActive();
    }

    function onStatusOutside(e) {
        if (!statusTipEl) return;
        if (statusTipEl.contains(e.target) || ui.statusBtn.contains(e.target)) return;
        closeStatusTip();
    }

    function onStatusEscape(e) {
        if (e.key === 'Escape') closeStatusTip();
    }

    function toggleStatusTip() {
        if (statusTipEl) { closeStatusTip(); return; }
        const info = statusInfo();
        if (!info) return;
        const el = h('div', { class: 'aml-ui aml-tip aml-tip-status', role: 'tooltip' });
        el.style.transform = 'none';
        applyTheme(el);
        if (ui.root.classList.contains('aml-fs-docked') || ui.bar.classList.contains('aml-fs-bar')) {
            el.dataset.theme = 'dark';
        }
        document.body.appendChild(el);
        statusTipEl = el;
        syncBarActive();
        renderStatusTip();
        document.addEventListener('pointerdown', onStatusOutside, true);
        document.addEventListener('keydown', onStatusEscape, true);
    }

    function setTip(text) {
        tipText = text || null;
        refreshStatus();
    }

    function flashTip(text) {
        setTip(text);
        clearTimeout(flashTimer);
        const shown = text;
        flashTimer = setTimeout(() => {
            if (tipText === shown) restoreTip();
        }, 3000);
    }

    // extra: 可选的附加按钮 { text, onClick }
    function showMessage(text, withSearch, sub, extra) {
        isInstrumental = false;
        currentLyrics = [];
        translations = [];
        activeIndex = -1;
        nativeClear();
        fallbackDetach();
        setTip(null);
        ui.content.className = 'aml-content aml-msg';
        ui.content.replaceChildren(...[
            h('div', { class: 'aml-msg-text', text }),
            sub ? h('div', { class: 'aml-msg-sub', text: sub }) : null,
            (withSearch || extra) ? h('div', { class: 'aml-msg-btns' },
                withSearch ? h('button', {
                    class: 'aml-btn', text: '手动搜索',
                    onclick: e => { e.stopPropagation(); openSearch(); }
                }) : null,
                extra ? h('button', {
                    class: 'aml-btn', text: extra.text,
                    onclick: e => { e.stopPropagation(); extra.onClick(); }
                }) : null
            ) : null
        ].filter(Boolean));
        fallbackSync();   // 全屏歌词弹层打开时，把“暂无歌词 / 纯音乐”也显示在歌词位置
    }

    // 纯音乐：歌词区显示提示，不显示机器翻译状态图标
    function showInstrumental() {
        currentSongId = null;
        hasHumanTranslation = false;
        machineTranslated = false;
        machinePending = [];
        lineLangs = [];
        translatorInfo = null;
        showMessage('纯音乐请欣赏', false, null,
            { text: '取消纯音乐标记', onClick: () => markInstrumental(false) });
        isInstrumental = true;
        setTip('纯音乐');
        refreshMenu();
    }

    // 标记 / 取消标记当前歌曲
    function markInstrumental(on) {
        const title = currentSongTitle;
        if (!title) return;
        saveInstrumental(title, on);
        ++loadToken;                 // 使仍在进行的加载 / 翻译失效
        if (on) showInstrumental();
        else loadLyricsForTitle(title);
        refreshMenu();
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
        nativeSchedule(true);
        updateLyricScroll(lastTime, true, true);
        fallbackSync();
    }

    // 全屏歌词里当前行不再垂直居中：整块内容上移一点（占视口高度的比例）
    const FS_ACTIVE_LIFT = 0.08;
    // 离当前行越远越模糊。上方是已经唱完的句子，斜率更大、上限更高；
    // 刚唱过的那几句明显退到后面，视线更集中在当前行
    const BLUR_STEP = 1.2;       // 下方（还没唱到）每远一行增加的模糊（px）
    const BLUR_MAX = 6;          // 下方模糊上限
    const BLUR_STEP_UP = 2.6;    // 上方（已唱过）每远一行增加的模糊（px）
    const BLUR_MAX_UP = 12;      // 上方模糊上限
    const BLUR_RANGE = 16;   // 超过这个行距的歌词已在视口外，不再套 filter，省性能

    function centerActive(instant) {
        const active = ui.content.querySelector('.aml-group.active');
        if (!active) return;
        const y = active.offsetTop + active.offsetHeight / 2;
        const vh = ui.viewport.clientHeight;
        // 全屏时当前行落在视口 42% 处；悬浮窗保持原来的正中
        const docked = ui.root.classList.contains('aml-fs-docked');
        const anchor = vh * (docked ? 0.5 - FS_ACTIVE_LIFT : 0.5);
        const ty = Math.round(anchor - y);
        const c = ui.content;
        if (instant) {
            c.style.transition = 'none';
            c.style.transform = `translateY(${ty}px)`;
            void c.offsetHeight;
            c.style.transition = '';
        } else {
            c.style.transform = `translateY(${ty}px)`;
        }
        applyLineBlur();
    }

    // 按行号距离给每一行写模糊半径；上方累加得更快、封顶更高
    function applyLineBlur() {
        const groups = ui.content.children;
        if (!groups.length || activeIndex < 0) return;
        const on = !!settings.blur;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const off = i - activeIndex;          // <0 已唱过，>0 还没唱到
            const d = Math.abs(off);
            let px = 0;
            if (on && d > 0 && d <= BLUR_RANGE) {
                px = off < 0
                    ? Math.min(BLUR_MAX_UP, d * BLUR_STEP_UP)
                    : Math.min(BLUR_MAX, d * BLUR_STEP);
            }
            const val = px ? `blur(${px.toFixed(2)}px)` : '';
            if (g.style.filter !== val) g.style.filter = val;   // 避免无意义的样式写入
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
     * 全屏歌词内嵌翻译
     *
     * Apple Music 的全屏播放器用 <amp-lyrics> 组件渲染歌词，每一行是
     * <amp-lyrics-display-synced-line>，行内是 .primary-vocals 原文。
     * 这里把插件的翻译插到每一行下面，尽量贴近 Apple 自带「理解歌词」
     * （show-translation）的排版；找不到对应行时保留原来的悬浮窗。
     * ================================================================== */
    const NATIVE_HOST_SEL = 'amp-lyrics';
    const NATIVE_LINE_SEL = 'amp-lyrics-display-synced-line';
    const NATIVE_CSS = `
        .aml-inline-trans {
            display: block !important;
            margin: 0.12em 0 0 !important;
            font-size: 0.62em !important;
            font-weight: 500 !important;
            line-height: 1.28 !important;
            letter-spacing: 0 !important;
            text-align: inherit !important;
            white-space: pre-wrap !important;
            overflow-wrap: anywhere !important;
            color: inherit !important;
            opacity: 0.62;
            transition: opacity 0.25s ease;
            pointer-events: none !important;
        }
        amp-lyrics-display-synced-line[is-current] .aml-inline-trans,
        amp-lyrics-display-synced-line.is-current .aml-inline-trans,
        .display-synced-line.is-current .aml-inline-trans,
        .line.is-current .aml-inline-trans {
            opacity: 0.92;
        }

        /* ---------- Apple 没有歌词时：把插件歌词停靠进全屏播放器 ---------- */
        .lyrics__container.aml-fb-on {
            grid-template-columns: 32vw 40vw !important;
            padding: 0 10vw !important;
        }
        @media (min-width: 1680px) {
            .lyrics__container.aml-fb-on {
                grid-template-columns: 31vw 38vw !important;
                padding: 0 12vw !important;
            }
        }
        @media (min-width: 2000px) {
            .lyrics__container.aml-fb-on {
                grid-template-columns: 30vw 38vw !important;
                padding: 0 13vw !important;
            }
        }
        @media (min-width: 2561px) {
            .lyrics__container.aml-fb-on {
                grid-template-columns: calc(30% + 199.68px) calc(38% + 252.928px) !important;
                padding: 0 13% !important;
            }
        }

        #aml-root.aml-fs-docked {
            position: relative !important;
            inset: auto !important;
            grid-area: lyrics;
            width: 100% !important;
            height: 100% !important;
            min-height: 0;
            max-width: 972.8px;
            border: 0 !important;
            border-radius: 0 !important;
            background: transparent !important;
            -webkit-backdrop-filter: none !important;
            backdrop-filter: none !important;
            box-shadow: none !important;
            z-index: 1 !important;
            text-align: left;
            color: var(--lyrics-line-color, rgba(255, 255, 255, 0.5));
        }
        /* ---------- 全屏右侧控件：竖排胶囊，固定在右上角 ---------- */
        #aml-root.aml-fs-docked .aml-bar,
        .aml-bar.aml-fs-bar {
            --aml-fg: #fff;
            --aml-fg-dim: rgba(255, 255, 255, 0.78);
            --aml-fg-faint: rgba(255, 255, 255, 0.55);
            --aml-ctrl: rgba(255, 255, 255, 0.14);
            --aml-ctrl-hover: rgba(255, 255, 255, 0.26);
            --aml-ico-filter: none;
            top: 76px;
            right: 22px;
            bottom: auto;
            left: auto;
            position: fixed;
            width: 72px;
            height: auto;
            transform: scale(0.6);
            transform-origin: top right;
            transition: transform 0.18s ease;
            pointer-events: auto;
            flex-direction: column;
            justify-content: flex-start;
            align-items: center;
            gap: 0;
            padding: 18px 0;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 36px;
            background: rgba(255, 255, 255, 0.09);
            -webkit-backdrop-filter: saturate(160%) blur(24px);
            backdrop-filter: saturate(160%) blur(24px);
            opacity: .7;
            visibility: visible;
            z-index: 10002;
        }
        /* 平时只有一半大小；悬停或正在操作菜单 / 气泡时恢复原大小 */
        #aml-root.aml-fs-docked .aml-bar:hover,
        #aml-root.aml-fs-docked .aml-bar.aml-fs-active,
        .aml-bar.aml-fs-bar:hover,
        .aml-bar.aml-fs-bar.aml-fs-active {
            transform: scale(.8);
        }
        /* 计算菜单 / 气泡位置时强制展开，避免还在缩放动画中导致定位不准 */
        #aml-root.aml-fs-docked .aml-bar.aml-fs-measure,
        .aml-bar.aml-fs-bar.aml-fs-measure {
            transition: none !important;
            transform: scale(.8) !important;
        }
        #aml-root.aml-fs-docked .aml-bar-group,
        .aml-fs-bar .aml-bar-group {
            flex-direction: column;
            align-items: center;
            gap: 0;
        }
        .aml-fs-bar .aml-bar-top { gap: 10px; }
        .aml-fs-bar .aml-bar-offset { gap: 8px; }
        .aml-fs-bar .aml-bar-offset .aml-btn { order: 0; }
        /* 全屏里窗口高度由歌词栏决定，放大/缩小没有意义 */
        #aml-root.aml-fs-docked .aml-btn-toggle,
        .aml-fs-bar .aml-btn-toggle {
            display: none !important;
        }
        #aml-root.aml-fs-docked .aml-bar .aml-btn,
        .aml-fs-bar .aml-btn {
            flex: 0 0 auto;
            width: 44px;
            height: 44px;
            min-width: 0;
            padding: 0;
            margin: 0;
            border-radius: 50%;
            background: transparent;
            color: var(--aml-fg-dim);
            font-size: 24px;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            opacity: 0.92;
        }
        #aml-root.aml-fs-docked .aml-bar .aml-btn:hover,
        .aml-fs-bar .aml-btn:hover {
            background: var(--aml-ctrl);
            opacity: 1;
        }
        #aml-root.aml-fs-docked .aml-bar .aml-btn svg,
        .aml-fs-bar .aml-btn svg { width: 18px; height: 18px; }
        /* 设置 / 机翻状态：图标直接浮在胶囊上，没有圆形底 */
        #aml-root.aml-fs-docked .aml-bar .aml-btn-icon,
        .aml-fs-bar .aml-btn-icon {
            width: 44px;
            height: 44px;
            background: transparent;
        }
        #aml-root.aml-fs-docked .aml-bar .aml-btn-icon > .aml-ico,
        .aml-fs-bar .aml-btn-icon > .aml-ico {
            width: 30px;
            height: 30px;
        }
        /* 加号 / 减号：圆形按钮 */
        #aml-root.aml-fs-docked .aml-bar .aml-btn-round:not(.aml-btn-icon),
        .aml-fs-bar .aml-btn-round:not(.aml-btn-icon) {
            background: var(--aml-ctrl);
        }
        #aml-root.aml-fs-docked .aml-bar .aml-btn-round:not(.aml-btn-icon):hover,
        .aml-fs-bar .aml-btn-round:not(.aml-btn-icon):hover {
            background: var(--aml-ctrl-hover);
        }
        /* 偏移量：横向文字，和上下的圆形按钮同宽 */
        #aml-root.aml-fs-docked .aml-bar .aml-btn-wide,
        .aml-fs-bar .aml-btn-wide {
            width: auto;
            min-width: 56px;
            height: 34px;
            padding: 0 4px;
            border-radius: 10px;
            background: transparent;
            color: var(--aml-fg);
            font-size: 17px;
            font-weight: 600;
            letter-spacing: 0.2px;
            font-variant-numeric: tabular-nums;
            writing-mode: horizontal-tb;
            text-orientation: mixed;
            line-height: 1;
        }
        #aml-root.aml-fs-docked .aml-bar .aml-btn-wide:hover,
        .aml-fs-bar .aml-btn-wide:hover {
            background: transparent;
        }
        /* 图标区和加减区之间的分隔线 */
        .aml-fs-bar .aml-bar-sep {
            display: block;
            width: 26px;
            height: 1px;
            margin: 16px 0;
            border-radius: 1px;
            background: rgba(255, 255, 255, 0.3);
        }
        #aml-root.aml-fs-docked .aml-viewport {
            padding: 0 58px 0 6px;
            cursor: default;
            -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16%, #000 84%, transparent 100%);
            mask-image: linear-gradient(to bottom, transparent 0, #000 16%, #000 84%, transparent 100%);
        }
        #aml-root.aml-fs-docked .aml-group {
            padding: 0 0 var(--lyrics-line-margin-bottom, 42px);
        }
        @media (min-width: 1680px) {
            #aml-root.aml-fs-docked .aml-group { padding-bottom: 54px; }
        }
        @media (min-width: 2000px) {
            #aml-root.aml-fs-docked .aml-group { padding-bottom: 82px; }
        }
        #aml-root.aml-fs-docked .aml-main {
            font-size: calc(var(--lyrics-line-font-size, 32px) * var(--aml-scale, 1));
            line-height: var(--lyrics-line-line-height, 1.2);
            font-weight: 600;
            color: var(--lyrics-line-color, rgba(255, 255, 255, 0.5));
            transform-origin: left center;
        }
        #aml-root.aml-fs-docked .aml-trans {
            margin-top: 0.12em;
            font-size: calc(var(--lyrics-line-supplementary-font-size, 18px) * var(--aml-scale, 1));
            line-height: 1.3;
            font-weight: 500;
            color: inherit;
            opacity: 0.8;
            transform-origin: left center;
            overflow-wrap: anywhere;
        }
        #aml-root.aml-fs-docked .aml-group.active .aml-main {
            color: var(--lyrics-line-color-current, #fff);
            transform: scale(calc(var(--lyrics-current-line-scale, 1.05) * var(--aml-active-scale, 1.1)));
        }
        #aml-root.aml-fs-docked .aml-group.active .aml-trans {
            color: var(--lyrics-line-color-current, #fff);
            opacity: 0.9;
            transform: scale(calc(var(--lyrics-current-line-scale, 1.05) * var(--aml-active-scale, 1.1)));
        }
    `;
    injectCss(NATIVE_CSS);

    const nativeState = {
        host: null,
        observer: null,
        observed: new WeakSet(),
        byLine: new WeakMap(),
        nodes: new Set(),
        key: '',
        align: [],
        textTranslations: [],
        timer: 0,
        nativeTranslation: false,
        hasTranslations: null
    };

    function nativeVisible(el) {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 220 || rect.height < 140) return false;
        if (rect.bottom < 0 || rect.right < 0 ||
            rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }

    // 歌词组件的内部结构可能在 shadow DOM 里，递归收集所有歌词行
    function nativeCollectLines(root) {
        const out = [];
        if (!root) return out;
        const seen = new Set();
        let budget = 20000;
        const scan = scope => {
            if (!scope || budget <= 0) return;
            for (const el of scope.querySelectorAll('*')) {
                if (--budget <= 0) return;
                if (el.localName === NATIVE_LINE_SEL && !seen.has(el)) {
                    seen.add(el);
                    out.push(el);
                }
                if (el.shadowRoot) scan(el.shadowRoot);
            }
        };
        scan(root);
        return out;
    }

    // 静态歌词（不滚动）用 <amp-lyrics-display-static> + .static-line，标签不同
    function nativeHasStaticLyrics(root) {
        let found = false;
        const scan = scope => {
            if (found || !scope) return;
            for (const el of scope.querySelectorAll('*')) {
                if (el.localName === 'amp-lyrics-display-static') {
                    const sr = el.shadowRoot || el;
                    const line = sr.querySelector('.static-line');
                    if (line && line.textContent.trim()) { found = true; return; }
                }
                if (el.shadowRoot) scan(el.shadowRoot);
            }
        };
        scan(root);
        return found;
    }

    function nativeHasAppleLyrics(root) {
        return nativeCollectLines(root).length > 0 || nativeHasStaticLyrics(root);
    }

    // Apple 的“暂无歌词”空状态
    function nativeEmptyLyricsView(article) {
        return !!article.querySelector('.lyrics__empty');
    }

    function nativeFindHost() {
        let best = null;
        let bestArea = 0;
        for (const host of document.querySelectorAll(NATIVE_HOST_SEL)) {
            if (!nativeVisible(host)) continue;
            const rect = host.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area <= bestArea) continue;          // 同时存在侧栏 / 全屏时取面积大的
            if (!nativeCollectLines(host.shadowRoot || host).length) continue;
            best = host;
            bestArea = area;
        }
        return best;
    }

    function nativeContentRoot(line) {
        const sr = line.shadowRoot;
        if (sr && (sr.querySelector('.primary-vocals') || sr.querySelector('button'))) return sr;
        return line;
    }

    function nativeLineText(line) {
        const root = nativeContentRoot(line);
        const layers = root.querySelectorAll('.primary-vocals, .secondary-vocals');
        const parts = [];
        const clean = el => {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('rt, rp, [class*="pronunciation" i], [class*="transliteration" i], .aml-inline-trans')
                .forEach(n => n.remove());
            return clone.textContent.replace(/\s+/g, ' ').trim();
        };
        for (const el of layers) {
            const t = clean(el);
            if (t) parts.push(t);
        }
        if (!parts.length) {
            const fallback = root.querySelector('button.line') || root;
            const t = clean(fallback);
            if (t) parts.push(t);
        }
        return parts.join(' ');
    }

    function nativeNorm(text) {
        return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    }

    // 字符二元组 Dice 系数：对中日文和英文都够用，而且不用管分词
    function nativeSimilarity(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (a.includes(b) || b.includes(a)) {
            const short = Math.min(a.length, b.length);
            if (short >= 3) return 0.86;
        }
        if (a.length < 2 || b.length < 2) return 0;
        const grams = new Map();
        for (let i = 0; i < a.length - 1; i++) {
            const g = a.slice(i, i + 2);
            grams.set(g, (grams.get(g) || 0) + 1);
        }
        let hit = 0;
        for (let i = 0; i < b.length - 1; i++) {
            const g = b.slice(i, i + 2);
            const n = grams.get(g) || 0;
            if (n) { hit++; grams.set(g, n - 1); }
        }
        return (2 * hit) / (a.length + b.length - 2);
    }

    // 按顺序对齐两组歌词，返回「每一行 Apple 歌词 -> currentLyrics 下标（-1 表示没有）」
    function nativeAlign(appleTexts, lyricTexts) {
        const m = appleTexts.length;
        const n = lyricTexts.length;
        const out = new Array(m).fill(-1);
        if (!m || !n) return out;

        const A = appleTexts.map(nativeNorm);
        const B = lyricTexts.map(nativeNorm);
        const W = n + 1;
        const dp = new Float32Array((m + 1) * W);
        const from = new Uint8Array((m + 1) * W);
        const bestJ = new Int16Array(m).fill(-1);
        const bestSim = new Float32Array(m);
        const GAP = 0.3;
        const MIN = 0.34;

        for (let i = 1; i <= m; i++) { dp[i * W] = dp[(i - 1) * W] - GAP; from[i * W] = 1; }
        for (let j = 1; j <= n; j++) { dp[j] = dp[j - 1] - GAP; from[j] = 2; }

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const sim = nativeSimilarity(A[i - 1], B[j - 1]);
                if (sim > bestSim[i - 1]) { bestSim[i - 1] = sim; bestJ[i - 1] = j - 1; }
                const diag = dp[(i - 1) * W + j - 1] + (sim >= MIN ? sim : -1e6);
                const up = dp[(i - 1) * W + j] - GAP;
                const left = dp[i * W + j - 1] - GAP;
                let best = diag, dir = 0;
                if (up > best) { best = up; dir = 1; }
                if (left > best) { best = left; dir = 2; }
                dp[i * W + j] = best;
                from[i * W + j] = dir;
            }
        }

        let i = m, j = n;
        while (i > 0 && j > 0) {
            const dir = from[i * W + j];
            if (dir === 0) { out[i - 1] = j - 1; i--; j--; }
            else if (dir === 1) i--;
            else j--;
        }

        // 组件如果只渲染当前窗口附近的几十行，顺序对齐会整体错位；
        // 顺序对齐结果明显对不上、但文本又高度相似时，改用文本匹配
        for (let k = 0; k < m; k++) {
            if (bestSim[k] < 0.78) continue;
            const dpSim = out[k] >= 0 ? nativeSimilarity(A[k], B[out[k]]) : 0;
            if (out[k] < 0 || dpSim < 0.5) out[k] = bestJ[k];
        }
        return out;
    }

    // Apple 有时会把网易云的两三行合并成一行；把被跳过、且原文确实
    // 包含在这一行里的译文接起来，避免只显示半句
    function nativeMergeTranslations(appleTexts, align) {
        const m = align.length;
        const n = currentLyrics.length;
        const nextMatch = new Array(m).fill(n);
        let nx = n;
        for (let k = m - 1; k >= 0; k--) {
            nextMatch[k] = nx;
            if (align[k] >= 0) nx = align[k];
        }
        return align.map((j, k) => {
            if (j < 0) return '';
            const parts = [];
            if (translations[j]) parts.push(translations[j]);
            const apple = nativeNorm(appleTexts[k]);
            for (let t = j + 1; t < nextMatch[k]; t++) {
                const b = nativeNorm(currentLyrics[t].text);
                if (b.length >= 4 && apple.includes(b) && translations[t]) parts.push(translations[t]);
            }
            return parts.join(' ');
        });
    }

    function nativeTarget(line) {
        const root = nativeContentRoot(line);
        const btn = root.querySelector('button.line') || root.querySelector('button');
        if (btn) {
            const layers = btn.querySelectorAll('.primary-vocals, .secondary-vocals');
            return { parent: btn, after: layers[layers.length - 1] || null };
        }
        const ruby = root.querySelector('.display-synced-line') || root.querySelector('ruby');
        if (ruby && ruby.parentElement) return { parent: ruby.parentElement, after: ruby };
        return { parent: root, after: null };
    }

    function nativeOwnTranslation(line) {
        const root = nativeContentRoot(line);
        for (const el of root.querySelectorAll('[class*="translat" i], amp-lyrics-display-translation')) {
            if (el.classList.contains('aml-inline-trans')) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
        }
        return false;
    }

    function nativeIsShadowRoot(node) {
        return !!node && node.nodeType === 11 && !!node.host;
    }

    function nativeShadowStyle(root) {
        if (!nativeIsShadowRoot(root)) return;
        if (root.querySelector('style[data-aml-native]')) return;
        const style = document.createElement('style');
        style.setAttribute('data-aml-native', '');
        style.textContent = NATIVE_CSS;
        root.appendChild(style);
    }

    function nativeRemoveNode(line) {
        const node = nativeState.byLine.get(line);
        if (node) {
            node.remove();
            nativeState.nodes.delete(node);
            nativeState.byLine.delete(line);
        }
    }

    function nativeSetTranslation(line, text) {
        let node = nativeState.byLine.get(line);
        if (!text) { if (node) nativeRemoveNode(line); return; }
        if (node && !node.isConnected) {
            nativeState.nodes.delete(node);
            nativeState.byLine.delete(line);
            node = null;
        }
        if (!node) {
            const target = nativeTarget(line);
            if (!target.parent) return;
            node = document.createElement('div');
            node.className = 'aml-inline-trans';
            node.setAttribute('lang', 'zh-CN');
            if (target.after) target.after.insertAdjacentElement('afterend', node);
            else target.parent.appendChild(node);
            nativeShadowStyle(node.getRootNode());
            nativeState.byLine.set(line, node);
            nativeState.nodes.add(node);
        }
        if (node.textContent !== text) node.textContent = text;
    }

    function nativeClear() {
        for (const node of [...nativeState.nodes]) node.remove();
        nativeState.nodes.clear();
        nativeState.byLine = new WeakMap();
    }

    function nativeObserve(root) {
        if (!nativeState.observer || !root || !nativeIsShadowRoot(root) || nativeState.observed.has(root)) return;
        nativeState.observed.add(root);
        nativeState.observer.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['show-translation']
        });
    }

    function nativeAttach(host) {
        if (nativeState.host && nativeState.host !== host) {
            try { nativeState.host.removeEventListener('lyricsReady', nativeOnReady); } catch (e) { /* 忽略 */ }
        }
        nativeState.host = host;
        nativeState.key = '';
        if (nativeState.observer) nativeState.observer.disconnect();
        nativeState.observed = new WeakSet();
        nativeState.observer = new MutationObserver(() => nativeSchedule());
        host.addEventListener('lyricsReady', nativeOnReady);
        nativeObserve(host);
        nativeObserve(host.shadowRoot);
    }

    function nativeOnReady(e) {
        nativeState.hasTranslations = !!(e && e.detail && e.detail.hasTranslations);
        nativeState.key = '';
        nativeSchedule();
    }

    function nativeDetach() {
        if (nativeState.observer) {
            nativeState.observer.disconnect();
            nativeState.observer = null;
        }
        if (nativeState.host) {
            try { nativeState.host.removeEventListener('lyricsReady', nativeOnReady); } catch (e) { /* 忽略 */ }
        }
        nativeState.host = null;
        nativeState.key = '';
        nativeState.align = [];
        nativeState.textTranslations = [];
        nativeState.nativeTranslation = false;
        nativeState.hasTranslations = null;
        nativeClear();
    }

    function nativeSchedule(invalidate) {
        if (invalidate) nativeState.key = '';
        if (nativeState.timer) return;
        nativeState.timer = setTimeout(() => {
            nativeState.timer = 0;
            nativeSync();
        }, 120);
    }

    function nativeSync() {
        try {
            nativeSyncInner();
        } catch (e) {
            console.error('[AML] 全屏歌词翻译失败:', e);
            nativeDetach();
        }
    }

    function nativeSyncInner() {
        if (settings.showTranslation === false) { nativeDetach(); return; }

        let host = nativeState.host;
        if (!host || !host.isConnected || !nativeVisible(host)) host = nativeFindHost();
        if (!host) { nativeDetach(); return; }
        if (host !== nativeState.host) nativeAttach(host);

        const lines = nativeCollectLines(host.shadowRoot || host);
        if (!lines.length) {
            nativeClear();
            return;
        }
        for (const line of lines) nativeObserve(nativeContentRoot(line).getRootNode());

        const texts = lines.map(nativeLineText);

        // Apple 自己已经有译文（例如「理解歌词」）时不再重复插入
        const nativeShown = nativeState.hasTranslations === true &&
            host.getAttribute('show-translation') === 'true';
        if (nativeShown || lines.some(nativeOwnTranslation)) {
            nativeClear();
            nativeState.nativeTranslation = true;
            return;
        }
        nativeState.nativeTranslation = false;

        if (currentLyrics.length === 0) {
            nativeClear();
            return;
        }

        const key = texts.join('\u0001') + '\u0002' + currentLyrics.length + '\u0002' + translations.join('\u0001');
        if (key !== nativeState.key) {
            nativeState.align = nativeAlign(texts, currentLyrics.map(l => l.text));
            nativeState.textTranslations = nativeMergeTranslations(texts, nativeState.align);
            nativeState.key = key;
        }

        lines.forEach((line, i) => {
            nativeSetTranslation(line, nativeState.textTranslations[i] || '');
        });

        // 清理被组件回收 / 已经不在页面上的翻译节点
        for (const node of [...nativeState.nodes]) {
            if (!node.isConnected) {
                node.remove();
                nativeState.nodes.delete(node);
            }
        }
    }

    function nativeTick() {
        nativeSync();
        fallbackSync();
        hintSync();
    }

    /* ==================================================================
     * Apple 没有歌词时的全屏兜底
     *
     * 全屏歌词弹层始终存在（没有歌词时是 is-lyrics-off + 居中的封面），
     * 但 <amp-lyrics> 不会渲染任何行。这里直接把插件自己的歌词窗口
     * 停靠到弹层的 lyrics 网格里，复用已有的滚动 / 翻译 / 偏移逻辑。
     * 没有歌词弹层时保持原样：悬浮窗按原来的层级自然被全屏播放器遮住。
     * ================================================================== */
    const fallbackState = {
        article: null,
        docked: false,
        hiddenPane: null,
        timer: 0,
        watcher: null,
        watchedArticle: null,
        lastOff: null
    };

    function fallbackSchedule() {
        if (fallbackState.timer) return;
        fallbackState.timer = setTimeout(() => {
            fallbackState.timer = 0;
            fallbackSync();
        }, 80);
    }

    // 监听 is-lyrics-off 的翻转：用户点歌词按钮切回 AML 时立即停靠，
    // 不等 1 秒轮询，避免中间露出“封面居中”的空歌词状态
    function fallbackWatch(article) {
        if (fallbackState.watchedArticle === article && fallbackState.watcher) return;
        if (fallbackState.watcher) fallbackState.watcher.disconnect();
        fallbackState.watchedArticle = article;
        fallbackState.lastOff = article.classList.contains('is-lyrics-off');
        fallbackState.watcher = new MutationObserver(() => {
            const off = article.classList.contains('is-lyrics-off');
            if (off === fallbackState.lastOff) return;
            fallbackState.lastOff = off;
            fallbackSync();
        });
        fallbackState.watcher.observe(article, { attributes: true, attributeFilter: ['class'] });
    }

    // 全屏弹层是直接挂到 body 下的，监听它的出现 / 消失，比 1 秒轮询更快
    try {
        new MutationObserver(() => fallbackSchedule()).observe(document.body, { childList: true });
    } catch (e) { /* 忽略 */ }

    function fallbackArticle() {
        let best = null;
        let bestArea = 0;
        for (const el of document.querySelectorAll('article[data-testid="lyrics-fullscreen-modal"], article.lyrics__container')) {
            if (!nativeVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area <= bestArea) continue;
            best = el;
            bestArea = area;
        }
        return best;
    }

    function fallbackSync() {
        try {
            fallbackSyncInner();
        } catch (e) {
            console.error('[AML] 全屏兜底歌词失败:', e);
            fallbackDetach();
        }
    }

    function fallbackSyncInner() {
        const hasMessage = ui.content.classList.contains('aml-msg');
        if (currentLyrics.length === 0 && !hasMessage) {
            fallbackDetach();
            return;
        }

        const article = fallbackArticle();
        if (article) {
            fallbackWatch(article);
            // is-lyrics-off 是 Apple 自己标记的「这首歌没有歌词」状态；
            // 组件还在加载时这个类不会出现，所以不要抢先接管
            const noLyrics = article.classList.contains('is-lyrics-off');
            const hasLines = !noLyrics && nativeHasAppleLyrics(article);
            if (hasLines || !noLyrics) { fallbackDetach(); return; }
            fallbackDock(article);
            return;
        }

        // 没有歌词弹层就什么都不做：悬浮窗按原来的层级自然被全屏播放器遮住
        fallbackDetach();
    }

    function fallbackDock(article) {
        if (fallbackState.docked) {
            if (fallbackState.article === article && ui.root.parentElement === article) {
                article.classList.add('aml-fb-on');
                return;
            }
            fallbackUndock();
        }

        fallbackState.article = article;
        fallbackState.docked = true;
        article.classList.add('aml-fb-on');

        // 万一已经有一个空歌词面板，先藏起来，避免和窗口抢同一个网格单元
        const pane = article.querySelector('.lyrics__lyrics');
        if (pane && pane !== ui.root) {
            fallbackState.hiddenPane = { el: pane, display: pane.style.display };
            pane.style.display = 'none';
        }

        ui.root.classList.add('aml-fs-docked');
        article.appendChild(ui.root);
        // 控件栏挂到 body 上，position: fixed 才真正相对视口固定在右上角，
        // 不会被弹层里的 transform / overflow 带偏或裁掉
        ui.bar.classList.add('aml-fs-bar');
        document.body.appendChild(ui.bar);
        syncBarActive();
        if (statusTipEl) {
            statusTipEl.dataset.theme = 'dark';
            placeStatusTip();
        }
        if (pop) placePopover(pop.el, pop.anchor);
        requestAnimationFrame(() => centerActive(true));
    }

    function fallbackUndock() {
        const article = fallbackState.article;
        ui.root.classList.remove('aml-fs-docked');
        ui.bar.classList.remove('aml-fs-bar');
        syncBarActive();
        if (ui.bar.parentElement !== ui.root) ui.root.appendChild(ui.bar);
        if (ui.root.parentElement !== document.body) document.body.appendChild(ui.root);
        if (article && article.isConnected) article.classList.remove('aml-fb-on');
        if (fallbackState.hiddenPane) {
            fallbackState.hiddenPane.el.style.display = fallbackState.hiddenPane.display;
            fallbackState.hiddenPane = null;
        }
        fallbackState.article = null;
        fallbackState.docked = false;
        applySize();
        if (statusTipEl) {
            applyTheme(statusTipEl);
            placeStatusTip();
        }
        if (pop) placePopover(pop.el, pop.anchor);
        requestAnimationFrame(() => centerActive(true));
    }

    function fallbackDetach() {
        if (fallbackState.docked) fallbackUndock();
    }

    /* ==================================================================
     * 全屏歌词按钮上方的引导气泡
     *
     * 正在显示 Apple Music 自带歌词时，在歌词按钮上方提示：
     * 按下这个按钮关闭自带歌词，就能切到 AML 的歌词。
     * 样式参照 macOS 通知卡片，颜色跟随菜单；不自动消失，需点 × 关闭。
     * ================================================================== */
    const hintState = { el: null, btn: null, key: '' };

    function hintRemove() {
        if (hintState.el) {
            hintState.el.remove();
            hintState.el = null;
        }
        hintState.btn = null;
    }

    function hintHide() {
        if (!hintState.el || hintState.el.classList.contains('aml-tip-hide')) return;
        const el = hintState.el;
        el.classList.add('aml-tip-hide');
        setTimeout(() => {
            if (hintState.el === el) {
                el.remove();
                hintState.el = null;
                hintState.btn = null;
            }
        }, 220);
    }

    function hintPlace() {
        const el = hintState.el;
        const btn = hintState.btn;
        if (!el || !btn || !btn.isConnected) return;
        const r = btn.getBoundingClientRect();
        const w = el.offsetWidth || 300;
        const h = el.offsetHeight || 76;
        const edge = 10;          // 气泡离屏幕左右边缘的最小距离，调小会更靠边
        let top = r.top - h - 16;
        if (top < 16) top = r.bottom + 16;
        let left = r.left + r.width / 2;
        left = Math.max(w / 2 + edge, Math.min(left, window.innerWidth - w / 2 - edge));
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }

    function hintShow(btn) {
        hintRemove();
        const close = h('button', {
            class: 'aml-tip-close', type: 'button', 'aria-label': '关闭', text: '×'
        });
        close.addEventListener('click', e => { e.stopPropagation(); hintHide(); });
        const el = h('div', { class: 'aml-ui aml-tip', role: 'tooltip' },
            h('div', { class: 'aml-tip-title', text: '使用歌词增强插件' }),
            h('div', { class: 'aml-tip-text', text: '点击此按钮以切换「Apple Music 歌词增强」插件的完整界面。当前页面已应用了翻译歌词。' }),
            close
        );
        el.dataset.theme = 'dark';
        document.body.appendChild(el);
        hintState.el = el;
        hintState.btn = btn;
        hintPlace();
    }

    function hintSync() {
        const article = fallbackArticle();
        const nativeOn = !!(article && !article.classList.contains('is-lyrics-off') &&
            (nativeHasAppleLyrics(article) || nativeEmptyLyricsView(article)));
        const btn = article && article.querySelector('[data-testid="lyrics-button"], .lyrics-button');
        if (!nativeOn || !btn || currentLyrics.length === 0) {
            if (!nativeOn) hintState.key = '';
            if (hintState.el) hintHide();
            return;
        }
        hintState.btn = btn;
        if (hintState.el) {
            hintPlace();
            return;
        }
        const key = currentSongTitle || '';
        if (hintState.key === key) return;
        hintState.key = key;
        hintShow(btn);
    }

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
        isInstrumental = false;
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
            if (main.length === 0) { showMessage('暂无歌词', true, null, { text: '标记为纯音乐', onClick: () => markInstrumental(true) }); return; }
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
        if (isInstrumentalTitle(title)) { showInstrumental(); return; }
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
            if (results.length === 0) { showMessage('未找到歌曲', true, null, { text: '标记为纯音乐', onClick: () => markInstrumental(true) }); return; }
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
        // 只要出现汉字就按中文行处理：这样“电吉他 : Shah Tahir”这类
        // 中英混排的信息行，以及中文歌里夹的零星英文，都不会被当成英文去机翻
        if (/\p{Script=Han}/u.test(text)) return 'zh';
        if (ratio(/\p{Script=Cyrillic}/gu) > 0.5) return 'ru';
        if (ratio(/\p{Script=Thai}/gu) > 0.5) return 'th';
        if (ratio(/\p{Script=Arabic}/gu) > 0.5) return 'ar';
        if (ratio(/\p{Script=Devanagari}/gu) > 0.5) return 'hi';
        if (ratio(/\p{Script=Latin}/gu) > 0.5) return 'latin';
        return null;
    }

    // 判断是不是 “woo yeah / no / hmm / la la la” 这类不值得机翻的短英文行
    function isMinorLatinLine(text) {
        const words = text.match(/[A-Za-z][A-Za-z'’\-]*/g) || [];
        if (!words.length) return true;
        const letters = words.join('').length;
        const filler = /^(?:woo+|woah+|yeah+|yay+|ya+|no+|hmm+|hm+|mm+|mhm+|oh+|ooh+|ah+|uh+|la+|na+|da+|doo+|ba+|hey+|wow+|ha+|ho+|huh+|yo+|yep+|nope+|shh+|eh+|ay+|ayy+)$/i;
        const meaningful = words.filter(w => !filler.test(w));
        return letters < 12 || meaningful.length < 2;
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
        const hanLines = kinds.filter(k => k === 'zh').length;
        const latinLines = kinds.filter(k => k === 'latin').length;
        // 以中文为主的歌：零星几行英文基本是 ad-lib，直接不翻译；
        // 英文行较多（>3）时才逐行判断，避免为 “woo yeah / no / hmm” 下载模型
        const mostlyChinese = hanLines >= 2 && hanLines > latinLines;
        if (mostlyChinese) {
            kinds.forEach((k, i) => {
                if (k !== 'latin') return;
                if (latinLines <= 3 || isMinorLatinLine(lines[i].text)) kinds[i] = null;
            });
        }
        const latinText = lines.filter((l, i) => kinds[i] === 'latin').map(l => l.text).join('\n').slice(0, 2000);
        const latinLang = latinText ? await detectLatinLang(latinText) : 'en';
        return kinds.map(k => (k === 'latin' ? latinLang : (k === 'zh' ? null : k)));
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

    // 机翻状态（需下载 / 翻译中 / 已完成）现在由控件上的图标和气泡展示
    function restoreTip() {
        clearTimeout(flashTimer);
        setTip(null);
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
            // 先做语言检测：像纯中文歌里夹几句 “woo yeah / no / hmm” 的情况，
            // 检测后会得到“没有需要翻译的行”，直接结束，不会去请求翻译模型
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

            // 只对确实有外语行的歌曲使用机翻缓存（避免中文歌命中旧的错误缓存）
            if (!resume) {
                const cached = getTCache(songId);
                if (cached && cached.lines.length === lyrics.length) {
                    translatorInfo = { cached: true };
                    finishMachine(cached.lines);
                    return;
                }
            }

            const T = builtin('Translator');
            if (!T) {
                if (manual) flashTip('浏览器不支持机器翻译');
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
            refreshStatus();
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
        nativeTick();             // 全屏歌词的开 / 关、换行兜底
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
        const fs = ui.bar.classList.contains('aml-fs-bar');
        if (fs) ui.bar.classList.add('aml-fs-measure');
        const r = anchor.getBoundingClientRect();
        el.style.maxHeight = `${window.innerHeight - 16}px`;
        const w = el.offsetWidth, hgt = el.offsetHeight;
        if (fs) {
            // 全屏控件在右上角：菜单 / 搜索框统一放到胶囊左边，避免遮挡控件
            const left = Math.max(8, Math.min(r.left - w - 22, window.innerWidth - w - 8));
            let top = Math.min(Math.max(8, r.top), Math.max(8, window.innerHeight - hgt - 8));
            if (top < 8) top = 8;
            el.style.left = left + 'px';
            el.style.top = top + 'px';
            ui.bar.classList.remove('aml-fs-measure');
            return;
        }
        const rootRect = ui.root.getBoundingClientRect();
        const gap = 8;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        let top = rootRect.bottom + gap;   // 悬浮窗模式：放到窗口下面，不叠在窗口上
        if (top + hgt > window.innerHeight - 8) top = Math.max(8, rootRect.top - hgt - gap);
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }

    function onOutsidePointer(e) {
        if (!pop) return;
        if (pop.el.contains(e.target) || pop.anchor.contains(e.target)) return;
        closePopover();
    }
    function onEscape(e) { if (e.key === 'Escape') closePopover(); }

    // 全屏胶囊在 0.5 倍大小和原大小之间切换；菜单 / 气泡打开期间保持展开
    function syncBarActive() {
        if (!ui || !ui.bar) return;
        ui.bar.classList.toggle('aml-fs-active', !!(pop || statusTipEl));
    }

    function closePopover() {
        if (!pop) return;
        pop.el.remove();
        pop = null;
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('keydown', onEscape, true);
        syncBarActive();
    }

    function openPopover(kind, className, anchor, render) {
        closePopover();
        const el = h('div', { class: 'aml-ui aml-pop ' + className });
        applyTheme(el);
        if (ui.root.classList.contains('aml-fs-docked')) el.dataset.theme = 'dark';
        // 在弹层里按键时不要触发 Apple Music 自己的快捷键（比如空格暂停）
        ['keydown', 'keyup', 'keypress'].forEach(t => el.addEventListener(t, e => e.stopPropagation()));
        document.body.appendChild(el);
        pop = { kind, el, anchor, render };
        syncBarActive();
        render(el);
        placePopover(el, anchor);
        document.addEventListener('pointerdown', onOutsidePointer, true);
        document.addEventListener('keydown', onEscape, true);
        return el;
    }

    /* ==================================================================
     * 备份和还原
     * ================================================================== */
    const BACKUP_KEYS = [KEY_SETTINGS, KEY_OFFSETS, KEY_MATCHES, KEY_INSTR, KEY_TCACHE, KEY_STATS];
    const BACKUP_VERSION = 1;

    function exportBackup() {
        const data = {
            app: 'AML-Enhancer',
            version: BACKUP_VERSION,
            exportedAt: new Date().toISOString(),
            data: {}
        };
        for (const k of BACKUP_KEYS) {
            const raw = localStorage.getItem(k);
            if (raw != null) {
                try { data.data[k] = JSON.parse(raw); } catch (e) { /* 跳过损坏项 */ }
            }
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const d = new Date();
        a.href = url;
        a.download = `aml-backup-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function importBackup() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                let parsed;
                try { parsed = JSON.parse(String(reader.result)); }
                catch (e) { alert('备份文件不是有效的 JSON。'); return; }
                if (!parsed || parsed.app !== 'AML-Enhancer' || !parsed.data || typeof parsed.data !== 'object') {
                    alert('这不是本插件的备份文件。'); return;
                }
                const keys = Object.keys(parsed.data).filter(k => BACKUP_KEYS.includes(k));
                if (keys.length === 0) { alert('备份文件里没有可恢复的数据。'); return; }
                if (!confirm('导入将覆盖当前的设置、歌词匹配、听歌统计等数据，确定继续吗？')) return;
                for (const k of keys) {
                    try { localStorage.setItem(k, JSON.stringify(parsed.data[k])); }
                    catch (e) { console.error('[AML] 写入备份项失败:', k, e); }
                }
                alert('导入完成，页面将重新加载。');
                location.reload();
            };
            reader.onerror = () => alert('读取文件失败。');
            reader.readAsText(file);
        });
        input.click();
    }

function mBackupRow() {
    return mRow('还原或备份数据', h('div', { class: 'aml-seg' },
        h('button', { text: '导入', onclick: importBackup }),
        h('button', { text: '导出', onclick: exportBackup })
    ));
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
        const docked = ui.root.classList.contains('aml-fs-docked');
        el.classList.toggle('aml-pop-narrow', docked);
        const parts = [];

        // 全屏停靠时空间有限，只保留歌词匹配 / 备份 / 关于
        if (!docked) {
            const st = getStatsSummary();
            parts.push(
                h('div', { class: 'aml-head', text: '听歌统计（仅此浏览器）' }),
                mInfo('本月听歌', fmtDuration(st.month)),
                mInfo('本月最常听', st.top || '—', true),
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
                mSep()
            );
        }

        const matchCount = countMatches();
        const hasCurrentMatch = !!(currentSongTitle && getMatch(currentSongTitle));

        el.replaceChildren(
            ...parts,
            h('div', { class: 'aml-head', text: '歌词匹配' }),
            mAction('重新搜索歌词...', () => { closePopover(); openSearch(); }),
            mAction(isInstrumental ? '取消当前歌曲的纯音乐标记' : '标记当前歌曲为纯音乐',
                () => markInstrumental(!isInstrumental),
                { disabled: !currentSongTitle }),

            mAction('恢复当前歌曲的自动匹配', () => {
                const title = currentSongTitle;
                closePopover();
                removeMatch(title);
                loadLyricsForTitle(title);
            }, { disabled: !hasCurrentMatch }),
            mInfo('当前已手动匹配', `${matchCount} 首`),
            mSep(),

            ...(docked ? [] : [mBackupRow(), mSep()]),
            mAction('关于本插件...', () => {
                closePopover();
                window.open(ABOUT_URL, '_blank', 'noopener,noreferrer');
            }, { right: 'v' + VERSION })
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
        closeStatusTip();
        flushStats();   // 打开前先把内存里的增量落盘，统计更准确
        openPopover('menu', 'aml-menu', ui.settingsBtn, renderMenu);
    }

    /* 手动搜索面板 */
    function openSearch() {
        const title = currentSongTitle;
        closeStatusTip();

        // 面板锚定在“设置”按钮上；全屏时放到胶囊左边
        const narrow = ui.root.classList.contains('aml-fs-docked');
        openPopover('search', 'aml-search' + (narrow ? ' aml-search-narrow' : ''), ui.settingsBtn, el => {
            const input = h('input', { class: 'aml-input', type: 'text', placeholder: '输入歌名或歌手，搜索网易云音乐' });
            // 标题形如「歌名 - 艺人」，搜索框里填「歌名 艺人」
            input.value = title ? title.replace(/\s+-\s+/, ' ') : '';
            const results = h('div', { class: 'aml-results' });
            const hint = h('div', {
                class: 'aml-hint',
                text: '选择后会记住这首歌的匹配，下次播放时自动使用。'
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
                    saveInstrumental(title, false);   // 选了歌词就不再是纯音乐
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
    if (settings.pos) setPosition(settings.pos.left, settings.pos.top);
    detectPageFont();
    applySize();
    applySettings();
    refreshOffsetButton();
    showMessage('Apple Music 歌词增强 v' + VERSION, false, 'by Akashi');
})();
