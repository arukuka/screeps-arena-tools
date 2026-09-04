/**
 * Shared board rendering routines for browser canvas and headless GIF generator.
 *
 * Implements drawing of terrain, structures, creeps, action rays, and combat indicators
 * against an abstracted 2D canvas context interface (`BoardCanvasContext`).
 */

import { INCOMING_ACTIONS, bodyCounts, bodySize } from "./timeline.js";
import type { BoardState, ReplayObject, StructureState, Timeline } from "./types.js";

/** Abstract 2D rendering context fulfilled by CanvasRenderingContext2D and SoftwareCanvas. */
export interface BoardCanvasContext {
    fillStyle: string | any;
    strokeStyle: string | any;
    lineWidth: number;
    fillRect(x: number, y: number, w: number, h: number): void;
    strokeRect(x: number, y: number, w: number, h: number): void;
    clearRect(x: number, y: number, w: number, h: number): void;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    fill(): void;
    save(): void;
    restore(): void;
    translate(x: number, y: number): void;
    rotate(angle: number): void;
}

export const FALLBACK_SIDE_COLOR: readonly string[] = ["#4aa8ff", "#ff7a5c"];
export const NEUTRAL = "#6b7787";

/** Terrain RGB values matching decodeTerrain indices (0=plain / 1=wall / 2=swamp). */
export const TERRAIN_RGB: readonly (readonly [number, number, number])[] = [
    [18, 24, 31],
    [0, 0, 0],
    [29, 42, 31],
];

/** Combat part indicator colors displayed as center dots on creeps. */
export const ROLE_COLOR: Record<string, string> = {
    attack: "#ff5d5d",
    ranged_attack: "#ffd166",
    heal: "#6ee7a8",
};

export const ACTION_COLOR: Record<string, string> = {
    a: "#ff5d5d",
    r: "#ffb15d",
    R: "#ffb15d",
    h: "#6ee7a8",
    H: "#8ee0ff",
};

/** Apply alpha transparency to hex color `#rrggbb` or `#rgb`. */
export function fade(hex: string, alpha: number): string {
    const trimmed = (hex ?? "").trim();
    let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(trimmed);
    if (m === null) {
        const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
        if (m3 !== null) {
            m = [, m3[1] + m3[1], m3[2] + m3[2], m3[3] + m3[3]] as unknown as RegExpExecArray;
        }
    }
    if (m === null) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

export function dominantPart(body: string): string | null {
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

export function creepRadius(body: string, cell: number): number {
    const size = bodySize(body);
    return cell * (0.45 + 0.55 * Math.min(1, Math.sqrt(size) / 6));
}

export const isDestroyed = (o: ReplayObject, cur?: StructureState): boolean =>
    o.hitsMax > 0 && (cur === undefined || cur.hits <= 0);

export function drawTerrain(ctx: BoardCanvasContext, timeline: Timeline, cell: number): void {
    const { width, height, terrain } = timeline;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const t = terrain[y * width + x] ?? 0;
            const [r, g, b] = TERRAIN_RGB[t] ?? TERRAIN_RGB[0];
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x * cell, y * cell, cell, cell);
        }
    }
}

export function drawStructures(
    ctx: BoardCanvasContext,
    timeline: Timeline,
    state: BoardState,
    cell: number,
    sideColor: (side: number | null | undefined) => string,
): void {
    const { doc } = timeline;

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

export function drawCreeps(
    ctx: BoardCanvasContext,
    timeline: Timeline,
    state: BoardState,
    cell: number,
    sideColor: (side: number | null | undefined) => string,
    selectedId: string | null = null,
): void {
    for (const c of state.creeps.values()) {
        const cx = c.x * cell + cell / 2;
        const cy = c.y * cell + cell / 2;
        const r = creepRadius(c.body, cell);
        const color = sideColor(c.side);

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = c.spawning ? fade(color, 0.25) : fade(color, 0.75);
        ctx.fill();

        if (selectedId === c.id) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = Math.max(1, cell * 0.2);
            ctx.stroke();
        }

        if (c.hitsMax > 0 && c.hits < c.hitsMax) {
            ctx.beginPath();
            ctx.arc(
                cx,
                cy,
                r + Math.max(1, cell * 0.28),
                -Math.PI / 2,
                -Math.PI / 2 + (Math.PI * 2 * c.hits) / c.hitsMax,
            );
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = Math.max(1, cell * 0.22);
            ctx.stroke();
        }

        const role = dominantPart(c.body);
        if (role !== null) {
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1, r * 0.32), 0, Math.PI * 2);
            ctx.fillStyle = ROLE_COLOR[role] ?? "#ffffff";
            ctx.fill();
        }
    }
}

export function drawActions(
    ctx: BoardCanvasContext,
    timeline: Timeline,
    state: BoardState,
    cell: number,
): void {
    for (const entry of state.actions) {
        const [id, code, tx, ty] = entry;
        if (INCOMING_ACTIONS.has(code)) continue;
        const actor = state.creeps.get(id) ?? timeline.objectById.get(id);
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

export interface BoardRenderOptions {
    showStructures?: boolean;
    showActions?: boolean;
    drawBackground?: boolean;
    selectedId?: string | null;
}

/** Render a single tick state onto the given canvas context. */
export function drawBoard(
    ctx: BoardCanvasContext,
    timeline: Timeline,
    state: BoardState,
    cell: number,
    sideColors: string[],
    options: BoardRenderOptions = {},
): void {
    const sideColor = (side: number | null | undefined): string =>
        side === null || side === undefined ? NEUTRAL : sideColors[side] ?? NEUTRAL;

    if (options.drawBackground !== false) {
        drawTerrain(ctx, timeline, cell);
    }

    if (options.showStructures !== false) {
        drawStructures(ctx, timeline, state, cell, sideColor);
    }

    drawCreeps(ctx, timeline, state, cell, sideColor, options.selectedId ?? null);

    if (options.showActions !== false) {
        drawActions(ctx, timeline, state, cell);
    }
}
