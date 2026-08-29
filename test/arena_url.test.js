import assert from "node:assert/strict";
import { test } from "node:test";

import { matchUrl, parseMatchRef } from "../src/arena_url.js";

test("短縮 ID をそのまま受ける", () => {
    assert.equal(parseMatchRef("XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("共有 URL を貼り付けても通る", () => {
    // 利用者が最も自然にやる操作。ブラウザからコピーしたまま渡せること
    assert.equal(parseMatchRef("https://arena.screeps.com/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("URL の飾り（クエリ・フラグメント・スキーム省略）を落とす", () => {
    assert.equal(parseMatchRef("https://arena.screeps.com/game/XTTCQ7DA4T?from=discord"), "XTTCQ7DA4T");
    assert.equal(parseMatchRef("https://arena.screeps.com/game/XTTCQ7DA4T#replay"), "XTTCQ7DA4T");
    assert.equal(parseMatchRef("arena.screeps.com/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
    assert.equal(parseMatchRef("http://arena.screeps.com/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("アプリのカスタムスキームも受ける", () => {
    assert.equal(parseMatchRef("screeps-arena:/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("前後の空白と引用符を落とす", () => {
    assert.equal(parseMatchRef('  "https://arena.screeps.com/game/XTTCQ7DA4T"  '), "XTTCQ7DA4T");
});

test("URL 経由なら小文字でも大文字に直す", () => {
    assert.equal(parseMatchRef("https://arena.screeps.com/game/xttcq7da4t"), "XTTCQ7DA4T");
});

test("本物の ObjectId はそのまま通す", () => {
    // リプレイ API が実際に要求する形。解決済みの ID を直接渡せると調査が楽
    assert.equal(parseMatchRef("6a91f24fe5664ad5be8d41a3"), "6a91f24fe5664ad5be8d41a3");
});

test("解釈できない入力は例外にする", () => {
    assert.throws(() => parseMatchRef(""), /empty/);
    assert.throws(() => parseMatchRef("https://example.com/"), /試合を特定できない/);
    assert.throws(() => parseMatchRef("not a match"), /試合を特定できない/);
});

test("matchUrl は共有 URL に戻せる", () => {
    assert.equal(matchUrl("XTTCQ7DA4T"), "https://arena.screeps.com/game/XTTCQ7DA4T");
    assert.equal(parseMatchRef(matchUrl("XTTCQ7DA4T")), "XTTCQ7DA4T");
});
