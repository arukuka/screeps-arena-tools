import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createNormalizer, encodeBody, normalizeMatch, readGameMeta } from "../src/normalize.js";
import { buildTimeline, bodySize, stateAt } from "../src/timeline.js";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** 実試合 XTTCQ7DA4T の先頭 9 Tick を切り出したもの（`docs/FORMAT.md` 参照） */
const raw = JSON.parse(readFileSync(fixture("XTTCQ7DA4T.raw-slice.json"), "utf-8"));

test("body をランレングスに畳む", () => {
    assert.equal(encodeBody([{ type: "move" }, { type: "move" }, { type: "attack" }]), "m2a1");
    // 並び順は落とさない。ダメージが前方から入るので tough の位置に意味がある
    assert.equal(encodeBody([{ type: "tough" }, { type: "move" }, { type: "tough" }]), "t1m1t1");
    assert.equal(encodeBody([]), "");
});

test("player1 / player2 を実際のユーザ名に対応づける", () => {
    // リプレイ本体は "player1" としか言わない。usersCode 経由で辿る必要がある
    const doc = normalizeMatch(raw, { shortId: "XTTCQ7DA4T" });
    assert.deepEqual(
        doc.meta.players.map((p) => p.username),
        ["arukuka", "Opponent"],
    );
    assert.equal(doc.meta.players[0].slot, "player1");
});

test("firstPlayerIndex: 1 のときにスロット順（陣営）と勝者が正しく反転・解決される", () => {
    // HD8LGUUED5 と同等の構成: usersCode[0]=arukuka, usersCode[1]=安兴, firstPlayerIndex=1, winner=0 (usersCode[1]の勝ち)
    const mockGameData = {
        game: {
            users: [
                { _id: "userA", username: "arukuka" },
                { _id: "userB", username: "安兴" },
            ],
            codes: [
                { _id: "codeA", user: "userA", version: 24 },
                { _id: "codeB", user: "userB", version: 46 },
            ],
            game: {
                usersCode: ["codeA", "codeB"],
                playerColor: ["#FF3333", "#5555FF"],
                firstPlayerIndex: 1,
                result: { status: "ok", winner: 0 },
            },
        },
    };
    const meta = readGameMeta(mockGameData);
    // firstPlayerIndex: 1 により、スロット0 (player1, 赤, 上) が安兴、スロット1 (player2, 青, 下) が arukuka
    assert.equal(meta.players[0].username, "安兴");
    assert.equal(meta.players[0].slot, "player1");
    assert.equal(meta.players[0].side, 0);
    assert.equal(meta.players[0].codeVersion, 46);
    assert.equal(meta.players[1].username, "arukuka");
    assert.equal(meta.players[1].slot, "player2");
    assert.equal(meta.players[1].side, 1);
    assert.equal(meta.players[1].codeVersion, 24);

    // winner: 0 (usersCode[1] = 安兴の勝ち) -> スロット0 (安兴) の勝ち
    assert.equal(meta.result.draw, false);
    assert.equal(meta.result.winner, 0);
    assert.equal(meta.result.winnerName, "安兴");
    assert.equal(meta.result.raw, 0);
});

test("firstPlayerIndex: 0 のときの勝者解決", () => {
    // 2LI827DGUX と同等の構成: usersCode[0]=arukuka, usersCode[1]=Zeus, firstPlayerIndex=0, winner=1 (usersCode[0]の勝ち)
    const mockGameData = {
        game: {
            users: [
                { _id: "userA", username: "arukuka" },
                { _id: "userB", username: "Zeus" },
            ],
            codes: [
                { _id: "codeA", user: "userA", version: 24 },
                { _id: "codeB", user: "userB", version: 3 },
            ],
            game: {
                usersCode: ["codeA", "codeB"],
                playerColor: ["#FF3333", "#5555FF"],
                firstPlayerIndex: 0,
                result: { status: "ok", winner: 1 },
            },
        },
    };
    const meta = readGameMeta(mockGameData);
    assert.equal(meta.players[0].username, "arukuka");
    assert.equal(meta.players[1].username, "Zeus");

    // winner: 1 (usersCode[0] = arukukaの勝ち) -> スロット0 (arukuka) の勝ち
    assert.equal(meta.result.winner, 0);
    assert.equal(meta.result.winnerName, "arukuka");
});

