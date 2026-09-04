/**
 * Arena replay synchronization and watch service.
 *
 * Automatically discovers, downloads, and delta-compresses match replays
 * directly from the running Screeps: Arena client via CDP.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { connect, enableInspector, findArenaPid, waitForInspector, type CdpSession } from "./cdp.js";
import { getCurrentUser, resolveArena, fetchRatingHistory } from "./arena_api.js";
import { fetchGameWithSession } from "./fetch_match.js";
import { readReplay, writeReplay } from "./replay_io.js";
import type { ArenaSummary, RatingHistoryItem, SyncOptions, WatchOptions } from "./types.js";

const DEFAULT_REPLAY_DIR = "replays";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Open CDP connection to the running Screeps: Arena instance.
 */
export async function openArenaSession(): Promise<CdpSession> {
    if (process.platform !== "darwin") {
        throw new Error(
            `Automated replay sync is currently supported on macOS (detected: ${process.platform}).\n` +
                "  Relies on `ps` and SIGUSR1 debugger activation.",
        );
    }

    const pid = findArenaPid();
    if (pid === null) {
        throw new Error(
            "Screeps: Arena is not running.\n" +
                "  Start from Steam, log in, and retry.",
        );
    }

    enableInspector(pid);
    const wsUrl = await waitForInspector();
    return await connect(wsUrl);
}

/**
 * Scan replay directory and collect existing game IDs and short IDs.
 */
export function getExistingMatchIds(replayDir: string): Set<string> {
    const existing = new Set<string>();
    if (!existsSync(replayDir)) return existing;

    const files = readdirSync(replayDir).filter((f) => f.endsWith(".json") || f.endsWith(".json.gz"));
    for (const f of files) {
        // Strip suffixes (.replay.json.gz, .replay.json, .json.gz, .json)
        const base = f.replace(/\.replay\.json(\.gz)?$/, "").replace(/\.json(\.gz)?$/, "");
        if (base) existing.add(base);

        // Also peek into the file to get real MongoDB gameId and shortId if possible
        try {
            const doc = readReplay(join(replayDir, f));
            if (doc?.meta?.gameId) existing.add(doc.meta.gameId);
            if (doc?.meta?.shortId) existing.add(doc.meta.shortId);
        } catch {
            // Ignore unreadable or corrupted files
        }
    }
    return existing;
}

export interface SyncResult {
    arena: ArenaSummary;
    totalHistory: number;
    fetched: number;
    skipped: number;
    items: RatingHistoryItem[];
}

/**
 * Sync replays for an arena (fetches all missing matches).
 */
export async function syncReplays(options: SyncOptions = {}): Promise<SyncResult> {
    const replayDir = resolve(process.cwd(), options.replayDir ?? DEFAULT_REPLAY_DIR);
    mkdirSync(replayDir, { recursive: true });

    const session = await openArenaSession();
    try {
        const arena = await resolveArena(session, options.arena);
        const { items: history, total } = await fetchRatingHistory(session, arena._id, {
            limit: options.limit ?? 50,
        });

        const existingIds = getExistingMatchIds(replayDir);
        let fetchedCount = 0;
        let skippedCount = 0;

        // Process from oldest to newest so files arrive in chronological order
        const toProcess = [...history].reverse();

        for (let i = 0; i < toProcess.length; i++) {
            const item = toProcess[i];
            const gameId = item.gameId;
            const shortId = item.shortId;

            const isAlreadySaved = existingIds.has(gameId) || (shortId && existingIds.has(shortId));
            if (isAlreadySaved) {
                skippedCount++;
                options.onMatchSynced?.(item, "", false);
                continue;
            }

            const doc = await fetchGameWithSession(session, gameId, {
                onProgress: options.onProgress,
            });

            const fileName = `${shortId ?? gameId}.replay.json.gz`;
            const outPath = join(replayDir, fileName);
            writeReplay(outPath, doc);

            existingIds.add(gameId);
            if (shortId) existingIds.add(shortId);
            fetchedCount++;

            options.onMatchSynced?.(item, outPath, true);
        }

        return {
            arena,
            totalHistory: total,
            fetched: fetchedCount,
            skipped: skippedCount,
            items: history,
        };
    } finally {
        session.close();
    }
}

/**
 * Watch for new finished matches in the arena and fetch them automatically.
 */
export async function watchReplays(options: WatchOptions = {}): Promise<void> {
    const replayDir = resolve(process.cwd(), options.replayDir ?? DEFAULT_REPLAY_DIR);
    mkdirSync(replayDir, { recursive: true });
    const intervalMs = options.intervalMs ?? 15000;

    const session = await openArenaSession();
    try {
        const arena = await resolveArena(session, options.arena);
        const existingIds = getExistingMatchIds(replayDir);

        options.onProgress?.({
            phase: "watch-start",
            message: `Watching "${arena.name} (${arena.advanced ? "Advanced" : "Basic"})" every ${(intervalMs / 1000).toFixed(0)}s...`,
        });

        while (!options.signal?.aborted) {
            try {
                const { items: history } = await fetchRatingHistory(session, arena._id, { limit: 10 });
                const newItems = history.filter(
                    (h) => !existingIds.has(h.gameId) && (!h.shortId || !existingIds.has(h.shortId)),
                );

                if (newItems.length > 0) {
                    // Newest matches first in history, reverse to fetch oldest of the new batch first
                    for (const item of [...newItems].reverse()) {
                        const gameId = item.gameId;
                        const shortId = item.shortId;

                        const doc = await fetchGameWithSession(session, gameId, {
                            onProgress: options.onProgress,
                        });

                        const fileName = `${shortId ?? gameId}.replay.json.gz`;
                        const outPath = join(replayDir, fileName);
                        writeReplay(outPath, doc);

                        existingIds.add(gameId);
                        if (shortId) existingIds.add(shortId);

                        options.onMatchSynced?.(item, outPath, true);
                    }
                }
            } catch (err: any) {
                options.onProgress?.({
                    phase: "watch-error",
                    message: err.message ?? String(err),
                });
            }

            await sleep(intervalMs);
        }
    } finally {
        session.close();
    }
}
