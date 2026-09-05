/**
 * Raw replay response to normalized replay document (`docs/FORMAT.md`).
 *
 * ------------------------------------------------------------------
 * Why convert?
 * ------------------------------------------------------------------
 * `/api/game/{id}/replay/{chunk}` returns full state snapshots per tick rather than deltas.
 * A 100x100 Arena contains over 330 structures alone, causing a 2,000 tick match to exceed
 * 280MB of raw JSON.
 *
 * By recording:
 *   1. Static properties (type, coordinates, max HP) once upon appearance
 *   2. Only modified attributes per tick
 *
 * the replay document size shrinks by over two orders of magnitude.
 *
 * ------------------------------------------------------------------
 * Incremental processing
 * ------------------------------------------------------------------
 * `createNormalizer()` folds raw frames into deltas chunk by chunk as they arrive,
 * discarding raw snapshots immediately to minimize memory usage.
 */

import { encodeTerrain } from "./terrain.js";
import { indexExtensions, splitLogLine } from "./extensions.js";
import type {
    MatchResult,
    Normalizer,
    NormalizerInit,
    PlayerInfo,
    ReplayDoc,
    ReplayObject,
    ReplayTick,
    TickActionTuple,
    TickBirthTuple,
    TickBodyTuple,
    TickOwnerTuple,
    TickStructTuple,
    TickUpdateTuple,
} from "./types.js";

export const REPLAY_FORMAT = "screeps-arena-replay";
export const REPLAY_VERSION = 1;

/** Body part name to single-character code. See `docs/FORMAT.md`. */
const PART_CODE: Record<string, string> = {
    move: "m",
    work: "w",
    carry: "c",
    attack: "a",
    ranged_attack: "r",
    tough: "t",
    heal: "h",
};

/**
 * `actionLog` key to single-character code.
 *
 * Uppercase letters represent target/incoming actions (e.g. attacked, healed).
 */
const ACTION_CODE: Record<string, string> = {
    attack: "a",
    rangedAttack: "r",
    rangedMassAttack: "R",
    heal: "h",
    rangedHeal: "H",
    attacked: "A",
    healed: "E",
};

/** Normalize raw `_id` values to strings across numeric, string, and flag name IDs. */
const idOf = (o: any): string => String(o._id);

/** Extract energy value from store. */
const energyOf = (o: any): number =>
    o.store && typeof o.store.energy === "number" ? o.store.energy : 0;

const energyCapOf = (o: any): number =>
    o.storeCapacityResource && typeof o.storeCapacityResource.energy === "number"
        ? o.storeCapacityResource.energy
        : 0;

/**
 * Encode body array into an order-preserving run-length string: `[move, move, attack]` → `"m2a1"`.
 *
 * @param body
 * @returns Encoded body string
 */
export function encodeBody(body?: ReadonlyArray<{ type: string }>): string {
    if (!Array.isArray(body)) return "";
    let out = "";
    let cur = "";
    let run = 0;
    for (const part of body) {
        const code = PART_CODE[part.type] ?? "?";
        if (code === cur) {
            run++;
            continue;
        }
        if (run > 0) out += cur + run;
        cur = code;
        run = 1;
    }
    if (run > 0) out += cur + run;
    return out;
}

/**
 * Build display metadata from raw `gameData` (`/api/game/{shortId}` response).
 *
 * Resolves player slot ordering (`player1` / `player2`) using `usersCode` and `firstPlayerIndex`
 * matching official game client behavior (`getGamePlayers`).
 *
 * @param gameData
 * @returns Metadata object
 */
