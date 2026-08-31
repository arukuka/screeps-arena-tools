/**
 * 生のリプレイ応答 → 正規化リプレイ（`docs/FORMAT.md` の Replay Document）。
 *
 * ------------------------------------------------------------------
 * なぜ変換が要るのか
 * ------------------------------------------------------------------
 * `/api/game/{id}/replay/{chunk}` は **毎 Tick の完全なスナップショット**を返す。
 * 差分ではない。100x100 の Arena だと構造物だけで 330 個以上あるので、
 * 2000 Tick の 1 試合が素の JSON で **280MB 超**になる。
 * ブラウザに投げる大きさではないし、`git` に置ける大きさでもない。
 *
 * 盤面のほとんどは試合中ずっと動かないので、
 *
 *   1. 動かない属性（種類・座標・最大 HP）は初出時に 1 回だけ
 *   2. 変わったものだけを Tick ごとの差分に
 *
 * と持ち直すだけで 2 桁縮む。ここはその変換だけを行う。
 *
 * ------------------------------------------------------------------
 * 逐次変換であること
 * ------------------------------------------------------------------
 * 全チャンクを読み終えてから変換すると、その瞬間だけ生データを丸ごと抱える。
 * それが上記の 280MB なので、`createNormalizer()` はチャンクを受け取るたびに
 * 差分へ畳んで生フレームを捨てる形にしてある。
 * フェッチャはチャンクを 1 つ取っては渡す、を繰り返せばよい。
 */

import { encodeTerrain } from "./terrain.js";
import { indexExtensions, splitLogLine } from "./extensions.js";

export const REPLAY_FORMAT = "screeps-arena-replay";
export const REPLAY_VERSION = 1;

/** body のパーツ名 → 1 文字コード。`docs/FORMAT.md` と対応 */
const PART_CODE = {
    move: "m",
    work: "w",
    carry: "c",
    attack: "a",
    ranged_attack: "r",
    tough: "t",
    heal: "h",
};

/**
 * `actionLog` のキー → 1 文字コード。
 *
 * 大文字は「自分が受けた側」の記録。attack と attacked の両方が残るので、
 * 撃った側だけを描くか、受けた側も描くかをビューアが選べる。
 */
const ACTION_CODE = {
    attack: "a",
    rangedAttack: "r",
    rangedMassAttack: "R",
    heal: "h",
    rangedHeal: "H",
    attacked: "A",
    healed: "E",
};

/**
 * 生の `_id` を文字列に揃える。
 *
 * 構造物は数値 id（`1`, `2`, ...）、creep は文字列 id（`"335"`）、
 * flag は名前（`"rampartsLeft"`）と型が混ざっているため。
 */
const idOf = (o) => String(o._id);

/** `store.energy` を取り出す。持たないオブジェクトは 0 */
const energyOf = (o) => (o.store && typeof o.store.energy === "number" ? o.store.energy : 0);

const energyCapOf = (o) =>
    o.storeCapacityResource && typeof o.storeCapacityResource.energy === "number"
        ? o.storeCapacityResource.energy
        : 0;

/**
 * body 配列をランレングス文字列にする。`[move,move,attack]` → `"m2a1"`。
 *
 * 並び順は落とさない。Screeps ではダメージが前方のパーツから入るので、
 * 「tough が先頭に何枚あるか」が読めなくなると意味が無い。
 *
 * @param {ReadonlyArray<{ type: string }>} body
 * @returns {string}
 */
