/**
 * Static file and replay server for the browser viewer.
 *
 * Lightweight HTTP server serving `viewer/` assets, `src/` modules, and replay files.
 * Uses `node:http` with zero external dependencies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { generateReplayGif } from "./gif.js";
import { normalizeMatch } from "./normalize.js";
import { isReplayDoc, readReplay } from "./replay_io.js";
import { openArenaSession } from "./sync.js";
import { getAllArenasFameStatus, getNextUtcReset } from "./fame.js";
import type { ReplayDoc, ReplayListItem, ServeOptions } from "./types.js";

export const DEFAULT_PORT = 5544;

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
};

/**
 * Prevent path traversal outside the designated root directory.
 */
export function safeJoin(root: string, urlPath: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return null; // Malformed %-escape sequence
    }
    if (decoded.includes("\0")) return null;
    const target = normalize(join(root, decoded.replace(/^\/+/, "")));
    const base = normalize(root);
    if (target !== base && !target.startsWith(base + sep)) return null;
    return target;
}

function sendFile(res: ServerResponse, path: string): void {
    const gzipped = path.endsWith(".gz");
    const logical = gzipped ? path.slice(0, -3) : path;
    const headers: Record<string, string> = {
        "content-type": CONTENT_TYPES[extname(logical)] ?? "application/octet-stream",
        "cache-control": "no-cache",
    };
    if (gzipped) headers["content-encoding"] = "gzip";
    const body = readFileSync(path);
    headers["content-length"] = String(body.byteLength);
    res.writeHead(200, headers);
    res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
    const body = Buffer.from(JSON.stringify(value), "utf-8");
    res.writeHead(status, {
        "content-type": CONTENT_TYPES[".json"] ?? "application/json",
        "content-length": String(body.byteLength),
        "cache-control": "no-cache",
    });
    res.end(body);
};

const sendText = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
};

/** Maximum directory depth walked when scanning for replays. */
const REPLAY_SCAN_DEPTH = 3;

/**
 * Collect replay file paths relative to `dir`, descending into subdirectories.
 *
 * Producers other than `fetch` may group runs into folders (a simulator writing
 * one directory per self-play run, for example), so a flat scan would find
 * nothing. Paths are returned POSIX-style because they travel to the browser
 * and back through `safeJoin`.
 */
function collectReplayFiles(dir: string, depth = 0, prefix = ""): string[] {
    if (depth > REPLAY_SCAN_DEPTH) return [];
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
            found.push(...collectReplayFiles(join(dir, entry.name), depth + 1, rel));
        } else if (entry.name.endsWith(".json") || entry.name.endsWith(".json.gz")) {
            found.push(rel);
        }
    }
    return found;
}