export function readGameMeta(gameData: any): {
    players: PlayerInfo[];
    result: MatchResult;
    arenaId: string | null;
    ticksLimit: number | null;
    createdAt: string | null;
} {
    const outer = gameData?.game ?? {};
    const inner = outer.game ?? {};

    const users: any[] = Array.isArray(outer.users) ? outer.users : [];
    const codes: any[] = Array.isArray(outer.codes) ? outer.codes : [];
    const usersCode: string[] = Array.isArray(inner.usersCode) ? inner.usersCode : [];
    const colors: string[] = Array.isArray(inner.playerColor) ? inner.playerColor : [];
    const firstPlayerIndex = Number(inner.firstPlayerIndex) || 0;

    const userById = new Map<string, any>(users.map((u) => [u._id, u]));
    const codeById = new Map<string, any>(codes.map((c) => [c._id, c]));

    // When firstPlayerIndex is 1, board slots (player1, player2) invert to [usersCode[1], usersCode[0]]
    const slotCodeIds = [...usersCode];
    if (firstPlayerIndex === 1 && slotCodeIds.length >= 2) {
        const temp = slotCodeIds[0];
        slotCodeIds[0] = slotCodeIds[1];
        slotCodeIds[1] = temp;
    }

    const slots = Math.max(slotCodeIds.length, users.length, 2);
    const players: PlayerInfo[] = [];
    for (let i = 0; i < slots; i++) {
        const code = codeById.get(slotCodeIds[i]);
        const fallbackUser =
            firstPlayerIndex === 1 && users.length >= 2
                ? i === 0
                    ? users[1]
                    : i === 1
                      ? users[0]
                      : users[i]
                : users[i];
        const user = code ? userById.get(code.user) : fallbackUser;
        players.push({
            slot: `player${i + 1}`,
            side: i,
            username: user?.username ?? null,
            userId: user?._id ?? null,
            color: colors[i] ?? null,
            codeVersion: code?.version ?? null,
        });
    }

    return {
        players,
        result: readResult(inner.result, players, firstPlayerIndex),
        arenaId: outer.arena ?? null,
        ticksLimit: typeof outer.meta?.ticks === "number" ? outer.meta.ticks : null,
        createdAt: inner.createdAt ?? null,
    };
}

/**
 * Resolve match winner score to player slot index.
 *
 * Screeps Arena `result.winner` represents score from perspective of `usersCode[0]`:
 *   - 1: usersCode[0] won
 *   - 0: usersCode[1] won
 *   - 0.5: Draw
 */
function readResult(result: any, players: PlayerInfo[], firstPlayerIndex = 0): MatchResult {
    if (!result || typeof result !== "object") return { winner: null, winnerName: null, draw: false, raw: null };
    const raw = result.winner;
    if (typeof raw !== "number") {
        return { winner: null, winnerName: null, draw: false, status: result.status ?? null, raw: raw ?? null };
    }
    if (!Number.isInteger(raw)) {
        return { winner: null, winnerName: null, draw: true, status: result.status ?? null, raw };
    }

    const codeWinnerIndex = raw === 1 ? 0 : 1;
    const slotWinnerIndex = firstPlayerIndex === 1 ? (codeWinnerIndex === 0 ? 1 : 0) : codeWinnerIndex;

    return {
        winner: slotWinnerIndex,
        winnerName: players[slotWinnerIndex]?.username ?? null,
        draw: false,
        status: result.status ?? null,
        raw,
    };
}

/** Distinct log-failure reasons kept in `meta.logChunks.errors`. */
const MAX_LOG_ERRORS = 5;

/**
 * Create an incremental normalizer.
 *
 * Usage:
 * ```js
 * const n = createNormalizer({ gameData, shortId });
 * n.pushFrames(chunkFrames);   // In tick order
 * n.pushLogs(logChunk);
 * const doc = n.finish();
 * ```
 *
 * @param init
 */
