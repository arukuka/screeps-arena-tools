import assert from "node:assert/strict";
import { test } from "node:test";

import { indexExtensions, splitLogLine } from "../src/extensions.js";

test("separates metadata lines from plain log text", () => {
    const { log, ext } = splitLogLine('hello\n@zones {"0":[3,2,1]}\nworld');
    assert.equal(log, "hello\nworld");
    assert.deepEqual(ext, { zones: [{ 0: [3, 2, 1] }] });
});

test("returns ext as null when no metadata exists", () => {
    const { log, ext } = splitLogLine("just a log line");
    assert.equal(log, "just a log line");
    assert.equal(ext, null);
});

test("ignores @ occurrences in the middle of sentences", () => {
    const { log, ext } = splitLogLine("email me at foo@example.com");
    assert.equal(log, "email me at foo@example.com");
    assert.equal(ext, null);
});

test("preserves non-JSON payloads as raw strings", () => {
    const { ext } = splitLogLine("@mode swarm");
    assert.deepEqual(ext, { mode: ["swarm"] });
});

test("evaluates value-less markers to true", () => {
    const { ext } = splitLogLine("@flagCaptured");
    assert.deepEqual(ext, { flagCaptured: [true] });
});

test("preserves multiple entries for the same namespace in one tick as an array", () => {
    const { ext } = splitLogLine("@ev a\n@ev b");
    assert.deepEqual(ext, { ev: ["a", "b"] });
});

test("handles empty string gracefully", () => {
    assert.deepEqual(splitLogLine(""), { log: "", ext: null });
});

test("builds namespace index across ticks", () => {
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
