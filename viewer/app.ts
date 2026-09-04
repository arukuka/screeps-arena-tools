/*
 * Screeps: Arena Replay Viewer.
 *
 * Renders universal match information (terrain, structures, creeps, actions, energy, flags).
 * Bot-specific state is transported via log metadata and rendered by plugins (`plugin.ts`).
 * State management and timeline logic are in `../src/timeline.ts`.
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
import type {
    BoardState,
    PlayerInfo,
    PluginApi,
    PluginLegend,
    ReplayDoc,
    ReplayObject,
    StructureState,
    Timeline,
} from "../src/types.js";

// ============================================================
// Constants
// ============================================================

/** Default side colors (overridden by replay `playerColor` if present). */
const FALLBACK_SIDE_COLOR: readonly string[] = ["#4aa8ff", "#ff7a5c"];
const NEUTRAL = "#6b7787";

/** Terrain colors matching `decodeTerrain` indices (0=plain / 1=wall / 2=swamp). */
const TERRAIN_RGB: readonly (readonly [number, number, number])[] = [
    [18, 24, 31],
    [0, 0, 0],
    [29, 42, 31],
];

/** Combat part indicator colors displayed as center dots on creeps. */
const ROLE_COLOR: Record<string, string> = {
    attack: "#ff5d5d",
    ranged_attack: "#ffd166",
    heal: "#6ee7a8",
};

