import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeTerrain, encodeTerrain } from "../src/terrain.js";

test("encodes digit strings into run-length terrain format", () => {
    assert.equal(encodeTerrain("000111022"), "p3w3p1s2");
});

test("round-trips back to original cell sequence", () => {
    const digits = "0011220100";
    const cells = decodeTerrain(encodeTerrain(digits), 10, 1);
    assert.deepEqual([...cells], [...digits].map(Number));
});

test("pads shorter input with plain to match width*height", () => {
    const cells = decodeTerrain("p4", 10, 1);
    assert.equal(cells.length, 10);
    assert.deepEqual([...cells], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("truncates input exceeding width*height", () => {
    const cells = decodeTerrain("w100", 3, 1);
    assert.deepEqual([...cells], [1, 1, 1]);
});
