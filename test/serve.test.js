import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { listReplays, resolveServeOptions, safeJoin } from "../src/serve.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("allows paths within root directory", () => {
    assert.equal(safeJoin("/srv/viewer", "/app.js"), "/srv/viewer/app.js");
    assert.equal(safeJoin("/srv/viewer", "/"), "/srv/viewer");
});

test("blocks path traversal outside root directory", () => {
    assert.equal(safeJoin("/srv/viewer", "/../../etc/passwd"), null);
    assert.equal(safeJoin("/srv/viewer", "/%2e%2e/%2e%2e/etc/passwd"), null);
    assert.equal(safeJoin("/srv/viewer", "/..%2f..%2fetc/passwd"), null);
});

test("rejects malformed escape sequences and NUL bytes", () => {
    assert.equal(safeJoin("/srv/viewer", "/%"), null);
    assert.equal(safeJoin("/srv/viewer", "/a%00b"), null);
});

test("does not treat sibling directories with shared prefix as root", () => {
    assert.equal(safeJoin("/srv/viewer", "/../viewer-secrets/x"), null);
});

test("returns empty list if replay directory does not exist", () => {
    assert.deepEqual(listReplays(resolve(ROOT, "no-such-dir")), []);
});

test("filters out non-replay files from replay list", () => {
    const found = listReplays(resolve(ROOT, "test/fixtures"));
    const names = found.map((f) => f.file);
    assert.ok(names.includes("XTTCQ7DA4T.replay.json.gz"));
    assert.ok(names.every((n) => n.endsWith(".json") || n.endsWith(".json.gz")));
});

test("extracts player, version, and result metadata in replay listing", () => {
    const found = listReplays(resolve(ROOT, "test/fixtures"));
    const item = found.find((f) => f.file === "XTTCQ7DA4T.replay.json.gz");
    assert.ok(item);
    assert.ok(item.meta);
    assert.equal(item.meta.shortId, "XTTCQ7DA4T");
    assert.equal(item.meta.players.length, 2);
    assert.equal(item.meta.players[0].username, "arukuka");
    assert.equal(item.meta.players[0].codeVersion, 17);
    assert.equal(item.meta.players[1].username, "Opponent");
    assert.equal(item.meta.players[1].codeVersion, 21);
    assert.equal(item.meta.result.draw, true);
});

test("resolves default serve options", () => {
    const opts = resolveServeOptions(ROOT, {});
    assert.equal(opts.viewerDir, resolve(ROOT, "viewer"));
    assert.equal(opts.srcDir, resolve(ROOT, "src"));
    assert.ok(opts.port > 0);
});

test("allows explicitly disabling plugin directory", () => {
    assert.equal(resolveServeOptions(ROOT, { pluginDir: null }).pluginDir, null);
});
