import assert from "node:assert/strict";
import { test } from "node:test";

import { matchUrl, parseMatchRef } from "../src/arena_url.js";

test("accepts short ID directly", () => {
    assert.equal(parseMatchRef("XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("accepts full share URL", () => {
    assert.equal(parseMatchRef("https://arena.screeps.com/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("strips URL decorations (query, fragment, omitted scheme)", () => {
    assert.equal(parseMatchRef("https://arena.screeps.com/game/XTTCQ7DA4T?from=discord"), "XTTCQ7DA4T");
    assert.equal(parseMatchRef("https://arena.screeps.com/game/XTTCQ7DA4T#replay"), "XTTCQ7DA4T");
    assert.equal(parseMatchRef("arena.screeps.com/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
    assert.equal(parseMatchRef("http://arena.screeps.com/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("accepts app custom scheme URLs", () => {
    assert.equal(parseMatchRef("screeps-arena:/game/XTTCQ7DA4T"), "XTTCQ7DA4T");
});

test("strips surrounding whitespace and quotes", () => {
    assert.equal(parseMatchRef('  "https://arena.screeps.com/game/XTTCQ7DA4T"  '), "XTTCQ7DA4T");
});

test("converts lowercase URLs to uppercase short IDs", () => {
    assert.equal(parseMatchRef("https://arena.screeps.com/game/xttcq7da4t"), "XTTCQ7DA4T");
});

test("passes valid MongoDB ObjectIds through directly", () => {
    assert.equal(parseMatchRef("6a91f24fe5664ad5be8d41a3"), "6a91f24fe5664ad5be8d41a3");
});

test("throws on invalid input", () => {
    assert.throws(() => parseMatchRef(""), /empty/);
    assert.throws(() => parseMatchRef("https://example.com/"), /Cannot resolve match reference/);
    assert.throws(() => parseMatchRef("not a match"), /Cannot resolve match reference/);
});

test("matchUrl reconstructs shareable URL", () => {
    assert.equal(matchUrl("XTTCQ7DA4T"), "https://arena.screeps.com/game/XTTCQ7DA4T");
    assert.equal(parseMatchRef(matchUrl("XTTCQ7DA4T")), "XTTCQ7DA4T");
});