/** Scan replay directory and construct file metadata list. */
export function listReplays(dir: string): ReplayListItem[] {
    if (!existsSync(dir)) return [];
    return collectReplayFiles(dir)
        .map((file) => {
            const fullPath = join(dir, file);
            const st = statSync(fullPath);
            let meta = null;
            // Parsed cleanly but carries no replay metadata: a sidecar file,
            // not a broken replay. Those are dropped below. A file that fails
            // to parse stays listed with `meta: null` so the failure is visible.
            let sidecar = false;
            try {
                const doc = readReplay(fullPath);
                if (!doc?.meta) sidecar = true;
                if (doc?.meta) {
                    meta = {
                        shortId: doc.meta.shortId ?? null,
                        players: doc.meta.players ?? [],
                        result: doc.meta.result ?? null,
                        ticks: doc.meta.ticks ?? null,
                        ticksLimit: doc.meta.ticksLimit ?? null,
                        createdAt: doc.meta.createdAt ?? null,
                    };
                }
            } catch {
                // Fallback to meta: null if unreadable or invalid format
            }
            return { file, bytes: st.size, modified: st.mtime.toISOString(), meta, sidecar };
        })
        // Directories may hold sidecar JSON (a run manifest, for instance).
        // Those are not replays and would only be noise in the list.
        .filter((item) => !item.sidecar)
        .map(({ sidecar: _sidecar, ...item }) => item)
        .sort((a, b) => b.modified.localeCompare(a.modified));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > 50 * 1024 * 1024) {
                reject(new Error("Payload too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

async function handleGifRequest(
    opts: ServeOptions,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
): Promise<void> {
    let fileParam: string | null = null;
    let doc: ReplayDoc | null = null;
    let start: number | undefined;
    let end: number | undefined;
    let step: number | undefined;
    let fps: number | undefined;
    let cell: number | undefined;

    if (req.method === "POST") {
        const rawBody = await readBody(req);
        let payload: any = {};
        if (rawBody.trim().length > 0) {
            try {
                payload = JSON.parse(rawBody);
            } catch {
                sendText(res, 400, "Invalid JSON body");
                return;
            }
        }
        fileParam = typeof payload.file === "string" ? payload.file : null;
        if (payload.doc) {
            doc = isReplayDoc(payload.doc) ? payload.doc : normalizeMatch(payload.doc);
        }
        if (payload.start !== undefined && payload.start !== null) start = Number(payload.start);
        if (payload.end !== undefined && payload.end !== null) end = Number(payload.end);
        if (payload.step !== undefined && payload.step !== null) step = Number(payload.step);
        if (payload.fps !== undefined && payload.fps !== null) fps = Number(payload.fps);
        if (payload.cell !== undefined && payload.cell !== null) cell = Number(payload.cell);
    } else {
        fileParam = url.searchParams.get("file");
        const startVal = url.searchParams.get("start");
        const endVal = url.searchParams.get("end");
        const stepVal = url.searchParams.get("step");
        const fpsVal = url.searchParams.get("fps");
        const cellVal = url.searchParams.get("cell");
        if (startVal !== null) start = Number(startVal);
        if (endVal !== null) end = Number(endVal);
        if (stepVal !== null) step = Number(stepVal);
        if (fpsVal !== null) fps = Number(fpsVal);
        if (cellVal !== null) cell = Number(cellVal);
    }

    if (doc === null && fileParam !== null) {
        const fullPath = safeJoin(opts.replayDir, fileParam);
        if (fullPath === null || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
            sendText(res, 404, `Replay file not found: ${fileParam}`);
            return;
        }
        const raw = readReplay(fullPath);
        doc = isReplayDoc(raw) ? raw : normalizeMatch(raw);
    }

    if (doc === null) {
        sendText(res, 400, "Provide either 'file' query/body parameter or 'doc' replay data");
        return;
    }

    const gifBuffer = generateReplayGif(doc, {
        startTick: start,
        endTick: end,
        step,
        fps,
        cell,
    });

    const baseName = doc.meta.shortId ?? doc.meta.gameId ?? "match";
    const filename = `${baseName}.gif`;

    res.writeHead(200, {
        "content-type": "image/gif",
        "content-length": String(gifBuffer.byteLength),
        "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "cache-control": "no-cache",
    });
    res.end(gifBuffer);
}

export async function handleRequest(opts: ServeOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/api/replays") {
        sendJson(res, 200, { dir: opts.replayDir, replays: listReplays(opts.replayDir) });
        return;
    }

    if (path === "/api/plugins") {
        sendJson(res, 200, { plugins: listPlugins(opts.pluginDir) });
        return;
    }

    if (path === "/api/gif") {
        await handleGifRequest(opts, req, res, url);
        return;
    }

    if (path === "/api/fame/status") {
        try {
            const session = await openArenaSession();
            try {
                const arenas = await getAllArenasFameStatus(session);
                const { nextResetUtc, nextResetMs } = getNextUtcReset();
                sendJson(res, 200, { ok: true, arenas, nextResetUtc, nextResetMs });
            } finally {
                session.close();
            }
        } catch (err: any) {
            sendJson(res, 200, { ok: false, error: err.message });
        }
        return;
    }

    // Redirect / to /replays
    if (path === "/") {
        res.writeHead(302, { Location: "/replays" });
        res.end();
        return;
    }

    // SPA Page Routes: /replays, /fame, /replays/:id (without file extensions)
    const isSpaPage =
        path === "/replays" ||
        path === "/fame" ||
        (path.startsWith("/replays/") &&
            !path.endsWith(".json") &&
            !path.endsWith(".gz") &&
            !path.endsWith(".js") &&
            !path.endsWith(".css"));

    if (isSpaPage) {
        const indexHtml = safeJoin(opts.viewerDir, "index.html");
        if (indexHtml !== null && existsSync(indexHtml)) {
            sendFile(res, indexHtml);
            return;
        }
    }

    const routes: Array<[string, string | null]> = [
        ["/replays/", opts.replayDir],
        ["/plugins/", opts.pluginDir],
        ["/src/", opts.srcDir],
    ];
    for (const [prefix, root] of routes) {
        if (!path.startsWith(prefix)) continue;
        if (root === null) break;
        const relative = path.slice(prefix.length - 1);
        let file = safeJoin(root, relative);
        if (file === null || !existsSync(file) || !statSync(file).isFile()) {
            // Fallback to compiled dist/ directory if serving from src/
            const distFallback = safeJoin(resolve(root, "../dist/src"), relative);
            if (distFallback !== null && existsSync(distFallback) && statSync(distFallback).isFile()) {
                file = distFallback;
            } else {
                sendText(res, 404, "not found");
                return;
            }
        }
        sendFile(res, file);
        return;
    }

    const relativeAsset = path === "/" ? "/index.html" : path;
    let asset = safeJoin(opts.viewerDir, relativeAsset);
    if (asset === null || !existsSync(asset) || !statSync(asset).isFile()) {
        // Fallback to compiled dist/viewer for .js files
        const distFallback = safeJoin(opts.distViewerDir ?? resolve(opts.viewerDir, "../dist/viewer"), relativeAsset);
        if (distFallback !== null && existsSync(distFallback) && statSync(distFallback).isFile()) {
            asset = distFallback;
        } else {
            sendText(res, 404, "not found");
            return;
        }
    }
    sendFile(res, asset);
}

function listPlugins(dir: string | null): string[] {
    if (dir === null || !existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".js"));
}

export function serve(opts: ServeOptions): Server {
    const server = createServer(async (req, res) => {
        try {
            await handleRequest(opts, req, res);
        } catch (err) {
            sendText(res, 500, err instanceof Error ? err.message : String(err));
        }
    });
    if (opts.host) {
        server.listen(opts.port, opts.host);
    } else {
        server.listen(opts.port);
    }
    return server;
}

/** Enumerate non-internal IPv4 addresses for local network access display. */
export function getNetworkAddresses(): string[] {
    const nets = networkInterfaces();
    const results: string[] = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
            if (net.family === "IPv4" && !net.internal && !net.address.startsWith("169.254.")) {
                results.push(net.address);
            }
        }
    }
    return results;
}

/** Resolve partial serve options to absolute paths and defaults. */
export function resolveServeOptions(rootDir: string, options: Partial<ServeOptions> = {}): ServeOptions {
    return {
        port: options.port ?? DEFAULT_PORT,
        host: options.host,
        viewerDir: resolve(rootDir, "viewer"),
        distViewerDir: resolve(rootDir, "dist/viewer"),
        srcDir: resolve(rootDir, "src"),
        replayDir: resolve(process.cwd(), options.replayDir ?? "replays"),
        pluginDir: options.pluginDir === null ? null : resolve(process.cwd(), options.pluginDir ?? "plugins"),
    };
}
