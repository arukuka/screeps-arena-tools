/*
 * Screeps: Arena リプレイビューア。
 *
 * ここが描くのは **誰の試合からでも読み取れる情報だけ**。
 * ボット固有の内部状態（役割分担・作戦モードなど）は扱わない。
 * それらはコンソールログのメタ情報として運ばれ、プラグインが描く（`plugin.js`）。
 *
 * 状態の復元は `../src/timeline.js`、ここは描画と UI に徹する。
 */

import {
    ACTION_NAME,
    INCOMING_ACTIONS,
    bodyCounts,
    bodySize,
    buildTimeline,
    parseBody,
    sideStats,
    stateAt,
} from "../src/timeline.js";
import { normalizeMatch } from "../src/normalize.js";
import { PluginHost, pluginsFromQuery } from "./plugin.js";

// ============================================================
// 定数
// ============================================================

/** 陣営色の既定値。リプレイが `playerColor` を持っていればそちらを優先する */
const FALLBACK_SIDE_COLOR = ["#4aa8ff", "#ff7a5c"];
const NEUTRAL = "#6b7787";

/** 地形の色。`decodeTerrain` のコード（0=plain / 1=wall / 2=swamp）順 */
const TERRAIN_RGB = [
    [18, 24, 31],
    [0, 0, 0],
    [29, 42, 31],
];

/** 主戦力パーツの色。creep 中心の点に出す */
const ROLE_COLOR = {
    attack: "#ff5d5d",
    ranged_attack: "#ffd166",
    heal: "#6ee7a8",
};

const ACTION_COLOR = {
    a: "#ff5d5d",
    r: "#ffb15d",
    R: "#ffb15d",
    h: "#6ee7a8",
    H: "#8ee0ff",
};

const $ = (id) => document.getElementById(id);
/** `value` / `checked` を触る要素用。`getElementById` は HTMLElement しか返さない */
const $input = (id) => /** @type {HTMLInputElement} */ ($(id));
/** イベント発火元を入力要素として読む */
const inputOf = (e) => /** @type {HTMLInputElement} */ (e.target);

// ============================================================
// 表示状態
// ============================================================

const board = /** @type {HTMLCanvasElement} */ ($("board"));
const boardCtx = board.getContext("2d");
const chart = /** @type {HTMLCanvasElement} */ ($("chart"));
const chartCtx = chart.getContext("2d");

const plugins = new PluginHost();

const view = {
    timeline: null,
    series: null,
    state: null,
    index: 0,
    cell: 6,
    terrainCanvas: null,
    extIndex: new Map(),
    selected: null,
    playing: false,
    lastStep: 0,
    showActions: true,
    showStructures: true,
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    dragStart: { x: 0, y: 0, panX: 0, panY: 0 },
    hasDragged: false,
    sideColors: FALLBACK_SIDE_COLOR,
};

const sideColor = (side) => (side === null || side === undefined ? NEUTRAL : view.sideColors[side] ?? NEUTRAL);

/** 色に不透明度を掛ける。`#rrggbb` 前提（API の playerColor もこの形） */
function fade(hex, alpha) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
    if (m === null) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

// ============================================================
// 読み込み
// ============================================================

/** `.gz` はブラウザ側で伸長する（ドラッグ&ドロップ経路。HTTP 経由なら透過的に伸長済み） */
async function readReplayFile(file) {
    if (file.name.endsWith(".gz")) {
        const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
        return JSON.parse(await new Response(stream).text());
    }
    return JSON.parse(await file.text());
}

/**
 * 読んだ JSON をリプレイとして受け入れる。
 *
 * 生の取得結果（`fetch_match` が保存した形）でもそのまま開けるようにしてある。
 * ただし生は 1 試合で数百 MB になりうるので、その場でブラウザに変換させるのは
 * 小さい試合に限る話。常用するなら `arena-tools convert` を通すこと。
 */
function acceptDocument(json, label) {
    const doc = json?.format === "screeps-arena-replay" ? json : normalizeMatch(json);
    loadReplay(doc, label);
}

