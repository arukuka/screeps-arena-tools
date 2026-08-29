import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeTerrain, encodeTerrain } from "../src/terrain.js";

test("数字列をランレングスに畳む", () => {
    assert.equal(encodeTerrain("000111022"), "p3w3p1s2");
});

test("往復して元の並びに戻る", () => {
    const digits = "0011220100";
    const cells = decodeTerrain(encodeTerrain(digits), 10, 1);
    assert.deepEqual([...cells], [...digits].map(Number));
});

test("足りない入力でも width*height の配列を返す", () => {
    // 壊れたログで描画ごと落ちるより、欠けを plain として見せたほうが調べやすい
    const cells = decodeTerrain("p4", 10, 1);
    assert.equal(cells.length, 10);
    assert.deepEqual([...cells], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("余分な入力は width*height で打ち切る", () => {
    const cells = decodeTerrain("w100", 3, 1);
    assert.deepEqual([...cells], [1, 1, 1]);
});
