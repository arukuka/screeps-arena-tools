import assert from "node:assert/strict";
import { test } from "node:test";
import {
    escapeHtml,
    formatCountdown,
    getArenaOrderIndex,
    getArenaThemeClass,
    getFameSummaryStats,
    renderFameCardHtml,
    renderFameCardsHtml,
    renderFamePageHtml,
} from "../src/fame_render.js";

test("escapeHtml escapes special HTML characters", () => {
    assert.equal(escapeHtml('<script>alert("xss & \'test\'")</script>'), "&lt;script&gt;alert(&quot;xss &amp; &#039;test&#039;&quot;)&lt;/script&gt;");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
});

test("getArenaThemeClass identifies arena themes", () => {
    assert.equal(getArenaThemeClass("Pain and Gain (Basic)"), "theme-pain-and-gain");
    assert.equal(getArenaThemeClass("Spawn and Swamp"), "theme-spawn-and-swamp");
    assert.equal(getArenaThemeClass("Escort Run (Advanced)"), "theme-escort-run");
    assert.equal(getArenaThemeClass("Unknown"), "");
});

test("getArenaOrderIndex maintains proper ordering", () => {
    assert.equal(getArenaOrderIndex("Pain and Gain (Basic)"), 0);
    assert.equal(getArenaOrderIndex("Spawn and Swamp (Basic)"), 1);
    assert.equal(getArenaOrderIndex("Escort Run (Basic)"), 2);
    assert.equal(getArenaOrderIndex("Other"), 99);
});

test("formatCountdown calculates hh:mm:ss accurately", () => {
    assert.equal(formatCountdown(null), "--:--:--");
    const target = new Date(Date.now() + (3600 * 2 + 60 * 15 + 30) * 1000 + 200);
    const countdown = formatCountdown(target);
    assert.match(countdown, /^02:15:(29|30)$/);
});

test("getFameSummaryStats calculates totals and status", () => {
    const data = {
        arenas: [
            { unlocked: true, canPlay: true, gamesPlayed: 0, famePoints: 100 },
            { unlocked: true, canPlay: false, gamesPlayed: 10, isFinished: true, famePoints: 250 },
            { unlocked: false, canPlay: false, gamesPlayed: 0, famePoints: 0 },
        ],
    };
    const stats = getFameSummaryStats(data);
    assert.equal(stats.unlockedCount, "2 / 3");
    assert.equal(stats.totalPoints, "350");
    assert.equal(stats.statusText, "Ready to Play");
});

test("renderFameCardsHtml renders Basic and Advanced sections in order", () => {
    const arenas = [
        { arenaName: "Escort Run (Basic)", advanced: false, unlocked: true, gamesPlayed: 0 },
        { arenaName: "Pain and Gain (Basic)", advanced: false, unlocked: true, gamesPlayed: 0 },
        { arenaName: "Spawn and Swamp (Advanced)", advanced: true, unlocked: true, gamesPlayed: 0 },
    ];
    const html = renderFameCardsHtml(arenas);
    assert.ok(html.includes("Basic Arenas"));
    assert.ok(html.includes("Advanced Arenas"));
    // Pain and Gain should precede Escort Run in Basic
    const pIdx = html.indexOf("Pain and Gain (Basic)");
    const eIdx = html.indexOf("Escort Run (Basic)");
    assert.ok(pIdx !== -1 && eIdx !== -1 && pIdx < eIdx);
});

test("renderFamePageHtml transforms base index.html with offline fallback when not ok", () => {
    const baseHtml = `
    <nav class="topbar-tabs">
        <button id="tab-btn-replays" class="tab-btn active" type="button">🎬 Replays</button>
        <button id="tab-btn-fame" class="tab-btn" type="button">⚡ Fame Status</button>
    </nav>
    <div id="view-replays" class="app-layout"></div>
    <div id="view-fame" class="fame-layout" hidden>
        <div class="fame-summary-val" id="fame-overall-status">-</div>
        <div id="fame-cards-container" class="fame-cards-container">
            <div class="fame-loading">Connecting to Screeps: Arena…</div>
        </div>
    </div>
    </head>
    `;
    const transformed = renderFamePageHtml(baseHtml, { ok: false, error: "CDP connection failed" });
    assert.ok(transformed.includes('id="tab-btn-fame" class="tab-btn active"'));
    assert.ok(transformed.includes('id="tab-btn-replays" class="tab-btn"'));
    assert.ok(transformed.includes('id="view-replays" class="app-layout" hidden'));
    assert.ok(transformed.includes('id="view-fame" class="fame-layout"'));
    assert.ok(transformed.includes("Offline"));
    assert.ok(transformed.includes("CDP connection failed"));
    assert.ok(transformed.includes('window.__INITIAL_FAME_DATA__ = {"ok":false'));
});