function loadReplay(doc, label) {
    view.timeline = buildTimeline(doc);
    view.series = buildSeries(view.timeline);
    // プラグインが過去 Tick のメタ情報を遡って探せるように索引を張る
    view.extIndex = new Map(doc.ticks.filter((t) => t.e !== undefined).map((t) => [t.k, t.e]));
    view.sideColors = doc.meta.players.map((p, i) => p.color ?? FALLBACK_SIDE_COLOR[i] ?? NEUTRAL);
    view.terrainCanvas = buildTerrainCanvas(view.timeline);
    view.index = 0;
    view.selected = null;
    view.playing = false;

    plugins.applyDocument(doc);
    renderPluginList();
    renderPluginToggles();

    $("board-empty").hidden = true;
    $("match-title").textContent = label ?? describe(doc);
    $input("scrubber").max = String(Math.max(0, view.timeline.length - 1));

    renderMatchInfo(doc);
    resizeBoard();
    seek(0);
    // 凡例は最初の描画の後。描画中に落ちて無効化されたプラグインの項目を残さない
    renderLegend();
    renderPluginList();
}

const describe = (doc) => {
    const names = doc.meta.players.map((p) => p.username ?? p.slot).join(" vs ");
    return `${names} (${doc.meta.shortId ?? doc.meta.gameId ?? "?"})`;
};

/**
 * グラフ用の時系列を 1 回の前進走査で作る。
 *
 * 毎フレーム `stateAt` を呼び直すとスクラブのたびに全 Tick を舐めることになる。
 */
function buildSeries(timeline) {
    const sides = timeline.doc.meta.players.length;
    const parts = Array.from({ length: sides }, () => new Int32Array(timeline.length));
    const counts = Array.from({ length: sides }, () => new Int32Array(timeline.length));
    /** flag の持ち主が変わった Tick。試合の山場の目印として縦線を引く */
    const captures = [];

    const creeps = new Map();
    const flagIds = new Set(timeline.doc.objects.filter((o) => o.kind === "flag").map((o) => o.id));

    for (let i = 0; i < timeline.length; i++) {
        const tick = timeline.doc.ticks[i];
        for (const [id, side, , , , , body] of tick.n ?? []) creeps.set(id, { side, size: bodySize(body) });
        for (const [id, body] of tick.b ?? []) {
            const c = creeps.get(id);
            if (c !== undefined) c.size = bodySize(body);
        }
        for (const id of tick.x ?? []) creeps.delete(id);
        for (const [id] of tick.w ?? []) {
            if (flagIds.has(id)) captures.push(i);
        }
        for (const c of creeps.values()) {
            if (c.side === null || c.side === undefined || parts[c.side] === undefined) continue;
            parts[c.side][i] += c.size;
            counts[c.side][i] += 1;
        }
    }
    let max = 1;
    for (const arr of parts) for (const v of arr) if (v > max) max = v;
    return { parts, counts, captures, max };
}

function buildTerrainCanvas(timeline) {
    const { width, height, terrain } = timeline;
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const ctx = off.getContext("2d");
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < terrain.length; i++) {
        const [r, g, b] = TERRAIN_RGB[terrain[i]] ?? TERRAIN_RGB[0];
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = g;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return off;
}

// ============================================================
// 盤面の描画
// ============================================================

function applyBoardTransform() {
    board.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
    $("btn-zoom-reset").textContent = `${Math.round(view.zoom * 100)}%`;
}

function resetBoardTransform() {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    applyBoardTransform();
}

function zoomAt(target, clientX, clientY) {
    const next = Math.max(0.5, Math.min(10, target));
    if (Math.abs(next - view.zoom) < 0.001) return;
    const rect = $("board-wrap").getBoundingClientRect();
    const cx = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2;
    const cy = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2;
    const factor = next / view.zoom;
    view.panX = cx - (cx - view.panX) * factor;
    view.panY = cy - (cy - view.panY) * factor;
    view.zoom = next;
    applyBoardTransform();
}

function resizeBoard() {
    if (view.timeline === null) return;
    const wrap = $("board-wrap");
    const { width, height } = view.timeline;
    const available = Math.min(wrap.clientWidth - 20, wrap.clientHeight - 20);
    const cell = Math.max(3, Math.floor(available / Math.max(width, height)));
    view.cell = cell;
    const dpr = window.devicePixelRatio || 1;
    board.width = width * cell * dpr;
    board.height = height * cell * dpr;
    board.style.width = `${width * cell}px`;
    board.style.height = `${height * cell}px`;
    boardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    applyBoardTransform();
    render();
}

