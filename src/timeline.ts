/**
 * Reconstruct board states for arbitrary ticks from a normalized replay.
 *
 * Uses keyframes spaced every `KEYFRAME_STRIDE` ticks to enable fast seeking
 * without iterating from tick 0 on every scrub.
 * Pure logic shared across browser and Node.js (no DOM or fs dependencies).
 */

import { decodeTerrain } from "./terrain.js";
import type {
    BoardState,
    BodyPartInfo,
    ReplayDoc,
    ReplayTick,
    SideStats,
    Timeline,
} from "./types.js";

/** Keyframe interval (in ticks). */
export const KEYFRAME_STRIDE = 100;

/** Body run-length code to part name. */
export const PART_NAME: Record<string, string> = {
    m: "move",
    w: "work",
    c: "carry",
    a: "attack",
    r: "ranged_attack",
    t: "tough",
    h: "heal",
};

/** Action single-character code to full name. */
export const ACTION_NAME: Record<string, string> = {
    a: "attack",
    r: "rangedAttack",
    R: "rangedMassAttack",
    h: "heal",
    H: "rangedHeal",
    A: "attacked",
    E: "healed",
};

/** Incoming action codes (recorded on target entity). */
export const INCOMING_ACTIONS = new Set<string>(["A", "E"]);

/**
 * Parse `"m2a1"` into `[{ code: "m", name: "move", count: 2 }, ...]`.
 * @param body
 */
export function parseBody(body?: string): BodyPartInfo[] {
    const out: BodyPartInfo[] = [];
    const re = /([a-z?])(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body ?? "")) !== null) {
        out.push({ code: m[1], name: PART_NAME[m[1]] ?? m[1], count: Number(m[2]) });
    }
    return out;
}

/** Total number of parts in a body string. */
export function bodySize(body?: string): number {
    let total = 0;
    for (const part of parseBody(body)) total += part.count;
    return total;
}

/** Part counts grouped by type (e.g. `{ move: 3, attack: 2 }`). */
export function bodyCounts(body?: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const part of parseBody(body)) counts[part.name] = (counts[part.name] ?? 0) + part.count;
    return counts;
}

/** Create an empty board state. */
function emptyState(): BoardState {
    return {
        tick: 0,
        creeps: new Map(),
        struct: new Map(),
        owner: new Map(),
        actions: [],
    };
}

/** Deep clone a state object for keyframing. */
function cloneState(state: BoardState): BoardState {
    return {
        tick: state.tick,
        creeps: new Map([...state.creeps].map(([k, v]) => [k, { ...v }])),
        struct: new Map([...state.struct].map(([k, v]) => [k, { ...v }])),
        owner: new Map(state.owner),
        actions: [...state.actions],
        ext: state.ext ? { ...state.ext } : state.ext,
    };
}

/**
 * Apply 1 tick's delta changes to a state object.
 * @param state
 * @param tick
 */
export function applyFrame(state: BoardState, tick: ReplayTick): BoardState {
    state.tick = tick.k;

    for (const [id, side, x, y, hits, hitsMax, body, spawning] of tick.n ?? []) {
        state.creeps.set(id, { id, side, x, y, hits, hitsMax, body, spawning: spawning === 1 ? 1 : 0, fatigue: 0 });
    }
    for (const [id, x, y, hits, fatigue, spawning] of tick.u ?? []) {
        const c = state.creeps.get(id);
        if (c === undefined) continue;
        c.x = x;
        c.y = y;
        c.hits = hits;
        c.fatigue = fatigue;
        c.spawning = spawning;
    }
    for (const [id, body] of tick.b ?? []) {
        const c = state.creeps.get(id);
        if (c !== undefined) c.body = body;
    }
    for (const id of tick.x ?? []) state.creeps.delete(id);
    for (const [id, hits, energy] of tick.s ?? []) state.struct.set(id, { hits, energy });
    for (const [id, side] of tick.w ?? []) state.owner.set(id, side);

    // Actions are transient and valid only for the current tick
    state.actions = tick.a ?? [];
    state.ext = tick.e ?? null;
    return state;
}

/**
 * Build a timeline and keyframe index from a replay document.
 *
 * @param doc Normalized replay document
 */
export function buildTimeline(doc: ReplayDoc): Timeline {
    const { width, height } = doc.meta;
    const terrain = decodeTerrain(doc.terrain, width, height);

    const base = emptyState();
    for (const o of doc.objects) {
        base.struct.set(o.id, { hits: o.hits, energy: o.energy });
        base.owner.set(o.id, o.side);
    }

    const keyframes: BoardState[] = [cloneState(base)];
    const state = cloneState(base);
    for (let i = 0; i < doc.ticks.length; i++) {
        applyFrame(state, doc.ticks[i]);
        if ((i + 1) % KEYFRAME_STRIDE === 0) keyframes.push(cloneState(state));
    }

    return {
        doc,
        width,
        height,
        terrain,
        objectById: new Map(doc.objects.map((o) => [o.id, o])),
        base,
        keyframes,
        length: doc.ticks.length,
    };
}

/**
 * Return board state at the conclusion of tick at index `index`.
 *
 * Returns a freshly cloned state to prevent accidental mutations by callers.
 *
 * @param timeline
 * @param index
 */
export function stateAt(timeline: Timeline, index: number): BoardState {
    const clamped = Math.max(0, Math.min(index, timeline.length - 1));
    const kfIndex = Math.min(Math.floor((clamped + 1) / KEYFRAME_STRIDE), timeline.keyframes.length - 1);
    const state = cloneState(timeline.keyframes[kfIndex]);
    const from = kfIndex * KEYFRAME_STRIDE;
    for (let i = from; i <= clamped; i++) applyFrame(state, timeline.doc.ticks[i]);
    return state;
}

/**
 * Aggregate summary statistics per side for charts and inspector panels.
 *
 * @param timeline
 * @param state
 */
export function sideStats(timeline: Timeline, state: BoardState): SideStats[] {
    const sides: SideStats[] = timeline.doc.meta.players.map(() => ({
        creeps: 0,
        hits: 0,
        hitsMax: 0,
        parts: 0,
        energy: 0,
        structures: 0,
        flags: 0,
    }));
    const fallback = (): SideStats => ({
        creeps: 0,
        hits: 0,
        hitsMax: 0,
        parts: 0,
        energy: 0,
        structures: 0,
        flags: 0,
    });

    for (const c of state.creeps.values()) {
        const sideIdx = c.side ?? -1;
        const s = (sideIdx >= 0 && sides[sideIdx]) ? sides[sideIdx] : fallback();
        if (sideIdx >= 0 && !sides[sideIdx]) sides[sideIdx] = s;
        s.creeps++;
        s.hits += c.hits;
        s.hitsMax += c.hitsMax;
        s.parts += bodySize(c.body);
    }
    for (const o of timeline.doc.objects) {
        const side = state.owner.get(o.id);
        if (side === null || side === undefined) continue;
        const s = sides[side];
        if (s === undefined) continue;
        const cur = state.struct.get(o.id);
        if (o.kind === "flag") {
            s.flags++;
            continue;
        }
        if (cur !== undefined && cur.hits <= 0 && o.hitsMax > 0) continue;
        s.structures++;
        s.energy += cur?.energy ?? 0;
    }
    return sides;
}
