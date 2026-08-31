import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createNormalizer, encodeBody, normalizeMatch, readGameMeta } from "../src/normalize.js";
import { buildTimeline, bodySize, stateAt } from "../src/timeline.js";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** First 9 ticks sliced from real match XTTCQ7DA4T (see `docs/FORMAT.md`). */
const raw = JSON.parse(readFileSync(fixture("XTTCQ7DA4T.raw-slice.json"), "utf-8"));

test("encodes body parts into run-length string", () => {
    assert.equal(encodeBody([{ type: "move" }, { type: "move" }, { type: "attack" }]), "m2a1");
    assert.equal(encodeBody([{ type: "tough" }, { type: "move" }, { type: "tough" }]), "t1m1t1");
    assert.equal(encodeBody([]), "");
});

test("maps player1 / player2 slots to real usernames", () => {
    const doc = normalizeMatch(raw, { shortId: "XTTCQ7DA4T" });
    assert.deepEqual(
        doc.meta.players.map((p) => p.username),
        ["arukuka", "Opponent"],
    );
    assert.equal(doc.meta.players[0].slot, "player1");
});

test("inverts slots and winner correctly when firstPlayerIndex is 1", () => {
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
    assert.equal(meta.players[0].username, "安兴");
    assert.equal(meta.players[0].slot, "player1");
    assert.equal(meta.players[0].side, 0);
    assert.equal(meta.players[0].codeVersion, 46);
    assert.equal(meta.players[1].username, "arukuka");
    assert.equal(meta.players[1].slot, "player2");
    assert.equal(meta.players[1].side, 1);
    assert.equal(meta.players[1].codeVersion, 24);

    assert.equal(meta.result.draw, false);
    assert.equal(meta.result.winner, 0);
    assert.equal(meta.result.winnerName, "安兴");
    assert.equal(meta.result.raw, 0);
});

test("resolves winner when firstPlayerIndex is 0", () => {
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

    assert.equal(meta.result.winner, 0);
    assert.equal(meta.result.winnerName, "arukuka");
});

test("parses draw from winner score of 0.5", () => {
    const doc = normalizeMatch(raw);
    assert.equal(doc.meta.result.draw, true);
    assert.equal(doc.meta.result.winner, null);
    assert.equal(doc.meta.result.raw, 0.5);
});

test("derives board dimensions from terrain string length", () => {
    const doc = normalizeMatch(raw);
    assert.equal(doc.meta.width, 100);
    assert.equal(doc.meta.height, 100);
});

test("stores static objects once and keeps only deltas per tick", () => {
    const doc = normalizeMatch(raw);
    assert.equal(doc.objects.length, 336);
    const totalStructDeltas = doc.ticks.reduce((n, t) => n + (t.s?.length ?? 0), 0);
    assert.ok(totalStructDeltas < 336, `structure deltas not folded: ${totalStructDeltas}`);
});

test("attaches log metadata to corresponding ticks", () => {
    const doc = normalizeMatch(raw);
    const tick = doc.ticks.find((t) => t.k === 3);
    assert.deepEqual(tick.e.zones, [{ 0: [3, 2, 1], 1: [1, 1, 4] }]);
    assert.deepEqual(tick.e.mode, ["swarm"]);
    assert.equal(doc.logs["3"], "hello from bot");
    assert.deepEqual(Object.keys(doc.extensions).sort(), ["mode", "zones"]);
});

test("reconstructed board matches raw snapshots across all ticks", () => {
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
                assert.ok(c !== undefined, `tick ${frame.gameTime}: creep ${id} not reconstructed`);
                assert.deepEqual([c.x, c.y, c.hits], [o.x, o.y, o.hits]);
                assert.equal(bodySize(c.body), o.body.length);
            } else {
                const s = state.struct.get(id);
                assert.ok(s !== undefined, `tick ${frame.gameTime}: structure ${id} not reconstructed`);
                assert.equal(s.hits, o.hits ?? 0);
                assert.equal(s.energy, o.store?.energy ?? 0);
            }
        }
        assert.equal(state.creeps.size, frame.objects.filter((o) => o.type === "creep").length);
    }
    assert.ok(compared > 3000, `too few objects compared: ${compared}`);
});

test("incremental chunk ingestion matches batch normalization", () => {
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

test("detects out-of-order tick arrival", () => {
    const n = createNormalizer({ gameData: raw.gameData });
    n.pushFrames([{ gameTime: 5, objects: [] }]);
    assert.throws(() => n.pushFrames([{ gameTime: 2, objects: [] }]), /tick order/);
});

test("silently ignores failed log chunks", () => {
    const n = createNormalizer({ gameData: raw.gameData });
    n.pushFrames(raw.replays["0"]);
    n.pushLogs({ status: 404, statusText: "" });
    assert.deepEqual(n.finish().logs, {});
});

test("rejects invalid non-replay JSON input", () => {
    assert.throws(() => normalizeMatch({ hello: 1 }), /not a raw replay JSON/);
});
