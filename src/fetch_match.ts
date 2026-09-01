/**
 * Match replay fetcher.
 *
 * Chunks are fetched incrementally and immediately normalized into deltas,
 * discarding raw frames to prevent buffering hundreds of MBs in memory.
 */

import { connect, enableInspector, findArenaPid, openMatchInApp, waitForInspector } from "./cdp.js";
import { createNormalizer } from "./normalize.js";
import { matchUrl } from "./arena_url.js";
import type { FetchMatchOptions, ReplayDoc } from "./types.js";

const API = "https://arena.screeps.com/api";

/** Number of ticks per chunk (matching official game client granularity). */
const CHUNK_SIZE = 100;

/**
 * Expression evaluated in the renderer process to perform an authenticated fetch.
 */
const fetchExpr = (url: string): string => `
    (async () => {
        const res = await fetch(${JSON.stringify(url)});
        if (!res.ok) return { __error: true, status: res.status, statusText: res.statusText };
        return await res.json();
    })()
`;

/**
 * Fetch a match and return a normalized replay document.
 *
 * @param shortId Normalized short ID
 * @param options
 */
export async function fetchMatch(shortId: string, options: FetchMatchOptions = {}): Promise<ReplayDoc> {
    const report = options.onProgress ?? (() => {});

    if (process.platform !== "darwin") {
        throw new Error(
            `This fetcher is designed for macOS (detected: ${process.platform}).\n` +
                "  Relies on `ps` / `open` / SIGUSR1. On other OSes, open the\n" +
                "  inspector manually and pass `--ws <url>`.",
        );
    }

    const pid = findArenaPid();
    if (pid === null) {
        throw new Error(
            "Screeps: Arena is not running.\n" +
                "  Start from Steam, log in, and retry.",
        );
    }
    report({ phase: "found-app", message: `PID ${pid}` });

    enableInspector(pid);
    // Open the target match to ensure the renderer has loaded authenticated context
    openMatchInApp(shortId);

    const wsUrl = await waitForInspector();
    report({ phase: "connected", message: wsUrl });

    const session = await connect(wsUrl);
    try {
        // 1. Resolve short ID to real MongoDB ObjectId.
        //    The replay API requires the ObjectId and returns 502 for short IDs.
        const gameData: any = await session.evaluateInRenderer(fetchExpr(`${API}/game/${shortId}`));
        if (!gameData || gameData.__error) {
            throw new Error(
                `Cannot fetch match info (${gameData?.status ?? "?"} ${gameData?.statusText ?? ""}).\n` +
                    `  Verify ${matchUrl(shortId)} is accessible from your account.`,
            );
        }
        const gameId = gameData.game?._id;
        const totalTicks = gameData.game?.meta?.ticks;
        if (typeof gameId !== "string" || typeof totalTicks !== "number") {
            throw new Error("Missing game._id or meta.ticks in API response (API format may have changed)");
        }
        report({ phase: "resolved", message: `${gameId} / ${totalTicks} ticks` });

        const normalizer = createNormalizer({
            gameData,
            shortId,
            gameId,
            fetchedAt: new Date().toISOString(),
        });

        // 2. Chunk boundaries: tick 0 is initial state, followed by 100-tick chunks.
        const targets: number[] = [0];
        for (let t = CHUNK_SIZE; t < totalTicks; t += CHUNK_SIZE) targets.push(t);
        if (totalTicks > 0 && targets[targets.length - 1] !== totalTicks) targets.push(totalTicks);

        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            const frames: any = await session.evaluateInRenderer(fetchExpr(`${API}/game/${gameId}/replay/${t}`));
            if (Array.isArray(frames)) normalizer.pushFrames(frames);

            const logs: any = await session.evaluateInRenderer(fetchExpr(`${API}/game/${gameId}/log/${t}`));
            if (logs && !logs.__error) normalizer.pushLogs(logs);

            report({ phase: "chunk", done: i + 1, total: targets.length, message: `tick ${t}` });
        }

        return normalizer.finish();
    } finally {
        session.close();
    }
}
