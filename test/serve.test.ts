import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

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

    const opts = resolveServeOptions(ROOT, { port: 5789, disableFamePolling: true });
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

    const opts = resolveServeOptions(ROOT, { port: 5790, host: "127.0.0.1", disableFamePolling: true });
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

test("finds replays nested in per-run subdirectories", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-tools-nested-"));
    try {
        const run = join(dir, "20260906-run-a");
        mkdirSync(run);
        // A replay document one level down, plus a sidecar manifest beside it.
        writeFileSync(
            join(run, "match_1.json"),
            JSON.stringify({
                format: "screeps-arena-replay",
                version: 1,
                meta: { shortId: "abc", players: [], result: null, ticks: 3, ticksLimit: 2000, createdAt: null },
                terrain: "",
                objects: [],
                ticks: [],
            }),
        );
        writeFileSync(join(run, "manifest.json"), JSON.stringify({ runs: 1 }));

        const found = listReplays(dir);
        assert.equal(found.length, 1, "the manifest must not be listed as a replay");
        assert.equal(found[0].file, "20260906-run-a/match_1.json");
        assert.equal(found[0].meta?.shortId, "abc");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("/fame serves SSR HTML with pre-rendered cards and injected __INITIAL_FAME_DATA__", async () => {
    const { serve, setCachedFameDataForTest } = await import("../src/serve.js");
    const http = await import("node:http");

    const mockFameData = {
        ok: true,
        arenas: [
            {
                arenaName: "Pain and Gain (Basic)",
                advanced: false,
                unlocked: true,
                canPlay: true,
                isFinished: false,
                gamesPlayed: 3,
                wins: 2,
                losses: 1,
                draws: 0,
                famePoints: 120,
                rewardsLevel: 1,
                rewardsTaken: false,
                rewards: [{ name: "Coins", quantity: 50 }],
                games: [
                    { won: true, draw: false, opponent: "TestBot", ticks: 120, shortId: "abc", _id: "1" },
                ],
            },
            {
                arenaName: "Escort Run (Advanced)",
                advanced: true,
                unlocked: true,
                canPlay: false,
                isFinished: true,
                gamesPlayed: 10,
                wins: 7,
                losses: 3,
                draws: 0,
                famePoints: 450,
                rewardsLevel: 3,
                rewardsTaken: true,
                rewards: [],
                games: [],
            },
        ],
        nextResetUtc: new Date(Date.now() + 3600 * 1000 * 5).toISOString(),
        nextResetMs: 3600 * 1000 * 5,
        updatedAt: Date.now(),
    };

    setCachedFameDataForTest(mockFameData);

    const opts = resolveServeOptions(ROOT, { port: 5791, disableFamePolling: true });
    const srv = serve(opts);

    const get = (path: string) =>
        new Promise<{ status: number; body: string }>((res) => {
            http.get(`http://localhost:5791${path}`, (r) => {
                let data = "";
                r.on("data", (chunk) => {
                    data += chunk;
                });
                r.on("end", () => {
                    res({ status: r.statusCode ?? 0, body: data });
                });
            });
        });

    try {
        // 1. Verify /fame SSR HTML
        const fameRes = await get("/fame");
        assert.equal(fameRes.status, 200);
        const html = fameRes.body;

        // Active tab & visibility
        assert.ok(html.includes('id="tab-btn-fame" class="tab-btn active"'), "Fame tab should be active");
        assert.ok(html.includes('id="tab-btn-replays" class="tab-btn"'), "Replays tab should not be active");
        assert.ok(html.includes('id="view-replays" class="app-layout" hidden'), "Replays view should be hidden");
        assert.ok(html.includes('id="view-fame" class="fame-dashboard"'), "Fame view should be fame-dashboard");
        assert.ok(!html.includes('id="view-fame" class="fame-dashboard" hidden'), "Fame view should not be hidden");

        // SSR Pre-rendered content
        assert.ok(html.includes("Pain and Gain (Basic)"), "Should render arena card in SSR");
        assert.ok(html.includes("Escort Run (Advanced)"), "Should render advanced arena card in SSR");
        assert.ok(html.includes('id="fame-total-points">570</div>'), "Total points should be pre-calculated");
        assert.ok(html.includes('id="fame-unlocked-count">2 / 2</div>'), "Unlocked count should be pre-calculated");
        assert.ok(html.includes('window.__INITIAL_FAME_DATA__ = {"ok":true'), "Script tag should inject initial data");

        // 2. Verify /api/fame/status returns cached data
        const apiRes = await get("/api/fame/status");
        assert.equal(apiRes.status, 200);
        const apiJson = JSON.parse(apiRes.body);
        assert.equal(apiJson.ok, true);
        assert.equal(apiJson.arenas.length, 2);
        assert.equal(apiJson.arenas[0].arenaName, "Pain and Gain (Basic)");
    } finally {
        setCachedFameDataForTest(null);
        srv.close();
    }
});
