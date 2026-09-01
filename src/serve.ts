/**
 * Static file and replay server for the browser viewer.
 *
 * Lightweight HTTP server serving `viewer/` assets, `src/` modules, and replay files.
 * Uses `node:http` with zero external dependencies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { readReplay } from "./replay_io.js";
import type { ReplayListItem, ServeOptions } from "./types.js";

export const DEFAULT_PORT = 5544;

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
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

/** Scan replay directory and construct file metadata list. */
export function listReplays(dir: string): ReplayListItem[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".json") || f.endsWith(".json.gz"))
        .map((file) => {
            const fullPath = join(dir, file);
            const st = statSync(fullPath);
            let meta = null;
            try {
                const doc = readReplay(fullPath);
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
            return { file, bytes: st.size, modified: st.mtime.toISOString(), meta };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function handleRequest(opts: ServeOptions, req: IncomingMessage, res: ServerResponse): void {
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
    const server = createServer((req, res) => {
        try {
            handleRequest(opts, req, res);
        } catch (err) {
            sendText(res, 500, err instanceof Error ? err.message : String(err));
        }
    });
    server.listen(opts.port);
    return server;
}

/** Resolve partial serve options to absolute paths and defaults. */
export function resolveServeOptions(rootDir: string, options: Partial<ServeOptions> = {}): ServeOptions {
    return {
        port: options.port ?? DEFAULT_PORT,
        viewerDir: resolve(rootDir, "viewer"),
        distViewerDir: resolve(rootDir, "dist/viewer"),
        srcDir: resolve(rootDir, "src"),
        replayDir: resolve(process.cwd(), options.replayDir ?? "replays"),
        pluginDir: options.pluginDir === null ? null : resolve(process.cwd(), options.pluginDir ?? "plugins"),
    };
}