/** 壊れた構造物か。差分は破壊を「HP 0」で残す（配列から消えたことの墓標） */
const isDestroyed = (o, cur) => o.hitsMax > 0 && (cur === undefined || cur.hits <= 0);

function drawStructures(ctx, cell) {
    const { doc } = view.timeline;
    const state = view.state;

    for (const o of doc.objects) {
        const cur = state.struct.get(o.id);
        if (o.kind !== "flag" && isDestroyed(o, cur)) continue;
        const side = state.owner.get(o.id);
        const x = o.x * cell;
        const y = o.y * cell;

        switch (o.kind) {
            case "constructedWall":
                ctx.fillStyle = "#3a4351";
                ctx.fillRect(x, y, cell, cell);
                break;
            case "rampart":
                ctx.fillStyle = fade(sideColor(side), 0.3);
                ctx.fillRect(x, y, cell, cell);
                break;
            case "extension": {
                // 大きさは cell より一回り小さく、残エネルギーは透明度で示す
                const ratio = o.energyCapacity > 0 ? (cur?.energy ?? 0) / o.energyCapacity : 0;
                const clamped = Math.max(0, Math.min(1, ratio));
                const size = cell * 0.7;
                const pad = (cell - size) / 2;
                const sx = x + pad;
                const sy = y + pad;
                const color = sideColor(side);

                ctx.fillStyle = fade(color, 0.15 + clamped * 0.75);
                ctx.fillRect(sx, sy, size, size);
                ctx.strokeStyle = fade(color, 0.35 + clamped * 0.55);
                ctx.lineWidth = Math.max(1, cell * 0.08);
                ctx.strokeRect(sx, sy, size, size);
                break;
            }
            case "spawn": {
                const size = cell * 2.4;
                ctx.fillStyle = fade(sideColor(side), 0.35);
                ctx.fillRect(x - size / 2 + cell / 2, y - size / 2 + cell / 2, size, size);
                ctx.strokeStyle = sideColor(side);
                ctx.lineWidth = Math.max(1, cell * 0.25);
                ctx.strokeRect(x - size / 2 + cell / 2, y - size / 2 + cell / 2, size, size);
                // 破壊された Spawn は×で潰す。勝敗に直結するので目立たせる
                if (isDestroyed(o, cur)) {
                    ctx.beginPath();
                    ctx.moveTo(x - size / 2 + cell / 2, y - size / 2 + cell / 2);
                    ctx.lineTo(x + size / 2 + cell / 2, y + size / 2 + cell / 2);
                    ctx.moveTo(x + size / 2 + cell / 2, y - size / 2 + cell / 2);
                    ctx.lineTo(x - size / 2 + cell / 2, y + size / 2 + cell / 2);
                    ctx.stroke();
                }
                break;
            }
            case "flag": {
                const r = cell * 1.6;
                ctx.save();
                ctx.translate(x + cell / 2, y + cell / 2);
                ctx.rotate(Math.PI / 4);
                ctx.fillStyle = fade(sideColor(side), 0.5);
                ctx.fillRect(-r / 2, -r / 2, r, r);
                ctx.strokeStyle = sideColor(side);
                ctx.lineWidth = Math.max(1, cell * 0.22);
                ctx.strokeRect(-r / 2, -r / 2, r, r);
                ctx.restore();
                break;
            }
            default:
                ctx.fillStyle = fade(sideColor(side), 0.4);
                ctx.fillRect(x, y, cell, cell);
        }
    }
}

/** body のうち最も多い戦闘パーツ。creep の役割の当たりを付ける */
function dominantPart(body) {
    const counts = bodyCounts(body);
    let best = null;
    let bestCount = 0;
    for (const name of ["attack", "ranged_attack", "heal"]) {
        if ((counts[name] ?? 0) > bestCount) {
            best = name;
            bestCount = counts[name];
        }
    }
    return best;
}

