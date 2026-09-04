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
import {
    drawStructures as renderStructures,
    drawCreeps as renderCreeps,
    drawActions as renderActions,
    ROLE_COLOR,
    ACTION_COLOR,
    fade,
} from "../src/board_render.js";
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
    activeFile: string | null;
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
    activeFile: null,
};

const sideColor = (side: number | null | undefined): string =>
    side === null || side === undefined ? NEUTRAL : view.sideColors[side] ?? NEUTRAL;

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

function loadReplay(doc: ReplayDoc, label?: string): void {
    view.activeFile = label ?? null;
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

function drawStructures(ctx: CanvasRenderingContext2D, cell: number): void {
    if (!view.timeline || !view.state) return;
    renderStructures(ctx, view.timeline, view.state, cell, sideColor);
}

function drawCreeps(ctx: CanvasRenderingContext2D, cell: number): void {
    if (!view.timeline || !view.state) return;
    renderCreeps(ctx, view.timeline, view.state, cell, sideColor, view.selected);
}

function drawActions(ctx: CanvasRenderingContext2D, cell: number): void {
    if (!view.timeline || !view.state) return;
    renderActions(ctx, view.timeline, view.state, cell);
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
// GIF Export
// ============================================================

let currentGifBlobUrl: string | null = null;

function openGifModal(): void {
    if (view.timeline === null) return;
    const doc = view.timeline.doc;
    $("gif-match-info").textContent = describe(doc);

    const maxTick = Math.max(0, view.timeline.length - 1);
    const startInput = $input("gif-start-tick");
    const endInput = $input("gif-end-tick");

    startInput.min = "0";
    startInput.max = String(maxTick);
    startInput.value = "0";

    endInput.min = "0";
    endInput.max = String(maxTick);
    endInput.value = String(maxTick);

    $("gif-progress-wrap").hidden = true;
    $("gif-preview-wrap").hidden = true;
    if (currentGifBlobUrl !== null) {
        URL.revokeObjectURL(currentGifBlobUrl);
        currentGifBlobUrl = null;
    }
    const btn = $("gif-generate-btn") as HTMLButtonElement;
    btn.disabled = false;
    btn.textContent = "Generate & Download";

    updateGifSummary();
    $("gif-modal").hidden = false;
}

function closeGifModal(): void {
    $("gif-modal").hidden = true;
    if (currentGifBlobUrl !== null) {
        URL.revokeObjectURL(currentGifBlobUrl);
        currentGifBlobUrl = null;
    }
}

function updateGifSummary(): void {
    if (view.timeline === null) return;
    const start = Math.max(0, Number($input("gif-start-tick").value) || 0);
    const end = Math.max(start, Number($input("gif-end-tick").value) || 0);
    const step = Math.max(1, Number($input("gif-step").value) || 1);
    const fps = Math.max(1, Number($input("gif-fps").value) || 10);
    const cell = Math.max(2, Number($input("gif-cell").value) || 4);

    const frames = Math.floor((end - start) / step) + 1;
    const duration = (frames / fps).toFixed(1);
    const estKb = Math.round(frames * (cell * cell * 0.4 + 4));

    $("gif-frame-count").textContent = String(frames);
    $("gif-duration").textContent = String(duration);
    $("gif-est-size").textContent = estKb >= 1024 ? `${(estKb / 1024).toFixed(1)} MB` : `${estKb} KB`;
}

async function generateGif(): Promise<void> {
    if (view.timeline === null) return;
    const start = Math.max(0, Number($input("gif-start-tick").value) || 0);
    const end = Math.max(start, Number($input("gif-end-tick").value) || 0);
    const step = Math.max(1, Number($input("gif-step").value) || 1);
    const fps = Math.max(1, Number($input("gif-fps").value) || 10);
    const cell = Math.max(2, Number($input("gif-cell").value) || 4);

    const btn = $("gif-generate-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Generating…";
    $("gif-progress-wrap").hidden = false;
    $("gif-progress-text").textContent = "Generating GIF on server…";
    $("gif-preview-wrap").hidden = true;

    try {
        const payload: Record<string, unknown> = {
            start,
            end,
            step,
            fps,
            cell,
        };
        if (view.activeFile !== null) {
            payload.file = view.activeFile;
        } else {
            payload.doc = view.timeline.doc;
        }

        const res = await fetch("/api/gif", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || `Server error (${res.status})`);
        }

        const blob = await res.blob();
        if (currentGifBlobUrl !== null) {
            URL.revokeObjectURL(currentGifBlobUrl);
        }
        currentGifBlobUrl = URL.createObjectURL(blob);

        const shortId = view.timeline.doc.meta.shortId ?? view.timeline.doc.meta.gameId ?? "match";
        const downloadName = `${shortId}_${start}-${end}.gif`;

        // Trigger browser download
        const a = document.createElement("a");
        a.href = currentGifBlobUrl;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        a.remove();

        // Show preview in modal
        const img = $("gif-preview-img") as HTMLImageElement;
        img.src = currentGifBlobUrl;
        $("gif-preview-meta").textContent = `Downloaded: ${downloadName} (${(blob.size / 1024).toFixed(1)} KB)`;
        $("gif-preview-wrap").hidden = false;
        $("gif-progress-wrap").hidden = true;
        btn.textContent = "Re-Generate";
    } catch (err) {
        $("gif-progress-text").textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
        btn.textContent = "Retry";
    } finally {
        btn.disabled = false;
    }
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
    $("btn-export-gif").addEventListener("click", openGifModal);
    $("gif-modal-close").addEventListener("click", closeGifModal);
    $("gif-modal-cancel").addEventListener("click", closeGifModal);
    $("gif-generate-btn").addEventListener("click", generateGif);

    $input("gif-start-tick").addEventListener("input", updateGifSummary);
    $input("gif-end-tick").addEventListener("input", updateGifSummary);
    $input("gif-fps").addEventListener("change", updateGifSummary);
    $input("gif-step").addEventListener("change", updateGifSummary);
    $input("gif-cell").addEventListener("change", updateGifSummary);

    $("gif-preset-full").addEventListener("click", () => {
        if (!view.timeline) return;
        $input("gif-start-tick").value = "0";
        $input("gif-end-tick").value = String(view.timeline.length - 1);
        updateGifSummary();
    });
    $("gif-preset-current").addEventListener("click", () => {
        if (!view.timeline) return;
        const s = Math.max(0, view.index - 50);
        const e = Math.min(view.timeline.length - 1, view.index + 50);
        $input("gif-start-tick").value = String(s);
        $input("gif-end-tick").value = String(e);
        updateGifSummary();
    });
    $("gif-preset-first100").addEventListener("click", () => {
        if (!view.timeline) return;
        $input("gif-start-tick").value = "0";
        $input("gif-end-tick").value = String(Math.min(view.timeline.length - 1, 100));
        updateGifSummary();
    });
    $("gif-preset-last100").addEventListener("click", () => {
        if (!view.timeline) return;
        const s = Math.max(0, view.timeline.length - 101);
        $input("gif-start-tick").value = String(s);
        $input("gif-end-tick").value = String(view.timeline.length - 1);
        updateGifSummary();
    });

    $("gif-modal").addEventListener("click", (e) => {
        if (e.target === $("gif-modal")) closeGifModal();
    });

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
        if (e.key === "Escape" && !$("gif-modal").hidden) {
            closeGifModal();
            return;
        }
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

