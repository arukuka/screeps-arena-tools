/**
 * 正規化リプレイから「ある Tick の盤面」を復元する。
 *
 * 保存形式は差分なので、Tick 1500 を見たければ 0 から順に適用するしかない。
 * スクラブバーを掴んで動かされるたびに 1500 回の適用が走るのは重いので、
 * 一定間隔でキーフレーム（丸ごとの複製）を取っておき、直近のキーフレームから
 * 進める。間隔 `KEYFRAME_STRIDE` は「複製の総量」と「最悪の適用回数」の折り合い。
 *
 * ブラウザと Node のどちらからも読む。DOM にも fs にも触らないこと。
 */

import { decodeTerrain } from "./terrain.js";

/** 何 Tick ごとにキーフレームを取るか */
export const KEYFRAME_STRIDE = 100;

/** body のランレングス 1 文字コード → 表示名 */
export const PART_NAME = {
    m: "move",
    w: "work",
    c: "carry",
    a: "attack",
    r: "ranged_attack",
    t: "tough",
    h: "heal",
};

/** actionLog の 1 文字コード → 表示名 */
export const ACTION_NAME = {
    a: "attack",
    r: "rangedAttack",
    R: "rangedMassAttack",
    h: "heal",
    H: "rangedHeal",
    A: "attacked",
    E: "healed",
};

/** 「撃った側」の記録だけを描きたいときの判定。大文字は受けた側 */
export const INCOMING_ACTIONS = new Set(["A", "E"]);

/**
 * `"m2a1"` → `[{ code: "m", name: "move", count: 2 }, ...]`
 * @param {string} body
 */
export function parseBody(body) {
    const out = [];
    const re = /([a-z?])(\d+)/g;
    let m;
    while ((m = re.exec(body ?? "")) !== null) {
        out.push({ code: m[1], name: PART_NAME[m[1]] ?? m[1], count: Number(m[2]) });
    }
    return out;
}

/** body のパーツ総数 */
export function bodySize(body) {
    let total = 0;
    for (const part of parseBody(body)) total += part.count;
    return total;
}

/** パーツ種別ごとの枚数。`{ move: 3, attack: 2 }` */
export function bodyCounts(body) {
    const counts = {};
    for (const part of parseBody(body)) counts[part.name] = (counts[part.name] ?? 0) + part.count;
    return counts;
}

/** 空の盤面状態 */
function emptyState() {
    return {
        tick: 0,
        creeps: new Map(),
        struct: new Map(),
        owner: new Map(),
        actions: [],
    };
}

/** 状態の複製。キーフレーム用 */
function cloneState(state) {
    return {
        tick: state.tick,
        creeps: new Map([...state.creeps].map(([k, v]) => [k, { ...v }])),
        struct: new Map([...state.struct].map(([k, v]) => [k, { ...v }])),
        owner: new Map(state.owner),
        actions: state.actions,
    };
}

/**
 * 1 Tick 分の差分を状態に適用する。
 * @param {ReturnType<typeof emptyState>} state
 * @param {any} tick
 */
export function applyFrame(state, tick) {
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

    // 行動は「その Tick 限り」の情報。持ち越すと攻撃線が残り続けてしまう
    state.actions = tick.a ?? [];
    state.ext = tick.e ?? null;
    return state;
}

/**
 * リプレイからタイムラインを組む。
 *
 * @param {any} doc 正規化リプレイ
 */
export function buildTimeline(doc) {
    const { width, height } = doc.meta;
    const terrain = decodeTerrain(doc.terrain, width, height);

    // 構造物の初期状態。差分は初出以降しか来ないのでここが土台になる
    const base = emptyState();
    for (const o of doc.objects) {
        base.struct.set(o.id, { hits: o.hits, energy: o.energy });
        base.owner.set(o.id, o.side);
    }

    const keyframes = [cloneState(base)];
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
 * `index` 番目の Tick 終了時点の状態を返す。
 *
 * 返る状態は使い回しではなく毎回作る。呼び出し側が持ち回って
 * 気づかぬうちに書き換えられる事故を避けるため。
 *
 * @param {ReturnType<typeof buildTimeline>} timeline
 * @param {number} index
 */
export function stateAt(timeline, index) {
    const clamped = Math.max(0, Math.min(index, timeline.length - 1));
    const kfIndex = Math.min(Math.floor((clamped + 1) / KEYFRAME_STRIDE), timeline.keyframes.length - 1);
    const state = cloneState(timeline.keyframes[kfIndex]);
    const from = kfIndex * KEYFRAME_STRIDE;
    for (let i = from; i <= clamped; i++) applyFrame(state, timeline.doc.ticks[i]);
    return state;
}

/**
 * 陣営ごとの集計。グラフとサイドパネルで使う。
 * @param {ReturnType<typeof buildTimeline>} timeline
 * @param {ReturnType<typeof stateAt>} state
 */
export function sideStats(timeline, state) {
    const sides = timeline.doc.meta.players.map(() => ({
        creeps: 0,
        hits: 0,
        hitsMax: 0,
        parts: 0,
        energy: 0,
        structures: 0,
        flags: 0,
    }));
    const fallback = () => ({ creeps: 0, hits: 0, hitsMax: 0, parts: 0, energy: 0, structures: 0, flags: 0 });

    for (const c of state.creeps.values()) {
        const s = sides[c.side] ?? (sides[c.side] = fallback());
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