function creepRadius(body, cell) {
    // パーツ数の平方根で伸ばす。線形だと 40 パーツの creep が盤を覆ってしまう
    const size = bodySize(body);
    return cell * (0.45 + 0.55 * Math.min(1, Math.sqrt(size) / 6));
}

function drawCreeps(ctx, cell) {
    for (const c of view.state.creeps.values()) {
        const cx = c.x * cell + cell / 2;
        const cy = c.y * cell + cell / 2;
        const r = creepRadius(c.body, cell);
        const color = sideColor(c.side);

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        // spawning 中はまだ盤に出ていないのと同じ。薄くして数に入れないと分かるように
        ctx.fillStyle = c.spawning ? fade(color, 0.25) : fade(color, 0.75);
        ctx.fill();

        if (view.selected === c.id) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = Math.max(1, cell * 0.2);
            ctx.stroke();
        }

        // 残 HP を外周の弧で。円の大きさ（パーツ数）と混ざらないよう外側に置く
        if (c.hitsMax > 0 && c.hits < c.hitsMax) {
            ctx.beginPath();
            ctx.arc(cx, cy, r + Math.max(1, cell * 0.28), -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * c.hits) / c.hitsMax);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = Math.max(1, cell * 0.22);
            ctx.stroke();
        }

        const role = dominantPart(c.body);
        if (role !== null) {
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1, r * 0.32), 0, Math.PI * 2);
            ctx.fillStyle = ROLE_COLOR[role];
            ctx.fill();
        }
    }
}

function drawActions(ctx, cell) {
    const state = view.state;
    for (const entry of state.actions) {
        const [id, code, tx, ty] = entry;
        // 受けた側の記録は撃った側と重複する。線が二重になるので描かない
        if (INCOMING_ACTIONS.has(code)) continue;
        const actor = state.creeps.get(id) ?? view.timeline.objectById.get(id);
        if (actor === undefined) continue;
        const ax = actor.x * cell + cell / 2;
        const ay = actor.y * cell + cell / 2;
        const color = ACTION_COLOR[code] ?? "#d7e0ea";

        if (tx === undefined) {
            // rangedMassAttack は対象を持たない。効果範囲を円で示す
            ctx.beginPath();
            ctx.arc(ax, ay, cell * 3, 0, Math.PI * 2);
            ctx.strokeStyle = fade(color, 0.5);
            ctx.lineWidth = Math.max(1, cell * 0.18);
            ctx.stroke();
            continue;
        }
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(tx * cell + cell / 2, ty * cell + cell / 2);
        ctx.strokeStyle = fade(color, 0.85);
        ctx.lineWidth = Math.max(1, cell * 0.18);
        ctx.stroke();
    }
}

function render() {
    if (view.timeline === null || view.state === null) return;
    const cell = view.cell;
    const { width, height } = view.timeline;

    boardCtx.imageSmoothingEnabled = false;
    boardCtx.clearRect(0, 0, width * cell, height * cell);
    boardCtx.drawImage(view.terrainCanvas, 0, 0, width * cell, height * cell);

    if (view.showStructures) drawStructures(boardCtx, cell);
    drawCreeps(boardCtx, cell);
    if (view.showActions) drawActions(boardCtx, cell);

    // プラグインは本体の描画の上に重ねる。本体の絵を壊されないよう状態を退避する
    boardCtx.save();
    plugins.drawOverlay(pluginApi());
    boardCtx.restore();

    renderSideStats();
    renderActionList();
    renderConsoleLog();
    renderUnitDetail();
    renderPluginPanels();
    renderChart();
    $("tick-readout").textContent = `tick ${view.state.tick} / ${view.timeline.doc.meta.ticks}`;
    $input("scrubber").value = String(view.index);
}

/** プラグインに渡す取っ手。本体の内部構造をそのまま晒さないよう最小限にする */
function pluginApi() {
    return {
        ctx: boardCtx,
        cell: view.cell,
        doc: view.timeline.doc,
        timeline: view.timeline,
        state: view.state,
        tick: view.state.tick,
        index: view.index,
        ext: view.state.ext,
        extAt: (k) => view.extIndex.get(k) ?? null,
        selected: view.selected,
        sideColor,
        fade,
        isToggled: (id) => plugins.isToggled(id),
    };
}

