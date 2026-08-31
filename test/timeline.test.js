import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { KEYFRAME_STRIDE, applyFrame, bodyCounts, bodySize, buildTimeline, parseBody, sideStats, stateAt } from "../src/timeline.js";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Normalized match fixture XTTCQ7DA4T (2000 ticks / draw). */
const doc = JSON.parse(gunzipSync(readFileSync(fixture("XTTCQ7DA4T.replay.json.gz"))).toString("utf-8"));

test("parses body run-length strings", () => {
    assert.deepEqual(parseBody("m2a1"), [
        { code: "m", name: "move", count: 2 },
        { code: "a", name: "attack", count: 1 },
    ]);
    assert.equal(bodySize("m2a1"), 3);
    assert.deepEqual(bodyCounts("t2m3t1"), { tough: 3, move: 3 });
});

test("loads a real match replay document", () => {
    const timeline = buildTimeline(doc);
    assert.equal(timeline.width, 100);
    assert.equal(timeline.length, doc.ticks.length);
    assert.equal(timeline.terrain.length, 100 * 100);
    assert.equal(timeline.base.struct.size, doc.objects.length);
});

test("keyframe reconstruction matches sequential application", () => {
    const timeline = buildTimeline(doc);
    const walked = {
        tick: 0,
        creeps: new Map(),
        struct: new Map([...timeline.base.struct].map(([k, v]) => [k, { ...v }])),
        owner: new Map(timeline.base.owner),
        actions: [],
    };
    for (let i = 0; i < timeline.length; i++) {
        applyFrame(walked, doc.ticks[i]);
        if (i % 137 !== 0 && i !== KEYFRAME_STRIDE && i !== KEYFRAME_STRIDE - 1) continue;
        const seeked = stateAt(timeline, i);
        assert.equal(seeked.tick, walked.tick, `tick index ${i}`);
        assert.equal(seeked.creeps.size, walked.creeps.size, `tick index ${i} creep count`);
        for (const [id, c] of walked.creeps) {
            assert.deepEqual(
                [seeked.creeps.get(id).x, seeked.creeps.get(id).y, seeked.creeps.get(id).hits],
                [c.x, c.y, c.hits],
                `tick index ${i} creep ${id}`,
            );
        }
    }
});

test("clamps out-of-range seeks to bounds", () => {
    const timeline = buildTimeline(doc);
    assert.equal(stateAt(timeline, -50).tick, doc.ticks[0].k);
    assert.equal(stateAt(timeline, 99999).tick, doc.ticks[doc.ticks.length - 1].k);
});

test("does not carry actions across ticks", () => {
    const state = { tick: 0, creeps: new Map(), struct: new Map(), owner: new Map(), actions: [] };
    applyFrame(state, { k: 1, a: [["1", "a", 2, 3]] });
    assert.equal(state.actions.length, 1);
    applyFrame(state, { k: 2 });
    assert.equal(state.actions.length, 0);
});

test("computes side statistics for both sides", () => {
    const timeline = buildTimeline(doc);
    const stats = sideStats(timeline, stateAt(timeline, 600));
    assert.equal(stats.length, 2);
    for (const s of stats) {
        assert.ok(s.structures > 0, "structures not counted");
        assert.ok(s.hits <= s.hitsMax);
    }
    assert.ok(stats.some((s) => s.creeps > 0), "no creeps present mid-game");
});

test("records flag ownership transitions", () => {
    const flagIds = new Set(doc.objects.filter((o) => o.kind === "flag").map((o) => o.id));
    const captures = doc.ticks.filter((t) => (t.w ?? []).some(([id]) => flagIds.has(id)));
    assert.ok(captures.length > 0, "flag ownership transition not recorded");
});
