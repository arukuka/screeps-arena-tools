import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { KEYFRAME_STRIDE, applyFrame, bodyCounts, bodySize, buildTimeline, parseBody, sideStats, stateAt } from "../src/timeline.js";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** 実試合 XTTCQ7DA4T（2000 Tick / 引き分け）を正規化したもの */
const doc = JSON.parse(gunzipSync(readFileSync(fixture("XTTCQ7DA4T.replay.json.gz"))).toString("utf-8"));

test("body を読み解く", () => {
    assert.deepEqual(parseBody("m2a1"), [
        { code: "m", name: "move", count: 2 },
        { code: "a", name: "attack", count: 1 },
    ]);
    assert.equal(bodySize("m2a1"), 3);
    assert.deepEqual(bodyCounts("t2m3t1"), { tough: 3, move: 3 });
});

test("実試合を読み込める", () => {
    const timeline = buildTimeline(doc);
    assert.equal(timeline.width, 100);
    assert.equal(timeline.length, doc.ticks.length);
    assert.equal(timeline.terrain.length, 100 * 100);
    assert.equal(timeline.base.struct.size, doc.objects.length);
});

test("キーフレーム経由の復元が逐次適用と一致する", () => {
    // stateAt はキーフレームから前進する。境界の前後で食い違えばここで落ちる
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
        assert.equal(seeked.creeps.size, walked.creeps.size, `tick index ${i} の creep 数`);
        for (const [id, c] of walked.creeps) {
            assert.deepEqual(
                [seeked.creeps.get(id).x, seeked.creeps.get(id).y, seeked.creeps.get(id).hits],
                [c.x, c.y, c.hits],
                `tick index ${i} の creep ${id}`,
            );
        }
    }
});

test("範囲外の seek は端に丸める", () => {
    const timeline = buildTimeline(doc);
    assert.equal(stateAt(timeline, -50).tick, doc.ticks[0].k);
    assert.equal(stateAt(timeline, 99999).tick, doc.ticks[doc.ticks.length - 1].k);
});

test("行動はその Tick 限りで持ち越さない", () => {
    // 持ち越すと攻撃線が盤面に残り続けてしまう
    const state = { tick: 0, creeps: new Map(), struct: new Map(), owner: new Map(), actions: [] };
    applyFrame(state, { k: 1, a: [["1", "a", 2, 3]] });
    assert.equal(state.actions.length, 1);
    applyFrame(state, { k: 2 });
    assert.equal(state.actions.length, 0);
});

test("陣営ごとの集計が両陣営ぶん出る", () => {
    const timeline = buildTimeline(doc);
    // 序盤は creep が居ないので、両者が展開しきった中盤で見る
    const stats = sideStats(timeline, stateAt(timeline, 600));
    assert.equal(stats.length, 2);
    for (const s of stats) {
        assert.ok(s.structures > 0, "構造物が数えられていない");
        assert.ok(s.hits <= s.hitsMax);
    }
    assert.ok(stats.some((s) => s.creeps > 0), "中盤なのに creep が 1 体も居ない");
});

test("flag の所有者交代が記録されている", () => {
    // 実試合 XTTCQ7DA4T では rampartsRight が奪われている。山場が消えていないことの確認
    const flagIds = new Set(doc.objects.filter((o) => o.kind === "flag").map((o) => o.id));
    const captures = doc.ticks.filter((t) => (t.w ?? []).some(([id]) => flagIds.has(id)));
    assert.ok(captures.length > 0, "flag の所有者交代が 1 度も記録されていない");
});