export function encodeBody(body) {
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
 * 生の `gameData`（`/api/game/{shortId}` の応答）から表示用のメタ情報を組む。
 *
 * player1 / player2 がどちらの人間かは自明ではない。リプレイ中の
 * オブジェクトは `"player1"` / `"player2"` としか言わず、`gameData.game.users` は
 * 閲覧者本人が先頭に来るなど別の順序で並んでいる。
 * 対戦したコード ID 配列 `usersCode` に対し、`firstPlayerIndex` が 1 の場合は
 * 盤面スロット（player1 / player2）が反転する（公式クライアント `getGamePlayers` と同等）。
 *
 * @param {any} gameData
 * @returns {{ players: any[], result: any, arenaId: string | null, ticksLimit: number | null, createdAt: string | null }}
 */
export function readGameMeta(gameData) {
    const outer = gameData?.game ?? {};
    const inner = outer.game ?? {};

    const users = Array.isArray(outer.users) ? outer.users : [];
    const codes = Array.isArray(outer.codes) ? outer.codes : [];
    const usersCode = Array.isArray(inner.usersCode) ? inner.usersCode : [];
    const colors = Array.isArray(inner.playerColor) ? inner.playerColor : [];
    const firstPlayerIndex = Number(inner.firstPlayerIndex) || 0;

    const userById = new Map(users.map((u) => [u._id, u]));
    const codeById = new Map(codes.map((c) => [c._id, c]));

    // firstPlayerIndex が 1 の場合、盤面上のスロット (player1, player2) は [usersCode[1], usersCode[0]] となる
    const slotCodeIds = [...usersCode];
    if (firstPlayerIndex === 1 && slotCodeIds.length >= 2) {
        [slotCodeIds[0], slotCodeIds[1]] = [slotCodeIds[1], slotCodeIds[0]];
    }

    const slots = Math.max(slotCodeIds.length, users.length, 2);
    const players = [];
    for (let i = 0; i < slots; i++) {
        const code = codeById.get(slotCodeIds[i]);
        // usersCode から辿れないときのフォールバック
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
 * 勝敗を読む。
 *
 * Screeps Arena の `result.winner` は「`usersCode[0]` から見た勝敗スコア」を表す:
 *   - 1: usersCode[0] の勝利
 *   - 0: usersCode[1] の勝利
 *   - 0.5: 引き分け（実測: 2026-08-28 の XTTCQ7DA4T が `{"status":"ok","winner":0.5}`）
 *
 * 盤面スロット（players / side 0 または 1）の勝者インデックスにマッピングして返す。
 */
function readResult(result, players, firstPlayerIndex = 0) {
    if (!result || typeof result !== "object") return { winner: null, draw: false, raw: null };
    const raw = result.winner;
    if (typeof raw !== "number") return { winner: null, draw: false, status: result.status ?? null, raw: raw ?? null };
    if (!Number.isInteger(raw)) {
        return { winner: null, draw: true, status: result.status ?? null, raw };
    }

    // raw === 1 は usersCode[0] の勝利、raw === 0 は usersCode[1] の勝利
    const codeWinnerIndex = raw === 1 ? 0 : 1;
    // firstPlayerIndex が 1 のときは盤面スロット順が反転している
    const slotWinnerIndex = firstPlayerIndex === 1 ? (codeWinnerIndex === 0 ? 1 : 0) : codeWinnerIndex;

    return {
        winner: slotWinnerIndex,
        winnerName: players[slotWinnerIndex]?.username ?? null,
        draw: false,
        status: result.status ?? null,
        raw,
    };
}

/**
 * 逐次変換器を作る。
 *
 * 使い方:
 * ```js
 * const n = createNormalizer({ gameData, shortId });
 * n.pushFrames(chunkFrames);   // Tick 昇順で
 * n.pushLogs(logChunk);
 * const doc = n.finish();
 * ```
 *
 * @param {{ gameData?: any, shortId?: string | null, gameId?: string | null, fetchedAt?: string | null }} init
 */
export function createNormalizer(init = {}) {
    const meta = readGameMeta(init.gameData);
    const inner = init.gameData?.game?.game ?? {};

    const digits = typeof inner.terrain === "string" ? inner.terrain : "";
    // Arena の地形は正方形。辺の長さは全セル数の平方根から決まる
    const side = Math.round(Math.sqrt(digits.length));
    const width = side > 0 ? side : 0;
    const height = side > 0 ? side : 0;

    /** 静的オブジェクト（creep 以外）。初出時に 1 回だけ積む */
    const objects = new Map();
    /** 構造物の可変状態。差分を出すための直前値 */
    const structState = new Map();
    /** creep の可変状態 */
    const creepState = new Map();
    /** 出力する Tick 差分 */
    const ticks = [];
    /** 同じ Tick を二度書かないための番人（チャンク境界の重なり対策） */
    const seen = new Set();
    /** Tick → コンソールログ本文 */
    const logs = {};
    /** Tick → メタ情報。`splitLogLine` が拾ったもの */
    const extByTick = new Map();

    let lastTick = -1;
    let maxTick = 0;

    /** スロット名 → 陣営番号。`player1` → 0 */
    const sideOf = (user) => {
        if (user === undefined || user === null) return null;
        const m = /^player(\d+)$/.exec(String(user));
        if (m !== null) return Number(m[1]) - 1;
        const found = meta.players.findIndex((p) => p.userId === user || p.username === user);
        return found >= 0 ? found : null;
    };

    /**
     * 1 フレーム（= 1 Tick の完全スナップショット）を差分に畳む。
     * @param {any} frame
     */
    function pushFrame(frame) {
        const k = frame?.gameTime;
        if (typeof k !== "number" || seen.has(k)) return;
        seen.add(k);
        if (k < lastTick) {
            throw new Error(`frames must arrive in tick order (got ${k} after ${lastTick})`);
        }
        lastTick = k;
        if (k > maxTick) maxTick = k;

        const births = [];
        const updates = [];
        const bodies = [];
        const actions = [];
        const structDeltas = [];
        const ownerDeltas = [];
        const aliveCreeps = new Set();
        const aliveStructs = new Set();

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

        // 消えた creep = 死亡
        const dead = [];
        for (const id of creepState.keys()) {
            if (!aliveCreeps.has(id)) dead.push(id);
        }
        for (const id of dead) creepState.delete(id);

        // 消えた構造物 = 破壊。HP 0 の墓標を残す
        // （配列から消えるだけだと「そこに何も無い」と区別できない）
        for (const [id, st] of structState) {
            if (aliveStructs.has(id) || st.hits === 0) continue;
            st.hits = 0;
            st.energy = 0;
            structDeltas.push([id, 0, 0]);
        }

        const tick = { k };
        if (births.length > 0) tick.n = births;
        if (updates.length > 0) tick.u = updates;
        if (bodies.length > 0) tick.b = bodies;
        if (dead.length > 0) tick.x = dead;
        if (actions.length > 0) tick.a = actions;
        if (structDeltas.length > 0) tick.s = structDeltas;
        if (ownerDeltas.length > 0) tick.w = ownerDeltas;
        ticks.push(tick);
    }

    function collectCreep(o, births, updates, bodies) {
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
        if (prev.x !== o.x || prev.y !== o.y || prev.hits !== o.hits || prev.fatigue !== fatigue || prev.spawning !== spawning) {
            updates.push([id, o.x, o.y, o.hits, fatigue, spawning]);
            prev.x = o.x;
            prev.y = o.y;
            prev.hits = o.hits;
            prev.fatigue = fatigue;
            prev.spawning = spawning;
        }
        // パーツが壊れると body が縮む。見た目にも戦力評価にも効くので拾う
        if (prev.body !== body) {
            bodies.push([id, body]);
            prev.body = body;
        }
    }

    function collectStructure(o, structDeltas, ownerDeltas) {
        const id = idOf(o);
        const side = sideOf(o.user);
        const hits = typeof o.hits === "number" ? o.hits : 0;
        const energy = energyOf(o);
        let st = structState.get(id);

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
        // flag の所有者が変わる = 陣地の奪取。試合の山場なので必ず残す
        if (st.side !== side) {
            ownerDeltas.push([id, side]);
            st.side = side;
        }
    }

    function collectActions(o, actions) {
        const log = o.actionLog;
        if (!log) return;
        const id = idOf(o);
        for (const [name, value] of Object.entries(log)) {
            if (value === null || value === undefined) continue;
            const code = ACTION_CODE[name] ?? name;
            if (typeof value === "object" && typeof value.x === "number") {
                actions.push([id, code, value.x, value.y]);
            } else {
                // rangedMassAttack のように対象座標を持たない行動
                actions.push([id, code]);
            }
        }
    }

    return {
        /** @param {ReadonlyArray<any>} frames Tick 昇順のフレーム配列（1 チャンク分） */
        pushFrames(frames) {
            if (!Array.isArray(frames)) return;
            for (const frame of frames) pushFrame(frame);
        },

        /**
         * ログチャンク（`{ "<tick>": "<text>" }`）を取り込む。
         * 取得に失敗したチャンク（`{ status: 404 }`）は黙って捨てる。
         * @param {any} chunk
         */
        pushLogs(chunk) {
            if (!chunk || typeof chunk !== "object" || typeof chunk.status === "number") return;
            for (const [tick, text] of Object.entries(chunk)) {
                if (typeof text !== "string" || text === "") continue;
                const { log, ext } = splitLogLine(text);
                if (log !== "") logs[tick] = log;
                if (ext !== null) extByTick.set(Number(tick), ext);
            }
        },

        /** @returns {any} 正規化リプレイ */
        finish() {
            // ログ由来のメタ情報を対応する Tick へ載せる
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
 * `fetch_match` が保存した生 JSON を丸ごと正規化する。
 *
 * すでにファイルとして手元にある生ダンプ向け。これから取りに行くなら
 * フェッチャ側の逐次変換のほうがメモリを食わない。
 *
 * @param {any} raw
 * @param {{ shortId?: string | null }} [options]
 */
export function normalizeMatch(raw, options = {}) {
    if (!raw || typeof raw !== "object" || !raw.replays) {
        throw new Error("生のリプレイ JSON ではない（`replays` が無い）");
    }
    const n = createNormalizer({
        gameData: raw.gameData,
        shortId: options.shortId ?? raw.shortId ?? null,
        gameId: raw.realGameId ?? null,
        fetchedAt: raw.fetchedAt ?? null,
    });
    // チャンクの鍵は数値の文字列。辞書順だと 1000 が 200 より前に来るので数値で並べ直す
    const chunks = Object.keys(raw.replays)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    for (const c of chunks) {
        n.pushFrames(raw.replays[String(c)]);
        if (raw.logs) n.pushLogs(raw.logs[String(c)]);
    }
    return n.finish();
}
