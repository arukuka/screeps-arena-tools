import assert from "node:assert/strict";
import { test } from "node:test";

import { indexExtensions, splitLogLine } from "../src/extensions.js";

test("メタ情報行を本文から分離する", () => {
    const { log, ext } = splitLogLine('hello\n@zones {"0":[3,2,1]}\nworld');
    // 本文にメタ情報が残るとログ欄が埋まって本来の出力が読めなくなる
    assert.equal(log, "hello\nworld");
    assert.deepEqual(ext, { zones: [{ 0: [3, 2, 1] }] });
});

test("メタ情報が無ければ ext は null", () => {
    const { log, ext } = splitLogLine("just a log line");
    assert.equal(log, "just a log line");
    assert.equal(ext, null);
});

test("行中の @ はメタ情報にしない", () => {
    const { log, ext } = splitLogLine("email me at foo@example.com");
    assert.equal(log, "email me at foo@example.com");
    assert.equal(ext, null);
});

test("JSON として読めないペイロードは文字列のまま持つ", () => {
    const { ext } = splitLogLine("@mode swarm");
    assert.deepEqual(ext, { mode: ["swarm"] });
});

test("値の無い印は true になる", () => {
    const { ext } = splitLogLine("@flagCaptured");
    assert.deepEqual(ext, { flagCaptured: [true] });
});

test("同じ Tick に同じ名前空間が複数あっても配列で全部残す", () => {
    // 値が 1 件でも配列。読む側で場合分けが要らないほうが事故が少ない
    const { ext } = splitLogLine("@ev a\n@ev b");
    assert.deepEqual(ext, { ev: ["a", "b"] });
});

test("空文字列は何も生まない", () => {
    assert.deepEqual(splitLogLine(""), { log: "", ext: null });
});

test("名前空間の索引を作る", () => {
    const index = indexExtensions([
        { k: 3, e: { zones: [1] } },
        { k: 5 },
        { k: 9, e: { zones: [1, 2], mode: ["x"] } },
    ]);
    assert.deepEqual(index, {
        zones: { count: 3, firstTick: 3, lastTick: 9 },
        mode: { count: 1, firstTick: 9, lastTick: 9 },
    });
});
