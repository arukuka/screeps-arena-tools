/**
 * ビューアの配信。
 *
 * `viewer/` の静的ファイル、`src/` の共有モジュール、そして手元のリプレイを返すだけの
 * 小さな HTTP サーバ。依存を増やさないため `node:http` だけで書く。
 *
 * ビューアが `src/` の JS をそのまま import できるので、変換処理を
 * Node 側とブラウザ側で二重に持たずに済む（ビルド工程も要らない）。
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

export const DEFAULT_PORT = 5544;

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
};

/**
 * `root` の外に出る要求を弾く。
 *
 * 手元で見るためのサーバとはいえ、`..` でホームディレクトリまで読めるものを
 * 立ち上げるのは筋が悪い。
 */
export function safeJoin(root, urlPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return null; // 壊れた %エスケープ
    }
    if (decoded.includes("\0")) return null;
    const target = normalize(join(root, decoded.replace(/^\/+/, "")));
    const base = normalize(root);
    if (target !== base && !target.startsWith(base + sep)) return null;
    return target;
}

function sendFile(res, path) {
    const gzipped = path.endsWith(".gz");
    const logical = gzipped ? path.slice(0, -3) : path;
    const headers = {
        "content-type": CONTENT_TYPES[extname(logical)] ?? "application/octet-stream",
        "cache-control": "no-cache",
    };
    // 圧縮したまま返し、伸長はブラウザに任せる
    if (gzipped) headers["content-encoding"] = "gzip";
    const body = readFileSync(path);
    headers["content-length"] = String(body.byteLength);
    res.writeHead(200, headers);
    res.end(body);
}

const sendJson = (res, status, value) => {
    const body = Buffer.from(JSON.stringify(value), "utf-8");
    res.writeHead(status, { "content-type": CONTENT_TYPES[".json"], "content-length": String(body.byteLength), "cache-control": "no-cache" });
    res.end(body);
};

const sendText = (res, status, text) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
};

/** リプレイ置き場を舐めて一覧を作る */
export function listReplays(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith(".json") || f.endsWith(".json.gz"))
        .map((file) => {
            const st = statSync(join(dir, file));
            return { file, bytes: st.size, modified: st.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function handleRequest(opts, req, res) {
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

    // 置き場ごとにルートを分ける。どれも読み出し専用
    const routes = [
        ["/replays/", opts.replayDir],
        ["/plugins/", opts.pluginDir],
        ["/src/", opts.srcDir],
    ];
    for (const [prefix, root] of routes) {
        if (!path.startsWith(prefix)) continue;
        if (root === null) break;
        const file = safeJoin(root, path.slice(prefix.length - 1));
        if (file === null || !existsSync(file) || !statSync(file).isFile()) {
            sendText(res, 404, "not found");
            return;
        }
        sendFile(res, file);
        return;
    }

    const asset = safeJoin(opts.viewerDir, path === "/" ? "/index.html" : path);
    if (asset === null || !existsSync(asset) || !statSync(asset).isFile()) {
        sendText(res, 404, "not found");
        return;
    }
    sendFile(res, asset);
}

function listPlugins(dir) {
    if (dir === null || !existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".js"));
}

export function serve(opts) {
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

/** CLI から渡された部分的な設定を、絶対パスに解決した完全な設定にする */
export function resolveServeOptions(rootDir, options = {}) {
    return {
        port: options.port ?? DEFAULT_PORT,
        viewerDir: resolve(rootDir, "viewer"),
        srcDir: resolve(rootDir, "src"),
        replayDir: resolve(process.cwd(), options.replayDir ?? "replays"),
        pluginDir: options.pluginDir === null ? null : resolve(process.cwd(), options.pluginDir ?? "plugins"),
    };
}
