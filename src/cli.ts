#!/usr/bin/env node
/**
 * `screeps-arena-tools` command line interface entry point.
 *
 *   screeps-arena-tools fetch   <url|shortId> [-o <file>]
 *   screeps-arena-tools convert <raw.json>    [-o <file>]
 *   screeps-arena-tools view    [--port N] [--replays <dir>] [--plugins <dir>]
 *   screeps-arena-tools info    <replay.json.gz>
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { matchUrl, parseMatchRef } from "./arena_url.js";
import { fetchMatch } from "./fetch_match.js";
import { generateReplayGif } from "./gif.js";
import { normalizeMatch } from "./normalize.js";
import { describeReplay, isReplayDoc, readReplay, writeReplay } from "./replay_io.js";
import { DEFAULT_PORT, listReplays, resolveServeOptions, serve } from "./serve.js";
import { getExistingMatchIds, openArenaSession, syncReplays, watchReplays } from "./sync.js";
import { getCurrentUser, resolveArena, fetchRatingHistory } from "./arena_api.js";
import type { ReplayDoc } from "./types.js";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = CURRENT_DIR.endsWith("dist/src") || CURRENT_DIR.endsWith("dist\\src")
    ? resolve(CURRENT_DIR, "../..")
    : resolve(CURRENT_DIR, "..");

const USAGE = `
Screeps: Arena Tools

  screeps-arena-tools history [arena] [--limit <n>]
      List match history for an arena (default: currently active arena).

  screeps-arena-tools sync [arena] [--limit <n>] [--watch] [--interval <sec>]
      Automatically sync all missing replays from running Screeps: Arena.
      Add --watch to keep monitoring and downloading new matches in real-time.

  screeps-arena-tools fetch <url|shortId> [-o <file>]
      Fetch match via running Screeps: Arena, normalize and save.
      URLs can be passed directly:
        screeps-arena-tools fetch https://arena.screeps.com/game/XTTCQ7DA4T
        screeps-arena-tools fetch XTTCQ7DA4T

  screeps-arena-tools convert <raw.json> [-o <file>] [--short-id <id>]
      Normalize raw JSON data already saved locally.

  screeps-arena-tools gif <replay|shortId> [-o <file>] [--start N] [--end N] [--step N] [--fps N] [--cell N]
      Export animated GIF of a match replay.

  screeps-arena-tools view [--port <n>] [--replays <dir>] [--plugins <dir>]
      Start the replay viewer (default http://localhost:${DEFAULT_PORT}/).

  screeps-arena-tools info <replay.json.gz>
      Display summary of a normalized replay file.
`.trim();


interface ParsedArgs {
    positional: string[];
    flags: Record<string, string | boolean>;
}

/** Simple argument parser extracting positional values and flags (-o, --out, etc.). */
function parseArgs(argv: string[]): ParsedArgs {
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("-")) {
            positional.push(arg);
            continue;
        }
        const eq = arg.indexOf("=");
        if (eq > 0) {
            flags[arg.slice(0, eq).replace(/^-+/, "")] = arg.slice(eq + 1);
            continue;
        }
        const name = arg.replace(/^-+/, "");
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
            flags[name] = next;
            i++;
        } else {
            flags[name] = true;
        }
    }
    return { positional, flags };
}

const outOf = (flags: Record<string, string | boolean>): string | null => {
    const val = flags.o ?? flags.out;
    return typeof val === "string" ? val : null;
};

async function cmdFetch(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
    if (positional.length === 0) throw new Error("Pass a match URL or short ID");
    const shortId = parseMatchRef(positional[0]);

    console.log(`=== Screeps: Arena Tools ===`);
    console.log(`Match: ${matchUrl(shortId)}`);

    const doc = await fetchMatch(shortId, {
        onProgress: (info) => {
            if (info.phase === "chunk") {
                const line = `  fetching ${info.done}/${info.total} (${info.message ?? ""})`;
                if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
                else if (info.done === info.total) console.log(line);
            } else {
                console.log(`  ${info.phase}: ${info.message ?? ""}`);
            }
        },
    });
    if (process.stdout.isTTY) process.stdout.write("\n");

    const out = resolve(process.cwd(), outOf(flags) ?? `replays/${shortId}.replay.json.gz`);
    mkdirSync(dirname(out), { recursive: true });
    const bytes = writeReplay(out, doc);

    console.log(`\nSaved: ${out} (${(bytes / 1024).toFixed(1)} KB)`);
    console.log(`  ${describeReplay(doc)}`);
    reportExtensions(doc);
    console.log(`\n  To view: screeps-arena-tools view`);
}

