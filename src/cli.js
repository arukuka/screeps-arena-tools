#!/usr/bin/env node
/**
 * `arena-tools` のコマンド入口。
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `
Screeps: Arena Tools

  arena-tools fetch <url|shortId> [-o <file>]
      起動中の Screeps: Arena 経由で試合を取得し、正規化して保存する。
      URL をそのまま貼ってよい:
        arena-tools fetch https://arena.screeps.com/game/XTTCQ7DA4T
        arena-tools fetch XTTCQ7DA4T

  arena-tools convert <raw.json> [-o <file>] [--short-id <id>]
      すでに手元にある生の取得結果を正規化する。

  arena-tools view [--port <n>] [--replays <dir>] [--plugins <dir>]
      ビューアを立ち上げる（既定 http://localhost:${DEFAULT_PORT}/）。

  arena-tools info <replay.json.gz>
      保存済みリプレイの要約を表示する。
`.trim();

/** `-o x` / `--out x` / `--out=x` を素直に拾うだけの引数分解 */
function parseArgs(argv) {
    const positional = [];
    const flags = {};
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

const outOf = (flags) => flags.o ?? flags.out ?? null;

async function cmdFetch(positional, flags) {
    if (positional.length === 0) throw new Error("試合の URL か短縮 ID を渡すこと");
    const shortId = parseMatchRef(positional[0]);

    console.log(`=== Screeps: Arena Tools ===`);
    console.log(`試合: ${matchUrl(shortId)}`);

    const doc = await fetchMatch(shortId, {
        onProgress: (info) => {
            if (info.phase === "chunk") {
                // 同じ行を上書きして進捗を出す。端末でなければ落ち着いて 1 行ずつ
                const line = `  取得中 ${info.done}/${info.total} (${info.message})`;
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

    console.log(`\n保存: ${out} (${(bytes / 1024).toFixed(1)} KB)`);
    console.log(`  ${describeReplay(doc)}`);
    reportExtensions(doc);
    console.log(`\n  見るには: arena-tools view`);
}

function cmdConvert(positional, flags) {
    if (positional.length === 0) throw new Error("生の取得結果 JSON を渡すこと");
    const input = resolve(process.cwd(), positional[0]);
    const raw = readReplay(input);

    if (isReplayDoc(raw)) {
        console.log("すでに正規化済み。変換不要");
        console.log(`  ${describeReplay(raw)}`);
        return;
    }

    const shortId = flags["short-id"] ? parseMatchRef(String(flags["short-id"])) : null;
    const doc = normalizeMatch(raw, { shortId });
    const name = doc.meta.shortId ?? doc.meta.gameId ?? "match";
    const out = resolve(process.cwd(), outOf(flags) ?? `replays/${name}.replay.json.gz`);
    mkdirSync(dirname(out), { recursive: true });
    const bytes = writeReplay(out, doc);

    console.log(`保存: ${out} (${(bytes / 1024).toFixed(1)} KB)`);
    console.log(`  ${describeReplay(doc)}`);
    reportExtensions(doc);
}

function cmdView(flags) {
    const opts = resolveServeOptions(ROOT, {
        port: flags.port !== undefined ? Number(flags.port) : undefined,
        replayDir: typeof flags.replays === "string" ? flags.replays : undefined,
        pluginDir: typeof flags.plugins === "string" ? flags.plugins : undefined,
    });
    serve(opts);
    const found = listReplays(opts.replayDir);
    console.log("==================================================");
    console.log(`ビューア: http://localhost:${opts.port}/`);
    console.log(`  リプレイ: ${opts.replayDir} (${found.length} 件)`);
    console.log(`  プラグイン: ${opts.pluginDir ?? "(なし)"}`);
    if (found.length === 0) console.log("  まだ何も無い。`arena-tools fetch <url>` で取ってくること");
    console.log("  Ctrl+C で停止");
    console.log("==================================================");
}

function cmdInfo(positional) {
    if (positional.length === 0) throw new Error("リプレイファイルを渡すこと");
    const doc = readReplay(resolve(process.cwd(), positional[0]));
    if (!isReplayDoc(doc)) throw new Error("正規化リプレイではない（`convert` を先に通すこと）");
    console.log(describeReplay(doc));
    console.log(`  URL      : ${doc.meta.url ?? "-"}`);
    console.log(`  game id  : ${doc.meta.gameId ?? "-"}`);
    console.log(`  作成      : ${doc.meta.createdAt ?? "-"}`);
    console.log(`  盤面      : ${doc.meta.width}x${doc.meta.height}`);
    console.log(`  オブジェクト: ${doc.objects.length}`);
    console.log(`  Tick      : ${doc.ticks.length}`);
    console.log(`  ログ行     : ${Object.keys(doc.logs).length} tick`);
    reportExtensions(doc);
}

/** ログから拾ったメタ情報の名前空間を知らせる。プラグインを当てる手がかりになる */
function reportExtensions(doc) {
    const names = Object.keys(doc.extensions ?? {});
    if (names.length === 0) return;
    console.log("  メタ情報:");
    for (const ns of names) {
        const e = doc.extensions[ns];
        console.log(`    @${ns} — ${e.count} 件 (tick ${e.firstTick}..${e.lastTick})`);
    }
}

async function main() {
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
            console.error(`不明なコマンド: ${command}\n`);
            console.error(USAGE);
            process.exit(1);
    }
}

main().catch((err) => {
    console.error(`\nエラー: ${err.message}`);
    process.exit(1);
});