// ============================================================
// グラフ
// ============================================================

function renderChart() {
    const dpr = window.devicePixelRatio || 1;
    const w = chart.clientWidth;
    const h = chart.clientHeight;
    chart.width = w * dpr;
    chart.height = h * dpr;
    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chartCtx.clearRect(0, 0, w, h);
    if (view.series === null) return;

    const { parts, captures, max } = view.series;
    const n = view.timeline.length;
    const xOf = (i) => (n <= 1 ? 0 : (i / (n - 1)) * w);

    // flag の持ち主が変わった Tick
    chartCtx.strokeStyle = "rgba(255,209,102,0.35)";
    chartCtx.lineWidth = 1;
    for (const i of captures) {
        chartCtx.beginPath();
        chartCtx.moveTo(xOf(i), 0);
        chartCtx.lineTo(xOf(i), h);
        chartCtx.stroke();
    }

    // 陣営ごとの総パーツ数。creep 数より戦力の実態に近い
    for (let side = 0; side < parts.length; side++) {
        chartCtx.beginPath();
        for (let i = 0; i < n; i++) {
            const y = h - (parts[side][i] / max) * (h - 4) - 2;
            if (i === 0) chartCtx.moveTo(xOf(i), y);
            else chartCtx.lineTo(xOf(i), y);
        }
        chartCtx.strokeStyle = sideColor(side);
        chartCtx.lineWidth = 1.5;
        chartCtx.stroke();
    }

    chartCtx.strokeStyle = "#ffffff";
    chartCtx.lineWidth = 1;
    chartCtx.beginPath();
    chartCtx.moveTo(xOf(view.index), 0);
    chartCtx.lineTo(xOf(view.index), h);
    chartCtx.stroke();
}

// ============================================================
// 右サイドのパネル
// ============================================================