function cmdConvert(positional: string[], flags: Record<string, string | boolean>): void {
    if (positional.length === 0) throw new Error("Pass a raw JSON file to convert");
    const input = resolve(process.cwd(), positional[0]);
    const raw = readReplay(input);

    if (isReplayDoc(raw)) {
        console.log("Already normalized. No conversion needed.");
        console.log(`  ${describeReplay(raw)}`);
        return;
    }

    const shortId = flags["short-id"] ? parseMatchRef(String(flags["short-id"])) : null;
    const doc = normalizeMatch(raw, { shortId });
    const name = doc.meta.shortId ?? doc.meta.gameId ?? "match";
    const out = resolve(process.cwd(), outOf(flags) ?? `replays/${name}.replay.json.gz`);
    mkdirSync(dirname(out), { recursive: true });
    const bytes = writeReplay(out, doc);

    console.log(`Saved: ${out} (${(bytes / 1024).toFixed(1)} KB)`);
    console.log(`  ${describeReplay(doc)}`);
    reportExtensions(doc);
}

function resolveReplayPath(ref: string): string {
    const candidates = [
        resolve(process.cwd(), ref),
        resolve(process.cwd(), `replays/${ref}`),
        resolve(process.cwd(), `replays/${ref}.replay.json.gz`),
        resolve(process.cwd(), `replays/${ref}.replay.json`),
        resolve(process.cwd(), `${ref}.replay.json.gz`),
        resolve(process.cwd(), `${ref}.replay.json`),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    throw new Error(`Replay not found: "${ref}" (checked in replays/ directory)`);
}

async function cmdGif(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
    if (positional.length === 0) throw new Error("Pass a replay file or match short ID");
    const inputPath = resolveReplayPath(positional[0]);
    const raw = readReplay(inputPath);
    const doc: ReplayDoc = isReplayDoc(raw) ? raw : normalizeMatch(raw);

    const name = doc.meta.shortId ?? doc.meta.gameId ?? "match";
    const out = resolve(process.cwd(), outOf(flags) ?? `replays/${name}.gif`);
    mkdirSync(dirname(out), { recursive: true });

    const startTick = flags.start !== undefined ? Number(flags.start) : undefined;
    const endTick = flags.end !== undefined ? Number(flags.end) : undefined;
    const step = flags.step !== undefined ? Math.max(1, Number(flags.step)) : 1;
    const fps = flags.fps !== undefined ? Math.max(1, Number(flags.fps)) : 10;
    const cell = flags.cell !== undefined ? Math.max(2, Number(flags.cell)) : 4;
    const showActions = flags["no-actions"] ? false : true;
    const showStructures = flags["no-structures"] ? false : true;

    console.log(`=== Screeps: Arena GIF Export ===`);
    console.log(`Match:  ${describeReplay(doc)}`);
    console.log(`Range:  tick ${startTick ?? 0}..${endTick ?? doc.meta.ticks} (step ${step}) @ ${fps} fps [cell=${cell}px]`);
    console.log(`Target: ${out}`);

    const buffer = generateReplayGif(doc, {
        startTick,
        endTick,
        step,
        fps,
        cell,
        showActions,
        showStructures,
        onProgress: (done, total) => {
            const pct = Math.round((done / total) * 100);
            const line = `  rendering frames: ${done}/${total} (${pct}%)`;
            if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
            else if (done === total) console.log(line);
        },
    });

    if (process.stdout.isTTY) process.stdout.write("\n");
    writeFileSync(out, buffer);

    console.log(`\nSaved: ${out} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

function cmdView(flags: Record<string, string | boolean>): void {
    const opts = resolveServeOptions(ROOT, {
        port: flags.port !== undefined ? Number(flags.port) : undefined,
        replayDir: typeof flags.replays === "string" ? flags.replays : undefined,
        pluginDir: typeof flags.plugins === "string" ? flags.plugins : undefined,
    });
    serve(opts);
    const found = listReplays(opts.replayDir);
    console.log("==================================================");
    console.log(`Viewer: http://localhost:${opts.port}/`);
    console.log(`  Replays: ${opts.replayDir} (${found.length} items)`);
    console.log(`  Plugins: ${opts.pluginDir ?? "(none)"}`);
    if (found.length === 0) console.log("  No replays found. Fetch one using: screeps-arena-tools fetch <url>");
    console.log("  Press Ctrl+C to stop");
    console.log("==================================================");
}

function cmdInfo(positional: string[]): void {
    if (positional.length === 0) throw new Error("Pass a replay file");
    const doc = readReplay(resolve(process.cwd(), positional[0]));
    if (!isReplayDoc(doc)) throw new Error("Not a normalized replay (run `convert` first)");
    console.log(describeReplay(doc));
    console.log(`  URL        : ${doc.meta.url ?? "-"}`);
    console.log(`  game id    : ${doc.meta.gameId ?? "-"}`);
    console.log(`  Created    : ${doc.meta.createdAt ?? "-"}`);
    console.log(`  Board      : ${doc.meta.width}x${doc.meta.height}`);
    console.log(`  Objects    : ${doc.objects.length}`);
    console.log(`  Ticks      : ${doc.ticks.length}`);
    console.log(`  Log ticks  : ${Object.keys(doc.logs).length}`);
    reportExtensions(doc);
}

/** Report metadata namespaces extracted from console logs. */
function reportExtensions(doc: ReplayDoc): void {
    const names = Object.keys(doc.extensions ?? {});
    if (names.length === 0) return;
    console.log("  Extensions:");
    for (const ns of names) {
        const e = doc.extensions[ns];
        if (e) {
            console.log(`    @${ns} — ${e.count} entries (ticks ${e.firstTick}..${e.lastTick})`);
        }
    }
}

async function cmdHistory(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
    const arenaQuery = positional[0];
    const limit = flags.limit ? Number(flags.limit) : 50;

    const session = await openArenaSession();
    try {
        const user = await getCurrentUser(session);
        const arena = await resolveArena(session, arenaQuery);
        const { items, total } = await fetchRatingHistory(session, arena._id, { limit });

        const replayDir = resolve(process.cwd(), typeof flags.replays === "string" ? flags.replays : "replays");
        const existingIds = getExistingMatchIds(replayDir);

        console.log("=== Screeps: Arena Match History ===");
        if (user) console.log(`User:  ${user.username} (${user._id})`);
        console.log(`Arena: ${arena.name} (${arena.advanced ? "Advanced" : "Basic"}) [${arena._id}]`);
        console.log(`Games: ${total} total match(es) | showing ${items.length}\n`);

        if (items.length === 0) {
            console.log("No matches found in history.");
            return;
        }

        const pad = (s: string | number, len: number, alignRight = false): string => {
            const str = String(s);
            if (str.length >= len) return str;
            const spaces = " ".repeat(len - str.length);
            return alignRight ? spaces + str : str + spaces;
        };

        console.log(
            `${pad("#", 4)} ${pad("Date (Local)", 16)} ${pad("Result", 7)} ${pad("Opponent", 22)} ${pad("Ticks", 6, true)} ${pad("Rating", 12)} ${pad("Replay", 8)} ID`,
        );
        console.log("-".repeat(95));

        const myId = user?._id;
        const myName = user?.username;

        items.forEach((item, idx) => {
            const num = total - idx;
            const dateStr = new Date(item.createdAt).toLocaleString(undefined, {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
            });

            let myIdx = item.users.findIndex((u) => (myId && u._id === myId) || (myName && u.username === myName));
            if (myIdx === -1) myIdx = 0;
            const oppIdx = myIdx === 0 ? 1 : 0;
            const oppUser = item.users[oppIdx]?.username ?? "System";
            const oppCode = item.codes.find((c) => (myId ? c.user !== myId : true))?.version;
            const oppStr = `${oppUser}${oppCode !== undefined ? ` (v${oppCode})` : ""}`;

            const resultStr = item.draw ? "Draw" : item.winner === myIdx ? "Win" : "Loss";
            const ratingStr = item.ratingChange
                ? `${item.ratingChange.previousRating} -> ${item.ratingChange.rating}`
                : "-";

            const isSaved = existingIds.has(item.gameId) || (item.shortId && existingIds.has(item.shortId));
            const statusStr = isSaved ? "Saved" : "Missing";

            console.log(
                `${pad(num, 4)} ${pad(dateStr, 16)} ${pad(resultStr, 7)} ${pad(oppStr, 22)} ${pad(item.ticks, 6, true)} ${pad(ratingStr, 12)} ${pad(statusStr, 8)} ${item.shortId ?? item.gameId}`,
            );
        });

        const missingCount = items.filter(
            (i) => !existingIds.has(i.gameId) && (!i.shortId || !existingIds.has(i.shortId)),
        ).length;

        if (missingCount > 0) {
            console.log(`\n  ${missingCount} match(es) not yet downloaded.`);
            console.log(`  To fetch all: screeps-arena-tools sync "${arena.name}"`);
        } else {
            console.log(`\n  All listed matches are downloaded and ready to view.`);
            console.log(`  To view: screeps-arena-tools view`);
        }
    } finally {
        session.close();
    }
}

async function cmdSync(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
    const arenaQuery = positional[0];
    const limit = flags.limit ? Number(flags.limit) : 50;
    const replayDir = typeof flags.replays === "string" ? flags.replays : "replays";
    const watch = Boolean(flags.watch);
    const intervalSec = flags.interval ? Number(flags.interval) : 15;

    console.log("=== Screeps: Arena Replay Sync ===");

    if (watch) {
        console.log(`Mode: Watch (polling every ${intervalSec}s)`);
        console.log(`Directory: ${resolve(process.cwd(), replayDir)}`);
        console.log("Press Ctrl+C to stop.\n");

        await watchReplays({
            arena: arenaQuery,
            replayDir,
            intervalMs: intervalSec * 1000,
            onProgress: (info) => {
                if (info.phase === "watch-start") {
                    console.log(`  ${info.message}`);
                } else if (info.phase === "watch-error") {
                    console.error(`  Warning: ${info.message}`);
                } else if (info.phase === "chunk") {
                    if (process.stdout.isTTY) {
                        process.stdout.write(`\r  fetching chunk ${info.done}/${info.total} (${info.message ?? ""})   `);
                    }
                }
            },
            onMatchSynced: (item, path, isNew) => {
                if (isNew) {
                    if (process.stdout.isTTY) process.stdout.write("\n");
                    const opp = item.users.map((u) => u.username).join(" vs ");
                    console.log(`[NEW] Match saved: ${item.shortId ?? item.gameId} (${opp}, ${item.ticks} ticks) -> ${path}`);
                }
            },
        });
        return;
    }

    console.log(`Directory: ${resolve(process.cwd(), replayDir)}`);

    let currentDownloading = "";
    const result = await syncReplays({
        arena: arenaQuery,
        limit,
        replayDir,
        onProgress: (info) => {
            if (info.phase === "chunk") {
                const line = `  [${currentDownloading}] chunk ${info.done}/${info.total} (${info.message ?? ""})`;
                if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
                else if (info.done === info.total) console.log(line);
            }
        },
        onMatchSynced: (item, path, isNew) => {
            if (isNew) {
                if (process.stdout.isTTY) process.stdout.write("\n");
                const opp = item.users.map((u) => u.username).join(" vs ");
                console.log(`  Saved: ${item.shortId ?? item.gameId} (${opp}, ${item.ticks} ticks)`);
            } else {
                currentDownloading = item.shortId ?? item.gameId;
            }
        },
    });

    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`\nSync finished for "${result.arena.name} (${result.arena.advanced ? "Advanced" : "Basic"})":`);
    console.log(`  Total matches in history : ${result.totalHistory}`);
    console.log(`  Newly downloaded         : ${result.fetched}`);
    console.log(`  Already downloaded       : ${result.skipped}`);
    console.log(`\n  To view replays: screeps-arena-tools view`);
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    const { positional, flags } = parseArgs(rest);

    switch (command) {
        case "history":
            await cmdHistory(positional, flags);
            break;
        case "sync":
            await cmdSync(positional, flags);
            break;
        case "fetch":
            await cmdFetch(positional, flags);
            break;
        case "convert":
            cmdConvert(positional, flags);
            break;
        case "gif":
            await cmdGif(positional, flags);
            break;
        case "view":
            cmdView(flags);
            break;
        case "info":
            cmdInfo(positional);
            break;
        case undefined:
        case "help":
        case "-h":
        case "--help":
            console.log(USAGE);
            break;
        default:
            console.error(`Unknown command: ${command}\n`);
            console.error(USAGE);
            process.exit(1);
    }
}


main().catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
});
