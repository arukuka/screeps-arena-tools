import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { listReplays, resolveServeOptions, safeJoin } from "../src/serve.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("root の中は通す", () => {
    assert.equal(safeJoin("/srv/viewer", "/app.js"), "/srv/viewer/app.js");
    assert.equal(safeJoin("/srv/viewer", "/"), "/srv/viewer");
});

test("root の外に出る要求を弾く", () => {
    // 手元用のサーバでも、`..` でホームまで読めるものを立てるのは筋が悪い
    assert.equal(safeJoin("/srv/viewer", "/../../etc/passwd"), null);
    assert.equal(safeJoin("/srv/viewer", "/%2e%2e/%2e%2e/etc/passwd"), null);
    assert.equal(safeJoin("/srv/viewer", "/..%2f..%2fetc/passwd"), null);
});

test("壊れたエスケープと NUL を弾く", () => {
    assert.equal(safeJoin("/srv/viewer", "/%"), null);
    assert.equal(safeJoin("/srv/viewer", "/a%00b"), null);
});

test("接頭辞が同じだけの別ディレクトリを root 扱いしない", () => {
    assert.equal(safeJoin("/srv/viewer", "/../viewer-secrets/x"), null);
});

test("リプレイ置き場が無くても落ちない", () => {
    assert.deepEqual(listReplays(resolve(ROOT, "no-such-dir")), []);
});

test("リプレイ以外は一覧に出さない", () => {
    const found = listReplays(resolve(ROOT, "test/fixtures"));
    const names = found.map((f) => f.file);
    assert.ok(names.includes("XTTCQ7DA4T.replay.json.gz"));
    assert.ok(names.every((n) => n.endsWith(".json") || n.endsWith(".json.gz")));
});

test("既定の置き場を解決する", () => {
    const opts = resolveServeOptions(ROOT, {});
    assert.equal(opts.viewerDir, resolve(ROOT, "viewer"));
    assert.equal(opts.srcDir, resolve(ROOT, "src"));
    assert.ok(opts.port > 0);
});

test("プラグイン置き場を明示的に無効化できる", () => {
    assert.equal(resolveServeOptions(ROOT, { pluginDir: null }).pluginDir, null);
});
