import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getNetworkAddresses, listReplays, resolveServeOptions, safeJoin } from "../src/serve.js";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = CURRENT_DIR.endsWith("dist/test") || CURRENT_DIR.endsWith("dist\\test")
    ? resolve(CURRENT_DIR, "../..")
    : resolve(CURRENT_DIR, "..");

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
    assert.equal(item.meta.players?.length, 2);
    assert.equal(item.meta.players?.[0]?.username, "arukuka");
    assert.equal(item.meta.players?.[0]?.codeVersion, 17);
    assert.equal(item.meta.players?.[1]?.username, "Opponent");
    assert.equal(item.meta.players?.[1]?.codeVersion, 21);
    assert.equal(item.meta.result?.draw, true);
});

test("resolves default serve options", () => {
    const opts = resolveServeOptions(ROOT, {});
    assert.equal(opts.viewerDir, resolve(ROOT, "viewer"));
    assert.equal(opts.srcDir, resolve(ROOT, "src"));
    assert.equal(opts.host, undefined);
    assert.ok(opts.port > 0);
});

test("resolves custom host option", () => {
    const opts = resolveServeOptions(ROOT, { host: "0.0.0.0" });
    assert.equal(opts.host, "0.0.0.0");
});

test("getNetworkAddresses returns valid IPv4 addresses", () => {
    const addrs = getNetworkAddresses();
    assert.ok(Array.isArray(addrs));
    for (const addr of addrs) {
        assert.match(addr, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
        assert.notEqual(addr, "127.0.0.1");
    }
});

test("allows explicitly disabling plugin directory", () => {
    assert.equal(resolveServeOptions(ROOT, { pluginDir: null }).pluginDir, null);
});

test("redirects / to /replays and serves index.html for SPA routes", async () => {
    const { serve } = await import("../src/serve.js");
    const http = await import("node:http");

    const opts = resolveServeOptions(ROOT, { port: 5789 });
    const srv = serve(opts);

    const get = (path: string) =>
        new Promise<{ status: number; location?: string; type?: string }>((res) => {
            http.get(`http://localhost:5789${path}`, (r) => {
                res({
                    status: r.statusCode ?? 0,
                    location: r.headers.location,
                    type: r.headers["content-type"],
                });
            });
        });

    try {
        const root = await get("/");
        assert.equal(root.status, 302);
        assert.equal(root.location, "/replays");

        const replays = await get("/replays");
        assert.equal(replays.status, 200);
        assert.ok(replays.type?.includes("text/html"));

        const fame = await get("/fame");
        assert.equal(fame.status, 200);
        assert.ok(fame.type?.includes("text/html"));

        const match = await get("/replays/XTTCQ7DA4T");
        assert.equal(match.status, 200);
        assert.ok(match.type?.includes("text/html"));
    } finally {
        srv.close();
    }
});

test("binds to explicit host when host option is specified", async () => {
    const { serve } = await import("../src/serve.js");
    const http = await import("node:http");

    const opts = resolveServeOptions(ROOT, { port: 5790, host: "127.0.0.1" });
    const srv = serve(opts);

    const get = (path: string) =>
        new Promise<{ status: number }>((res) => {
            http.get(`http://127.0.0.1:5790${path}`, (r) => {
                res({ status: r.statusCode ?? 0 });
            });
        });

    try {
        const root = await get("/");
        assert.equal(root.status, 302);
    } finally {
        srv.close();
    }
});