test("引き分けを勝者 0.5 から読む", () => {
    // 実測 (2026-08-28): 引き分けだけ整数でない値が入る
    const doc = normalizeMatch(raw);
    assert.equal(doc.meta.result.draw, true);
    assert.equal(doc.meta.result.winner, null);
    assert.equal(doc.meta.result.raw, 0.5);
});

test("盤面の大きさを地形の長さから決める", () => {
    const doc = normalizeMatch(raw);
    assert.equal(doc.meta.width, 100);
    assert.equal(doc.meta.height, 100);
});

test("静的オブジェクトは 1 回だけ、差分は変化したものだけ", () => {
    const doc = normalizeMatch(raw);
    assert.equal(doc.objects.length, 336);
    // 生は毎 Tick 全オブジェクトを繰り返す。畳めていなければここが 336*9 相当に膨らむ
    const totalStructDeltas = doc.ticks.reduce((n, t) => n + (t.s?.length ?? 0), 0);
    assert.ok(totalStructDeltas < 336, `構造物差分が畳めていない: ${totalStructDeltas}`);
});

test("ログのメタ情報が該当 Tick に載る", () => {
    const doc = normalizeMatch(raw);
    const tick = doc.ticks.find((t) => t.k === 3);
    assert.deepEqual(tick.e.zones, [{ 0: [3, 2, 1], 1: [1, 1, 4] }]);
    assert.deepEqual(tick.e.mode, ["swarm"]);
    // 本文は残り、メタ情報行だけが抜ける
    assert.equal(doc.logs["3"], "hello from bot");
    assert.deepEqual(Object.keys(doc.extensions).sort(), ["mode", "zones"]);
});

test("差分から復元した盤面が生スナップショットと一致する", () => {
    const doc = normalizeMatch(raw);
    const timeline = buildTimeline(doc);

    const rawFrames = new Map();
    for (const chunk of Object.values(raw.replays)) {
        for (const frame of chunk) rawFrames.set(frame.gameTime, frame);
    }

    let compared = 0;
    for (let i = 0; i < doc.ticks.length; i++) {
        const state = stateAt(timeline, i);
        const frame = rawFrames.get(doc.ticks[i].k);
        assert.ok(frame !== undefined);

        for (const o of frame.objects) {
            const id = String(o._id);
            compared++;
            if (o.type === "creep") {
                const c = state.creeps.get(id);
                assert.ok(c !== undefined, `tick ${frame.gameTime}: creep ${id} が復元されない`);
                assert.deepEqual([c.x, c.y, c.hits], [o.x, o.y, o.hits]);
                assert.equal(bodySize(c.body), o.body.length);
            } else {
                const s = state.struct.get(id);
                assert.ok(s !== undefined, `tick ${frame.gameTime}: 構造物 ${id} が復元されない`);
                assert.equal(s.hits, o.hits ?? 0);
                assert.equal(s.energy, o.store?.energy ?? 0);
            }
        }
        // 生に無い creep を復元してしまっていないか（死亡の取りこぼし検出）
        assert.equal(state.creeps.size, frame.objects.filter((o) => o.type === "creep").length);
    }
    assert.ok(compared > 3000, `比較したオブジェクトが少なすぎる: ${compared}`);
});

test("チャンクを分けて渡しても一括と同じ結果になる", () => {
    const whole = normalizeMatch(raw);
    const incremental = createNormalizer({ gameData: raw.gameData });
    for (const key of ["0", "100"]) {
        incremental.pushFrames(raw.replays[key]);
        incremental.pushLogs(raw.logs[key]);
    }
    const doc = incremental.finish();
    assert.deepEqual(doc.ticks, whole.ticks);
    assert.deepEqual(doc.objects, whole.objects);
});

test("Tick が逆行したら気づく", () => {
    // 順序が崩れると差分が黙って壊れる。落として気づけるようにしておく
    const n = createNormalizer({ gameData: raw.gameData });
    n.pushFrames([{ gameTime: 5, objects: [] }]);
    assert.throws(() => n.pushFrames([{ gameTime: 2, objects: [] }]), /tick order/);
});

test("取得に失敗したログチャンクは黙って捨てる", () => {
    const n = createNormalizer({ gameData: raw.gameData });
    n.pushFrames(raw.replays["0"]);
    n.pushLogs({ status: 404, statusText: "" });
    assert.deepEqual(n.finish().logs, {});
});

test("生の形でない JSON は弾く", () => {
    assert.throws(() => normalizeMatch({ hello: 1 }), /生のリプレイ JSON ではない/);
});