const ACTION_COLOR: Record<string, string> = {
    a: "#ff5d5d",
    r: "#ffb15d",
    R: "#ffb15d",
    h: "#6ee7a8",
    H: "#8ee0ff",
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const $input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const inputOf = (e: Event): HTMLInputElement => e.target as HTMLInputElement;

// ============================================================
// View State
// ============================================================

const board = $("board") as HTMLCanvasElement;
const boardCtx = board.getContext("2d")!;
const chart = $("chart") as HTMLCanvasElement;
const chartCtx = chart.getContext("2d")!;

const plugins = new PluginHost();

interface TimeSeries {
    parts: Int32Array[];
    counts: Int32Array[];
    captures: number[];
    max: number;
}

interface ViewState {
    timeline: Timeline | null;
    series: TimeSeries | null;
    state: BoardState | null;
    index: number;
    cell: number;
    terrainCanvas: HTMLCanvasElement | null;
    extIndex: Map<number, Record<string, unknown[]>>;
    selected: string | null;
    playing: boolean;
    lastStep: number;
    showActions: boolean;
    showStructures: boolean;
    zoom: number;
    panX: number;
    panY: number;
    dragging: boolean;
    dragStart: { x: number; y: number; panX: number; panY: number };
    hasDragged: boolean;
    sideColors: string[];
}

const view: ViewState = {
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
    sideColors: [...FALLBACK_SIDE_COLOR],
};

const sideColor = (side: number | null | undefined): string =>
    side === null || side === undefined ? NEUTRAL : view.sideColors[side] ?? NEUTRAL;

/** Apply alpha transparency to hex color `#rrggbb`. */
function fade(hex: string, alpha: number): string {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
    if (m === null) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

// ============================================================
// Loading
// ============================================================

/** Decompress `.gz` files client-side if loaded via drag-and-drop. */
async function readReplayFile(file: File): Promise<any> {
    if (file.name.endsWith(".gz")) {
        const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
        return JSON.parse(await new Response(stream).text());
    }
    return JSON.parse(await file.text());
}

/** Accept either normalized replay JSON or raw match dump JSON. */
function acceptDocument(json: any, label?: string): void {
    const doc: ReplayDoc = json?.format === "screeps-arena-replay" ? json : normalizeMatch(json);
    loadReplay(doc, label);
}

function loadReplay(doc: ReplayDoc, _label?: string): void {
    view.timeline = buildTimeline(doc);
    view.series = buildSeries(view.timeline);
    view.extIndex = new Map(
        doc.ticks.filter((t) => t.e !== undefined).map((t) => [t.k, t.e!]),
    );
    view.sideColors = doc.meta.players.map((p, i) => p.color ?? FALLBACK_SIDE_COLOR[i] ?? NEUTRAL);
    view.terrainCanvas = buildTerrainCanvas(view.timeline);
    view.index = 0;
    view.selected = null;
    view.playing = false;

    plugins.applyDocument(doc);
    renderPluginList();
    renderPluginToggles();

    $("board-empty").hidden = true;
    $("match-title").textContent = describe(doc);
    $input("scrubber").max = String(Math.max(0, view.timeline.length - 1));

    renderMatchInfo(doc);
    resizeBoard();
    seek(0);
    renderLegend();
    renderPluginList();
}

function formatPlayer(player: PlayerInfo | undefined, fallback = "player"): string {
    if (!player) return fallback;
    const name = player.username ?? player.slot ?? fallback;
    const ver = player.codeVersion !== null && player.codeVersion !== undefined ? ` (v${player.codeVersion})` : "";
    return `${name}${ver}`;
}

const describe = (doc: ReplayDoc): string => {
    const names = doc.meta.players
        .map((p, i) => {
            const formatted = formatPlayer(p, p?.slot ?? `side ${i}`);
            const isWinner = doc.meta.result && !doc.meta.result.draw && doc.meta.result.winner === i;
            return isWinner ? `${formatted} 👑` : formatted;
        })
        .join(" vs ");
    return `${names} (${doc.meta.shortId ?? doc.meta.gameId ?? "?"})`;
};

/** Build time-series data for the scrubber chart in a single forward pass. */
function buildSeries(timeline: Timeline): TimeSeries {
    const sides = timeline.doc.meta.players.length;
    const parts = Array.from({ length: sides }, () => new Int32Array(timeline.length));
    const counts = Array.from({ length: sides }, () => new Int32Array(timeline.length));
    const captures: number[] = [];

    const creeps = new Map<string, { side: number | null; size: number }>();
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

function buildTerrainCanvas(timeline: Timeline): HTMLCanvasElement {
    const { width, height, terrain } = timeline;
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const ctx = off.getContext("2d")!;
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
// Board Rendering
// ============================================================

function applyBoardTransform(): void {
    board.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
    $("btn-zoom-reset").textContent = `${Math.round(view.zoom * 100)}%`;
}

function resetBoardTransform(): void {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    applyBoardTransform();
}

function zoomAt(target: number, clientX?: number, clientY?: number): void {
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

function resizeBoard(): void {
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

const isDestroyed = (o: ReplayObject, cur?: StructureState): boolean =>
    o.hitsMax > 0 && (cur === undefined || cur.hits <= 0);

function drawStructures(ctx: CanvasRenderingContext2D, cell: number): void {
    if (!view.timeline || !view.state) return;
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

function dominantPart(body: string): string | null {
    const counts = bodyCounts(body);
    let best: string | null = null;
    let bestCount = 0;
    for (const name of ["attack", "ranged_attack", "heal"]) {
        if ((counts[name] ?? 0) > bestCount) {
            best = name;
            bestCount = counts[name];
        }
    }
    return best;
}

function creepRadius(body: string, cell: number): number {
    const size = bodySize(body);
    return cell * (0.45 + 0.55 * Math.min(1, Math.sqrt(size) / 6));
}

function drawCreeps(ctx: CanvasRenderingContext2D, cell: number): void {
    if (!view.state) return;
    for (const c of view.state.creeps.values()) {
        const cx = c.x * cell + cell / 2;
        const cy = c.y * cell + cell / 2;
        const r = creepRadius(c.body, cell);
        const color = sideColor(c.side);

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = c.spawning ? fade(color, 0.25) : fade(color, 0.75);
        ctx.fill();

        if (view.selected === c.id) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = Math.max(1, cell * 0.2);
            ctx.stroke();
        }

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

function drawActions(ctx: CanvasRenderingContext2D, cell: number): void {
    if (!view.state || !view.timeline) return;
    const state = view.state;
    for (const entry of state.actions) {
        const [id, code, tx, ty] = entry;
        if (INCOMING_ACTIONS.has(code)) continue;
        const actor = state.creeps.get(id) ?? view.timeline.objectById.get(id);
        if (actor === undefined) continue;
        const ax = actor.x * cell + cell / 2;
        const ay = actor.y * cell + cell / 2;
        const color = ACTION_COLOR[code] ?? "#d7e0ea";

        if (tx === undefined) {
            ctx.beginPath();
            ctx.arc(ax, ay, cell * 3, 0, Math.PI * 2);
            ctx.strokeStyle = fade(color, 0.5);
            ctx.lineWidth = Math.max(1, cell * 0.18);
            ctx.stroke();
            continue;
        }
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(tx * cell + cell / 2, (ty ?? 0) * cell + cell / 2);
        ctx.strokeStyle = fade(color, 0.85);
        ctx.lineWidth = Math.max(1, cell * 0.18);
        ctx.stroke();
    }
}

function render(): void {
    if (view.timeline === null || view.state === null || view.terrainCanvas === null) return;
    const cell = view.cell;
    const { width, height } = view.timeline;

    boardCtx.imageSmoothingEnabled = false;
    boardCtx.clearRect(0, 0, width * cell, height * cell);
    boardCtx.drawImage(view.terrainCanvas, 0, 0, width * cell, height * cell);

    if (view.showStructures) drawStructures(boardCtx, cell);
    drawCreeps(boardCtx, cell);
    if (view.showActions) drawActions(boardCtx, cell);

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

function pluginApi(): PluginApi {
    if (!view.timeline || !view.state) throw new Error("Viewer not initialized");
    return {
        ctx: boardCtx,
        cell: view.cell,
        doc: view.timeline.doc,
        timeline: view.timeline,
        state: view.state,
        tick: view.state.tick,
        index: view.index,
        ext: view.state.ext,
        extAt: (k: number) => view.extIndex.get(k) ?? null,
        selected: view.selected,
        sideColor,
        fade,
        isToggled: (id: string) => plugins.isToggled(id),
    };
}

// ============================================================
// Scrubber Chart
// ============================================================

function renderChart(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = chart.clientWidth;
    const h = chart.clientHeight;
    chart.width = w * dpr;
    chart.height = h * dpr;
    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chartCtx.clearRect(0, 0, w, h);
    if (view.series === null || view.timeline === null) return;

    const { parts, captures, max } = view.series;
    const n = view.timeline.length;
    const xOf = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * w);

    // Flag capture markers
    chartCtx.strokeStyle = "rgba(255,209,102,0.35)";
    chartCtx.lineWidth = 1;
    for (const i of captures) {
        chartCtx.beginPath();
        chartCtx.moveTo(xOf(i), 0);
        chartCtx.lineTo(xOf(i), h);
        chartCtx.stroke();
    }

    // Total body parts per side
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
// Inspector Panels
// ============================================================

function renderMatchInfo(doc: ReplayDoc): void {
    const m = doc.meta;
    let result = "Unknown";
    if (m.result.draw) {
        result = "Draw";
    } else if (m.result.winner !== null && m.result.winner !== undefined) {
        const p = m.players[m.result.winner];
        const pName = formatPlayer(p, m.result.winnerName ?? `side ${m.result.winner}`);
        result = `${pName} Won 👑`;
    } else if (m.result.winnerName) {
        result = `${m.result.winnerName} Won 👑`;
    }
    const rows: [string, string][] = [
        ["Match", m.shortId ?? "-"],
        ["Date", m.createdAt ? m.createdAt.replace("T", " ").slice(0, 19) : "-"],
        ["Tick", `${m.ticks}${m.ticksLimit ? ` / ${m.ticksLimit}` : ""}`],
        ["Result", result],
        ["Board", `${m.width}x${m.height}`],
    ];
    if (m.url) rows.push(["URL", `<a href="${m.url}" target="_blank" rel="noopener">${m.shortId}</a>`]);
    $("match-info").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

const escapeHtml = (text: string | number | null | undefined): string =>
    String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

function renderSideStats(): void {
    if (!view.timeline || !view.state) return;
    const stats = sideStats(view.timeline, view.state);
    const players = view.timeline.doc.meta.players;
    const result = view.timeline.doc.meta.result;
    const maxParts = Math.max(1, ...stats.map((s) => s.parts));
    $("side-stats").innerHTML = stats
        .map((s, i) => {
            const player = players[i];
            const name = escapeHtml(formatPlayer(player, `side ${i}`));
            const isWinner = result && !result.draw && result.winner === i;
            const crown = isWinner ? ' <span title="Winner">👑</span>' : "";
            const width = ((s.parts / maxParts) * 100).toFixed(1);
            return `
                <div class="side-block">
                    <div class="side-name" style="color:${sideColor(i)}">${name}${crown}</div>
                    <div class="bar"><span style="width:${width}%;background:${sideColor(i)}"></span></div>
                    <div>creep ${s.creeps} / parts ${s.parts} / HP ${s.hits}</div>
                    <div class="hint">structures ${s.structures} / energy ${s.energy} / flag ${s.flags}</div>
                </div>`;
        })
        .join("");
}

function renderActionList(): void {
    if (!view.state) return;
    const actions = view.state.actions;
    const el = $("action-list");
    if (actions.length === 0) {
        el.className = "action-list hint";
        el.textContent = "None";
        return;
    }
    el.className = "action-list";
    el.innerHTML = actions
        .filter(([, code]) => !INCOMING_ACTIONS.has(code))
        .map(([id, code, x, y]) => {
            const c = view.state?.creeps.get(id);
            const color = c ? sideColor(c.side) : NEUTRAL;
            const where = x === undefined ? "" : ` → (${x},${y})`;
            return `<div class="action-row"><span class="who" style="color:${color}">${escapeHtml(id)}</span><span>${ACTION_NAME[code] ?? escapeHtml(code)}${where}</span></div>`;
        })
        .join("");
}

function renderConsoleLog(): void {
    if (!view.timeline || !view.state) return;
    const text = view.timeline.doc.logs?.[String(view.state.tick)];
    const el = $("console-log");
    if (!text) {
        el.className = "console-log hint";
        el.textContent = "None";
        return;
    }
    el.className = "console-log";
    el.textContent = text;
}

function renderUnitDetail(): void {
    if (!view.state || !view.timeline) return;
    const el = $("unit-detail");
    if (view.selected === null) {
        el.className = "hint";
        el.textContent = "Click a unit on the board";
        return;
    }
    const c = view.state.creeps.get(view.selected);
    if (c === undefined) {
        el.className = "hint";
        el.textContent = `${view.selected} is not present in this tick`;
        return;
    }
    el.className = "";
    const body = parseBody(c.body)
        .map((p) => `${p.name}×${p.count}`)
        .join(", ");
    const mine = view.state.actions.filter(([id]) => id === c.id);
    const acted = mine.length === 0 ? "-" : mine.map(([, code]) => ACTION_NAME[code] ?? code).join(", ");
    const p = c.side !== null ? view.timeline.doc.meta.players[c.side] : undefined;
    const sideName = escapeHtml(formatPlayer(p, c.side !== null ? `side ${c.side}` : "neutral"));
    el.innerHTML = `
        <dl class="kv">
            <dt>id</dt><dd>${escapeHtml(c.id)}</dd>
            <dt>Side</dt><dd style="color:${sideColor(c.side)}">${sideName}</dd>
            <dt>Pos</dt><dd>(${c.x}, ${c.y})</dd>
            <dt>HP</dt><dd>${c.hits} / ${c.hitsMax}</dd>
            <dt>Fatigue</dt><dd>${c.fatigue}</dd>
            <dt>Parts</dt><dd>${bodySize(c.body)}</dd>
            <dt>Body</dt><dd>${escapeHtml(body)}</dd>
            <dt>Action</dt><dd>${escapeHtml(acted)}</dd>
        </dl>`;
}

function renderLegend(): void {
    if (!view.timeline) return;
    const players = view.timeline.doc.meta.players;
    const items: PluginLegend[] = [
        ...players.map((p, i) => ({ color: sideColor(i), label: escapeHtml(formatPlayer(p, `side ${i}`)) })),
        { color: ROLE_COLOR.attack!, label: "attack" },
        { color: ROLE_COLOR.ranged_attack!, label: "ranged" },
        { color: ROLE_COLOR.heal!, label: "heal" },
        { color: ACTION_COLOR.a!, label: "attack", line: true },
        { color: ACTION_COLOR.h!, label: "heal", line: true },
        ...plugins.legend(),
    ];
    $("legend").innerHTML = items
        .map((it) => `<div><i class="${it.line ? "line" : ""}" style="background:${it.color}"></i>${escapeHtml(it.label)}</div>`)
        .join("");
}

// ============================================================
// Plugin UI
// ============================================================

function renderPluginList(): void {
    const el = $("plugin-list");
    if (plugins.entries.length === 0) {
        el.innerHTML = '<p class="hint">None</p>';
        return;
    }
    el.innerHTML = plugins.entries
        .map((e) => {
            const name = escapeHtml(e.plugin?.name ?? e.id);
            const cls = e.error !== null ? "failed" : e.active ? "" : "inactive";
            let why = "";
            if (e.error !== null) why = escapeHtml(e.error);
            else if (!e.active) why = `@${(e.missing ?? []).join(", @")} missing in log`;
            return `<div class="plugin-item ${cls}"><span class="dot"></span><span>${name}</span><span class="why">${why}</span></div>`;
        })
        .join("");
}

function renderPluginToggles(): void {
    const el = $("plugin-toggles");
    const toggles = plugins.toggles();
    el.innerHTML = toggles
        .map((t) => `<label class="toggle"><input type="checkbox" data-plugin-toggle="${escapeHtml(t.id)}" ${plugins.isToggled(t.id) ? "checked" : ""} /> ${escapeHtml(t.label)}</label>`)
        .join("");
    for (const raw of el.querySelectorAll<HTMLInputElement>("[data-plugin-toggle]")) {
        raw.addEventListener("change", () => {
            if (raw.dataset.pluginToggle) {
                plugins.setToggle(raw.dataset.pluginToggle, raw.checked);
                render();
            }
        });
    }
}

function renderPluginPanels(): void {
    const host = $("plugin-panels");
    const panels = plugins.panels();
    const wanted = new Set(panels.map((p) => p.id));

    for (const el of [...host.children]) {
        if (!wanted.has((el as HTMLElement).dataset.panelId!)) el.remove();
    }
    for (const panel of panels) {
        let section = host.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panel.id)}"]`);
        if (section === null) {
            section = document.createElement("section");
            section.className = "panel";
            section.dataset.panelId = panel.id;
            section.innerHTML = `<h2>${escapeHtml(panel.title ?? panel.id)}</h2><div class="panel-body"></div>`;
            host.appendChild(section);
        }
        const body = section.querySelector<HTMLElement>(".panel-body");
        const owner = plugins.entries.find((e) => e.plugin?.name === panel.plugin)?.plugin;
        if (owner && body !== null) {
            plugins.guard(owner, () => panel.render(body, pluginApi()));
        }
    }
}

// ============================================================
// Playback Control
// ============================================================

function seek(index: number): void {
    if (view.timeline === null) return;
    view.index = Math.max(0, Math.min(index, view.timeline.length - 1));
    view.state = stateAt(view.timeline, view.index);
    render();
}

function step(delta: number): void {
    seek(view.index + delta);
}

function setPlaying(playing: boolean): void {
    view.playing = playing && view.timeline !== null;
    $("btn-play").textContent = view.playing ? "⏸" : "▶";
    if (view.playing) {
        view.lastStep = performance.now();
        requestAnimationFrame(tickLoop);
    }
}

function tickLoop(now: number): void {
    if (!view.playing || view.timeline === null) return;
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
// Replay List
// ============================================================

async function loadReplayList(): Promise<void> {
    const el = $("replay-list");
    const activeFile = el.querySelector<HTMLElement>(".match.active")?.dataset.file;
    try {
        const res = await fetch("/api/replays");
        const data = await res.json();
        if (data.replays.length === 0) {
            el.innerHTML = `<p class="hint">No replays in ${escapeHtml(data.dir)}.<br>Fetch one using: <code>screeps-arena-tools fetch &lt;URL&gt;</code></p>`;
            return;
        }
        el.innerHTML = data.replays.map(renderReplayItem).join("");
        for (const raw of el.querySelectorAll<HTMLElement>(".match")) {
            if (raw.dataset.file === activeFile) {
                raw.classList.add("active");
            }
            raw.addEventListener("click", async () => {
                for (const other of el.querySelectorAll(".match")) other.classList.remove("active");
                raw.classList.add("active");
                const file = raw.dataset.file;
                if (file) {
                    const res = await fetch(`/replays/${encodeURIComponent(file)}`);
                    acceptDocument(await res.json(), file);
                }
            });
        }
    } catch {
        el.innerHTML = '<p class="hint">Cannot load replay list (check if running via server)</p>';
    }
}

function renderReplayItem(r: any): string {
    const fileEscaped = escapeHtml(r.file);
    const sizeKb = (r.bytes / 1024).toFixed(0);

    if (!r.meta || !Array.isArray(r.meta.players) || r.meta.players.length === 0) {
        const modStr = escapeHtml(r.modified.slice(0, 16).replace("T", " "));
        return `
            <button class="match" data-file="${fileEscaped}">
                <div class="match-file">${fileEscaped}</div>
                <div class="match-sub row2">${sizeKb} KB — ${modStr}</div>
            </button>`;
    }

    const m = r.meta;
    const players: PlayerInfo[] = m.players;
    const isDraw = m.result?.draw === true;
    const winnerIdx = isDraw ? null : (m.result?.winner ?? null);

    const playersHtml = players
        .map((p, i) => {
            const name = escapeHtml(p.username ?? p.slot ?? `side ${i}`);
            const ver = p.codeVersion !== null && p.codeVersion !== undefined ? ` <span class="ver">v${escapeHtml(p.codeVersion)}</span>` : "";
            const isWinner = winnerIdx === i;
            const color = p.color ?? FALLBACK_SIDE_COLOR[i] ?? NEUTRAL;
            const crown = isWinner ? '<span class="crown" title="Winner">👑</span>' : "";
            return `<span class="player-entry ${isWinner ? "winner" : ""}" style="color:${color}">${crown}<span class="player-name">${name}</span>${ver}</span>`;
        })
        .join('<span class="vs">vs</span>');

    const drawBadge = isDraw ? '<span class="draw-badge">Draw</span>' : "";
    const ticksStr = m.ticks ? `${m.ticks}t` : "";
    const dateStr = (m.createdAt ?? r.modified).slice(5, 16).replace("T", " ");
    const metaDetails = [ticksStr, `${sizeKb} KB`, dateStr].filter(Boolean).join(" · ");

    return `
        <button class="match" data-file="${fileEscaped}">
            <div class="match-players">
                ${playersHtml}
                ${drawBadge}
            </div>
            <div class="match-sub row2">
                <div class="match-file" title="${fileEscaped}">${fileEscaped}</div>
                <div class="match-details">${escapeHtml(metaDetails)}</div>
            </div>
        </button>`;
}

async function loadPlugins(): Promise<void> {
    const wanted = pluginsFromQuery(location.search);
    try {
        const res = await fetch("/api/plugins");
        const data = await res.json();
        for (const file of data.plugins) wanted.push(`/plugins/${file}`);
    } catch {
        // Plugin directory optional
    }
    for (const url of [...new Set(wanted)]) await plugins.load(url);
    renderPluginList();
}

// ============================================================
// Event Handling
// ============================================================

function setupEvents(): void {
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
        if (view.hasDragged || view.timeline === null) return;
        const rect = board.getBoundingClientRect();
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * view.timeline.width);
        const y = Math.floor(((e.clientY - rect.top) / rect.height) * view.timeline.height);
        let best: string | null = null;
        let bestDist = Infinity;
        if (view.state) {
            for (const c of view.state.creeps.values()) {
                const d = (c.x - x) ** 2 + (c.y - y) ** 2;
                if (d < bestDist) {
                    best = c.id;
                    bestDist = d;
                }
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
    wrap.addEventListener("drop", async (e: DragEvent) => {
        const file = e.dataTransfer?.files?.[0];
        if (file !== undefined) acceptDocument(await readReplayFile(file), file.name);
    });

    window.addEventListener("resize", resizeBoard);
}

plugins.onError = (id: string, message: string): void => {
    console.warn(`[plugin] ${id}: ${message}`);
    if (view.timeline !== null) {
        renderPluginList();
        renderLegend();
    }
};

setupEvents();
await loadPlugins();
await loadReplayList();

// Automatically check for newly synced replays every 10 seconds
setInterval(() => {
    loadReplayList();
}, 10000);