function renderMatchInfo(doc) {
    const m = doc.meta;
    const result = m.result.draw ? "引き分け" : (m.result.winnerName ?? (m.result.winner ?? "不明"));
    const rows = [
        ["試合", m.shortId ?? "-"],
        ["日時", m.createdAt ? m.createdAt.replace("T", " ").slice(0, 19) : "-"],
        ["Tick", `${m.ticks}${m.ticksLimit ? ` / ${m.ticksLimit}` : ""}`],
        ["結果", result],
        ["盤面", `${m.width}x${m.height}`],
    ];
    if (m.url) rows.push(["URL", `<a href="${m.url}" target="_blank" rel="noopener">${m.shortId}</a>`]);
    $("match-info").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function renderSideStats() {
    const stats = sideStats(view.timeline, view.state);
    const players = view.timeline.doc.meta.players;
    const maxParts = Math.max(1, ...stats.map((s) => s.parts));
    $("side-stats").innerHTML = stats
        .map((s, i) => {
            const name = escapeHtml(players[i]?.username ?? `side ${i}`);
            const width = ((s.parts / maxParts) * 100).toFixed(1);
            return `
                <div class="side-block">
                    <div class="side-name" style="color:${sideColor(i)}">${name}</div>
                    <div class="bar"><span style="width:${width}%;background:${sideColor(i)}"></span></div>
                    <div>creep ${s.creeps} / パーツ ${s.parts} / HP ${s.hits}</div>
                    <div class="hint">構造物 ${s.structures} / エネルギー ${s.energy} / flag ${s.flags}</div>
                </div>`;
        })
        .join("");
}

function renderActionList() {
    const actions = view.state.actions;
    const el = $("action-list");
    if (actions.length === 0) {
        el.className = "action-list hint";
        el.textContent = "なし";
        return;
    }
    el.className = "action-list";
    el.innerHTML = actions
        .filter(([, code]) => !INCOMING_ACTIONS.has(code))
        .map(([id, code, x, y]) => {
            const c = view.state.creeps.get(id);
            const color = c ? sideColor(c.side) : NEUTRAL;
            const where = x === undefined ? "" : ` → (${x},${y})`;
            return `<div class="action-row"><span class="who" style="color:${color}">${escapeHtml(id)}</span><span>${ACTION_NAME[code] ?? escapeHtml(code)}${where}</span></div>`;
        })
        .join("");
}

function renderConsoleLog() {
    const text = view.timeline.doc.logs?.[String(view.state.tick)];
    const el = $("console-log");
    if (!text) {
        el.className = "console-log hint";
        el.textContent = "なし";
        return;
    }
    el.className = "console-log";
    el.textContent = text;
}

function renderUnitDetail() {
    const el = $("unit-detail");
    if (view.selected === null) {
        el.className = "hint";
        el.textContent = "盤面のユニットをクリック";
        return;
    }
    const c = view.state.creeps.get(view.selected);
    if (c === undefined) {
        el.className = "hint";
        el.textContent = `${view.selected} はこの Tick には居ない`;
        return;
    }
    el.className = "";
    const body = parseBody(c.body)
        .map((p) => `${p.name}×${p.count}`)
        .join(", ");
    const mine = view.state.actions.filter(([id]) => id === c.id);
    const acted = mine.length === 0 ? "-" : mine.map(([, code]) => ACTION_NAME[code] ?? code).join(", ");
    el.innerHTML = `
        <dl class="kv">
            <dt>id</dt><dd>${escapeHtml(c.id)}</dd>
            <dt>陣営</dt><dd style="color:${sideColor(c.side)}">${escapeHtml(view.timeline.doc.meta.players[c.side]?.username ?? c.side)}</dd>
            <dt>位置</dt><dd>(${c.x}, ${c.y})</dd>
            <dt>HP</dt><dd>${c.hits} / ${c.hitsMax}</dd>
            <dt>疲労</dt><dd>${c.fatigue}</dd>
            <dt>パーツ</dt><dd>${bodySize(c.body)}</dd>
            <dt>構成</dt><dd>${escapeHtml(body)}</dd>
            <dt>行動</dt><dd>${escapeHtml(acted)}</dd>
        </dl>`;
}

function renderLegend() {
    const players = view.timeline.doc.meta.players;
    const items = [
        ...players.map((p, i) => ({ color: sideColor(i), label: escapeHtml(p.username ?? `side ${i}`) })),
        { color: ROLE_COLOR.attack, label: "attack" },
        { color: ROLE_COLOR.ranged_attack, label: "ranged" },
        { color: ROLE_COLOR.heal, label: "heal" },
        { color: ACTION_COLOR.a, label: "攻撃", line: true },
        { color: ACTION_COLOR.h, label: "回復", line: true },
        ...plugins.legend(),
    ];
    $("legend").innerHTML = items
        .map((it) => `<div><i class="${it.line ? "line" : ""}" style="background:${it.color}"></i>${escapeHtml(it.label)}</div>`)
        .join("");
}

// ============================================================
// プラグインの UI
// ============================================================

function renderPluginList() {
    const el = $("plugin-list");
    if (plugins.entries.length === 0) {
        el.innerHTML = '<p class="hint">なし</p>';
        return;
    }
    el.innerHTML = plugins.entries
        .map((e) => {
            const name = escapeHtml(e.plugin?.name ?? e.id);
            const cls = e.error !== null ? "failed" : e.active ? "" : "inactive";
            let why = "";
            if (e.error !== null) why = escapeHtml(e.error);
            else if (!e.active) why = `@${(e.missing ?? []).join(", @")} がログに無い`;
            return `<div class="plugin-item ${cls}"><span class="dot"></span><span>${name}</span><span class="why">${why}</span></div>`;
        })
        .join("");
}

function renderPluginToggles() {
    const el = $("plugin-toggles");
    const toggles = plugins.toggles();
    el.innerHTML = toggles
        .map((t) => `<label class="toggle"><input type="checkbox" data-plugin-toggle="${escapeHtml(t.id)}" ${plugins.isToggled(t.id) ? "checked" : ""} /> ${escapeHtml(t.label)}</label>`)
        .join("");
    for (const raw of el.querySelectorAll("[data-plugin-toggle]")) {
        const input = /** @type {HTMLInputElement} */ (raw);
        input.addEventListener("change", () => {
            plugins.setToggle(input.dataset.pluginToggle, input.checked);
            render();
        });
    }
}

/**
 * プラグインのパネルを描く。
 *
 * 要素は使い回す。毎 Tick 作り直すと、パネル内の選択やスクロール位置が飛ぶ。
 */
function renderPluginPanels() {
    const host = $("plugin-panels");
    const panels = plugins.panels();
    const wanted = new Set(panels.map((p) => p.id));

    for (const el of [...host.children]) {
        if (!wanted.has(/** @type {HTMLElement} */ (el).dataset.panelId)) el.remove();
    }
    for (const panel of panels) {
        let section = /** @type {HTMLElement} */ (host.querySelector(`[data-panel-id="${CSS.escape(panel.id)}"]`));
        if (section === null) {
            section = document.createElement("section");
            section.className = "panel";
            section.dataset.panelId = panel.id;
            section.innerHTML = `<h2>${escapeHtml(panel.title ?? panel.id)}</h2><div class="panel-body"></div>`;
            host.appendChild(section);
        }
        const body = section.querySelector(".panel-body");
        const owner = plugins.entries.find((e) => e.plugin?.name === panel.plugin)?.plugin;
        if (owner !== undefined) plugins.guard(owner, () => panel.render(body, pluginApi()));
    }
}

// ============================================================
// 再生制御
// ============================================================

function seek(index) {
    if (view.timeline === null) return;
    view.index = Math.max(0, Math.min(index, view.timeline.length - 1));
    view.state = stateAt(view.timeline, view.index);
    render();
}

function step(delta) {
    seek(view.index + delta);
}

function setPlaying(playing) {
    view.playing = playing && view.timeline !== null;
    $("btn-play").textContent = view.playing ? "⏸" : "▶";
    if (view.playing) {
        view.lastStep = performance.now();
        requestAnimationFrame(tickLoop);
    }
}

function tickLoop(now) {
    if (!view.playing) return;
    const speed = Number($input("speed").value);
    const interval = 1000 / (10 * speed);
    if (now - view.lastStep >= interval) {
        const steps = Math.max(1, Math.floor((now - view.lastStep) / interval));
        view.lastStep = now;
        if (view.index >= view.timeline.length - 1) {
            setPlaying(false);
            return;
        }
        seek(view.index + steps);
    }
    requestAnimationFrame(tickLoop);
}

// ============================================================
// 一覧の取得
// ============================================================

async function loadReplayList() {
    const el = $("replay-list");
    try {
        const res = await fetch("/api/replays");
        const data = await res.json();
        if (data.replays.length === 0) {
            el.innerHTML = `<p class="hint">${escapeHtml(data.dir)} に何も無い。<br><code>arena-tools fetch &lt;URL&gt;</code> で取ってくる</p>`;
            return;
        }
        el.innerHTML = data.replays
            .map(
                (r) =>
                    `<button class="match" data-file="${escapeHtml(r.file)}">${escapeHtml(r.file)}<div class="row2">${(r.bytes / 1024).toFixed(0)} KB — ${escapeHtml(r.modified.slice(0, 16).replace("T", " "))}</div></button>`,
            )
            .join("");
        for (const raw of el.querySelectorAll(".match")) {
            const btn = /** @type {HTMLElement} */ (raw);
            btn.addEventListener("click", async () => {
                for (const other of el.querySelectorAll(".match")) other.classList.remove("active");
                btn.classList.add("active");
                const res = await fetch(`/replays/${encodeURIComponent(btn.dataset.file)}`);
                acceptDocument(await res.json(), btn.dataset.file);
            });
        }
    } catch {
        el.innerHTML = '<p class="hint">一覧を取得できない（サーバ経由で開いているか確認）</p>';
    }
}

async function loadPlugins() {
    const wanted = pluginsFromQuery(location.search);
    try {
        const res = await fetch("/api/plugins");
        const data = await res.json();
        for (const file of data.plugins) wanted.push(`/plugins/${file}`);
    } catch {
        // プラグイン置き場が無いだけ。本体は動く
    }
    for (const url of [...new Set(wanted)]) await plugins.load(url);
    renderPluginList();
}

// ============================================================
// 入力
// ============================================================

function setupEvents() {
    $("btn-first").addEventListener("click", () => seek(0));
    $("btn-last").addEventListener("click", () => seek(view.timeline ? view.timeline.length - 1 : 0));
    $("btn-back1").addEventListener("click", () => step(-1));
    $("btn-fwd1").addEventListener("click", () => step(1));
    $("btn-back10").addEventListener("click", () => step(-10));
    $("btn-fwd10").addEventListener("click", () => step(10));
    $("btn-play").addEventListener("click", () => setPlaying(!view.playing));
    $input("scrubber").addEventListener("input", (e) => seek(Number(inputOf(e).value)));
    $("reload-replays").addEventListener("click", loadReplayList);

    $("show-actions").addEventListener("change", (e) => {
        view.showActions = inputOf(e).checked;
        render();
    });
    $("show-structures").addEventListener("change", (e) => {
        view.showStructures = inputOf(e).checked;
        render();
    });

    $("btn-zoom-in").addEventListener("click", () => zoomAt(view.zoom * 1.25));
    $("btn-zoom-out").addEventListener("click", () => zoomAt(view.zoom / 1.25));
    $("btn-zoom-reset").addEventListener("click", () => zoomAt(1));
    $("btn-board-reset").addEventListener("click", resetBoardTransform);

    $("file-input").addEventListener("change", async (e) => {
        const file = inputOf(e).files?.[0];
        if (file !== undefined) acceptDocument(await readReplayFile(file), file.name);
    });

    const wrap = $("board-wrap");
    wrap.addEventListener("wheel", (e) => {
        e.preventDefault();
        zoomAt(view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
    }, { passive: false });
    wrap.addEventListener("dblclick", resetBoardTransform);
    wrap.addEventListener("mousedown", (e) => {
        view.dragging = true;
        view.hasDragged = false;
        view.dragStart = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
        wrap.classList.add("panning");
    });
    window.addEventListener("mousemove", (e) => {
        if (!view.dragging) return;
        const dx = e.clientX - view.dragStart.x;
        const dy = e.clientY - view.dragStart.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) view.hasDragged = true;
        view.panX = view.dragStart.panX + dx;
        view.panY = view.dragStart.panY + dy;
        applyBoardTransform();
    });
    window.addEventListener("mouseup", () => {
        view.dragging = false;
        wrap.classList.remove("panning");
    });

    board.addEventListener("click", (e) => {
        // ドラッグの終点でユニットを選び直してしまわないように
        if (view.hasDragged || view.timeline === null) return;
        const rect = board.getBoundingClientRect();
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * view.timeline.width);
        const y = Math.floor(((e.clientY - rect.top) / rect.height) * view.timeline.height);
        let best = null;
        let bestDist = Infinity;
        for (const c of view.state.creeps.values()) {
            const d = (c.x - x) ** 2 + (c.y - y) ** 2;
            if (d < bestDist) {
                best = c.id;
                bestDist = d;
            }
        }
        view.selected = bestDist <= 4 ? best : null;
        render();
    });

    chart.addEventListener("click", (e) => {
        if (view.timeline === null) return;
        const rect = chart.getBoundingClientRect();
        seek(Math.round(((e.clientX - rect.left) / rect.width) * (view.timeline.length - 1)));
    });

    window.addEventListener("keydown", (e) => {
        if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
        switch (e.key) {
            case " ":
                e.preventDefault();
                setPlaying(!view.playing);
                break;
            case "ArrowLeft":
                step(e.shiftKey ? -10 : -1);
                break;
            case "ArrowRight":
                step(e.shiftKey ? 10 : 1);
                break;
            case "0":
            case "r":
            case "R":
                resetBoardTransform();
                break;
        }
    });

    for (const type of ["dragover", "drop"]) {
        wrap.addEventListener(type, (e) => e.preventDefault());
    }
    wrap.addEventListener("drop", async (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file !== undefined) acceptDocument(await readReplayFile(file), file.name);
    });

    window.addEventListener("resize", resizeBoard);
}

plugins.onError = (id, message) => {
    console.warn(`[plugin] ${id}: ${message}`);
    // 落ちたプラグインは切り離される。一覧と凡例をその事実に合わせる
    if (view.timeline !== null) {
        renderPluginList();
        renderLegend();
    }
};
setupEvents();
await loadPlugins();
await loadReplayList();