export function createNormalizer(init: NormalizerInit = {}): Normalizer {
    const meta = readGameMeta(init.gameData);
    const inner = init.gameData?.game?.game ?? {};

    const digits = typeof inner.terrain === "string" ? inner.terrain : "";
    const side = Math.round(Math.sqrt(digits.length));
    const width = side > 0 ? side : 0;
    const height = side > 0 ? side : 0;

    /** Static objects (non-creep) stored once upon introduction. */
    const objects = new Map<string, ReplayObject>();
    /** Mutable structure state to calculate deltas against. */
    const structState = new Map<string, { hits: number; energy: number; side: number | null }>();
    /** Mutable creep state. */
    const creepState = new Map<
        string,
        { x: number; y: number; hits: number; fatigue: number; spawning: number; body: string }
    >();
    /** Output tick deltas. */
    const ticks: ReplayTick[] = [];
    /** Guard against duplicate ticks across chunk boundaries. */
    const seen = new Set<number>();
    /** Tick to console log text. */
    const logs: Record<string, string> = {};
    /** Console log chunk retrieval outcome. See `meta.logChunks`. */
    const logChunks = { requested: 0, fetched: 0, failed: 0, errors: [] as string[] };
    /** Tick to metadata parsed by splitLogLine. */
    const extByTick = new Map<number, Record<string, unknown[]>>();

    let lastTick = -1;
    let maxTick = 0;

    const sideOf = (user: any): number | null => {
        if (user === undefined || user === null) return null;
        const m = /^player(\d+)$/.exec(String(user));
        if (m !== null) return Number(m[1]) - 1;
        const found = meta.players.findIndex((p) => p.userId === user || p.username === user);
        return found >= 0 ? found : null;
    };

    /**
     * Fold 1 full frame snapshot into deltas.
     * @param frame
     */
    function pushFrame(frame: any): void {
        const k = frame?.gameTime;
        if (typeof k !== "number" || seen.has(k)) return;
        seen.add(k);
        if (k < lastTick) {
            throw new Error(`frames must arrive in tick order (got ${k} after ${lastTick})`);
        }
        lastTick = k;
        if (k > maxTick) maxTick = k;

        const births: TickBirthTuple[] = [];
        const updates: TickUpdateTuple[] = [];
        const bodies: TickBodyTuple[] = [];
        const actions: TickActionTuple[] = [];
        const structDeltas: TickStructTuple[] = [];
        const ownerDeltas: TickOwnerTuple[] = [];
        const aliveCreeps = new Set<string>();
        const aliveStructs = new Set<string>();

        for (const o of frame.objects ?? []) {
            if (o.type === "creep") {
                aliveCreeps.add(idOf(o));
                collectCreep(o, births, updates, bodies);
            } else {
                aliveStructs.add(idOf(o));
                collectStructure(o, structDeltas, ownerDeltas);
            }
            collectActions(o, actions);
        }

        // Dead creeps
        const dead: string[] = [];
        for (const id of creepState.keys()) {
            if (!aliveCreeps.has(id)) dead.push(id);
        }
        for (const id of dead) creepState.delete(id);

        // Destroyed structures: retain hits: 0 tombstone marker
        for (const [id, st] of structState) {
            if (aliveStructs.has(id) || st.hits === 0) continue;
            st.hits = 0;
            st.energy = 0;
            structDeltas.push([id, 0, 0]);
        }

        const tick: ReplayTick = { k };
        if (births.length > 0) tick.n = births;
        if (updates.length > 0) tick.u = updates;
        if (bodies.length > 0) tick.b = bodies;
        if (dead.length > 0) tick.x = dead;
        if (actions.length > 0) tick.a = actions;
        if (structDeltas.length > 0) tick.s = structDeltas;
        if (ownerDeltas.length > 0) tick.w = ownerDeltas;
        ticks.push(tick);
    }

    function collectCreep(
        o: any,
        births: TickBirthTuple[],
        updates: TickUpdateTuple[],
        bodies: TickBodyTuple[],
    ): void {
        const id = idOf(o);
        const body = encodeBody(o.body);
        const spawning = o.spawning ? 1 : 0;
        const fatigue = typeof o.fatigue === "number" ? o.fatigue : 0;
        const prev = creepState.get(id);

        if (prev === undefined) {
            births.push([id, sideOf(o.user), o.x, o.y, o.hits, o.hitsMax, body, spawning]);
            creepState.set(id, { x: o.x, y: o.y, hits: o.hits, fatigue, spawning, body });
            return;
        }
        if (
            prev.x !== o.x ||
            prev.y !== o.y ||
            prev.hits !== o.hits ||
            prev.fatigue !== fatigue ||
            prev.spawning !== spawning
        ) {
            updates.push([id, o.x, o.y, o.hits, fatigue, spawning]);
            prev.x = o.x;
            prev.y = o.y;
            prev.hits = o.hits;
            prev.fatigue = fatigue;
            prev.spawning = spawning;
        }
        if (prev.body !== body) {
            bodies.push([id, body]);
            prev.body = body;
        }
    }

    function collectStructure(
        o: any,
        structDeltas: TickStructTuple[],
        ownerDeltas: TickOwnerTuple[],
    ): void {
        const id = idOf(o);
        const side = sideOf(o.user);
        const hits = typeof o.hits === "number" ? o.hits : 0;
        const energy = energyOf(o);
        const st = structState.get(id);

        if (st === undefined) {
            objects.set(id, {
                id,
                kind: o.type,
                side,
                x: o.x,
                y: o.y,
                hits,
                hitsMax: typeof o.hitsMax === "number" ? o.hitsMax : 0,
                energy,
                energyCapacity: energyCapOf(o),
                controlledBy: o.controlledBy ?? null,
            });
            structState.set(id, { hits, energy, side });
            return;
        }
        if (st.hits !== hits || st.energy !== energy) {
            structDeltas.push([id, hits, energy]);
            st.hits = hits;
            st.energy = energy;
        }
        if (st.side !== side) {
            ownerDeltas.push([id, side]);
            st.side = side;
        }
    }

    function collectActions(o: any, actions: TickActionTuple[]): void {
        const log = o.actionLog;
        if (!log) return;
        const id = idOf(o);
        for (const [name, value] of Object.entries(log)) {
            if (value === null || value === undefined) continue;
            const code = ACTION_CODE[name] ?? name;
            if (typeof value === "object" && typeof (value as any).x === "number") {
                actions.push([id, code, (value as any).x, (value as any).y]);
            } else {
                actions.push([id, code]);
            }
        }
    }

    return {
        /** Frames in tick order for 1 chunk */
        pushFrames(frames: ReadonlyArray<any>): void {
            if (!Array.isArray(frames)) return;
            for (const frame of frames) pushFrame(frame);
        },

        /**
         * Incorporate a log chunk (`{ "<tick>": "<text>" }`).
         * Failed chunks (`{ status: 404 }`) are ignored.
         * @param chunk
         */
        pushLogs(chunk: any): void {
            if (!chunk || typeof chunk !== "object" || typeof chunk.status === "number") return;
            for (const [tick, text] of Object.entries(chunk)) {
                if (typeof text !== "string" || text === "") continue;
                const { log, ext } = splitLogLine(text);
                if (log !== "") logs[tick] = log;
                if (ext !== null) extByTick.set(Number(tick), ext);
            }
        },

        /** Normalized replay document */
        noteLogChunk(result: { ok: boolean; status?: number; statusText?: string }): void {
            logChunks.requested++;
            if (result.ok) {
                logChunks.fetched++;
                return;
            }
            logChunks.failed++;
            const reason = `${result.status ?? "?"} ${result.statusText ?? ""}`.trim();
            if (logChunks.errors.length < MAX_LOG_ERRORS && !logChunks.errors.includes(reason)) {
                logChunks.errors.push(reason);
            }
        },

        finish(): ReplayDoc {
            for (const tick of ticks) {
                const ext = extByTick.get(tick.k);
                if (ext !== undefined) tick.e = ext;
            }
            return {
                format: REPLAY_FORMAT,
                version: REPLAY_VERSION,
                meta: {
                    shortId: init.shortId ?? null,
                    gameId: init.gameId ?? init.gameData?.game?._id ?? null,
                    url: init.shortId ? `https://arena.screeps.com/game/${init.shortId}` : null,
                    fetchedAt: init.fetchedAt ?? null,
                    createdAt: meta.createdAt,
                    arenaId: meta.arenaId,
                    ticksLimit: meta.ticksLimit,
                    ticks: maxTick,
                    players: meta.players,
                    result: meta.result,
                    width,
                    height,
                    logChunks: logChunks.requested > 0 ? { ...logChunks } : null,
                },
                terrain: encodeTerrain(digits),
                objects: [...objects.values()],
                ticks,
                logs,
                extensions: indexExtensions(ticks),
            };
        },
    };
}

/**
 * Normalize a complete raw match dump object.
 *
 * @param raw
 * @param options
 */
export function normalizeMatch(raw: any, options: { shortId?: string | null } = {}): ReplayDoc {
    if (!raw || typeof raw !== "object" || !raw.replays) {
        throw new Error("not a raw replay JSON (missing replays property)");
    }
    const n = createNormalizer({
        gameData: raw.gameData,
        shortId: options.shortId ?? raw.shortId ?? null,
        gameId: raw.realGameId ?? null,
        fetchedAt: raw.fetchedAt ?? null,
    });
    const chunks = Object.keys(raw.replays)
        .map(Number)
        .filter((num) => Number.isFinite(num))
        .sort((a, b) => a - b);
    for (const c of chunks) {
        n.pushFrames(raw.replays[String(c)]);
        const chunkLogs = raw.logs ? raw.logs[String(c)] : undefined;
        if (chunkLogs !== undefined) n.pushLogs(chunkLogs);
        n.noteLogChunk({ ok: chunkLogs !== undefined, statusText: "absent in raw dump" });
    }
    return n.finish();
}
