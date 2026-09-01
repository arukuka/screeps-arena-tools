/**
 * Reading and writing of normalized replay documents (fs and zlib encapsulated here).
 *
 * Default format is gzip-compressed JSON (`*.replay.json.gz`).
 * The static HTTP server serves them with `Content-Encoding: gzip`, allowing
 * browsers to decompress transparently.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

import { REPLAY_FORMAT } from "./normalize.js";
import type { PlayerInfo, ReplayDoc } from "./types.js";

/** Read either a plain `*.json` or compressed `*.json.gz` replay file. */
export function readReplay(path: string): any {
    const raw = readFileSync(path);
    const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf-8") : raw.toString("utf-8");
    return JSON.parse(text);
}

/**
 * Write a replay document. Compresses with gzip if the file ends with `.gz`.
 * @returns Bytes written
 */
export function writeReplay(path: string, doc: unknown): number {
    const json = JSON.stringify(doc);
    const body = path.endsWith(".gz") ? gzipSync(Buffer.from(json, "utf-8"), { level: 9 }) : Buffer.from(json, "utf-8");
    writeFileSync(path, body);
    return body.byteLength;
}

/** Check whether an object is a normalized replay document. */
export function isReplayDoc(value: unknown): value is ReplayDoc {
    return Boolean(value) && typeof value === "object" && (value as any).format === REPLAY_FORMAT;
}

/** Format a single-line summary of a match document for CLI output. */
export function describeReplay(doc: ReplayDoc): string {
    const formatPlayer = (p: PlayerInfo): string => {
        const name = p.username ?? p.slot;
        return p.codeVersion !== null && p.codeVersion !== undefined ? `${name} (v${p.codeVersion})` : name;
    };
    const names = doc.meta.players.map(formatPlayer).join(" vs ");
    let result = "result: unknown";
    if (doc.meta.result.draw) {
        result = "draw";
    } else if (doc.meta.result.winner !== null && doc.meta.result.winner !== undefined) {
        const winner = doc.meta.players[doc.meta.result.winner];
        const winnerName = doc.meta.result.winnerName ?? winner?.username ?? `side ${doc.meta.result.winner}`;
        const ver = winner?.codeVersion !== null && winner?.codeVersion !== undefined ? ` (v${winner.codeVersion})` : "";
        result = `winner: ${winnerName}${ver}`;
    } else if (doc.meta.result.winnerName) {
        result = `winner: ${doc.meta.result.winnerName}`;
    }
    return `${names} — ${doc.meta.ticks} ticks, ${result}`;
}
