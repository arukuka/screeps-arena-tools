#!/usr/bin/env node
/**
 * `arena-tools` command line interface entry point.
 *
 *   arena-tools fetch   <url|shortId> [-o <file>]
 *   arena-tools convert <raw.json>    [-o <file>]
 *   arena-tools view    [--port N] [--replays <dir>] [--plugins <dir>]
 *   arena-tools info    <replay.json.gz>
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { matchUrl, parseMatchRef } from "./arena_url.js";
import { fetchMatch } from "./fetch_match.js";
import { normalizeMatch } from "./normalize.js";
import { describeReplay, isReplayDoc, readReplay, writeReplay } from "./replay_io.js";
import { DEFAULT_PORT, listReplays, resolveServeOptions, serve } from "./serve.js";
import type { ReplayDoc } from "./types.js";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = CURRENT_DIR.endsWith("dist/src") || CURRENT_DIR.endsWith("dist\\src")
    ? resolve(CURRENT_DIR, "../..")
    : resolve(CURRENT_DIR, "..");

const USAGE = `
Screeps: Arena Tools

  arena-tools fetch <url|shortId> [-o <file>]
      Fetch match via running Screeps: Arena, normalize and save.
      URLs can be passed directly:
        arena-tools fetch https://arena.screeps.com/game/XTTCQ7DA4T
        arena-tools fetch XTTCQ7DA4T

  arena-tools convert <raw.json> [-o <file>] [--short-id <id>]
      Normalize raw JSON data already saved locally.

  arena-tools view [--port <n>] [--replays <dir>] [--plugins <dir>]
      Start the replay viewer (default http://localhost:${DEFAULT_PORT}/).

  arena-tools info <replay.json.gz>
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
    console.log(`\n  To view: arena-tools view`);
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
    if (found.length === 0) console.log("  No replays found. Fetch one using: arena-tools fetch <url>");
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

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    const { positional, flags } = parseArgs(rest);

    switch (command) {
        case "fetch":
            await cmdFetch(positional, flags);
            break;
        case "convert":
            cmdConvert(positional, flags);
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
