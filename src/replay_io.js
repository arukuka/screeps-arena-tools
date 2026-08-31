/**
 * 正規化リプレイの読み書き。fs と zlib はここに閉じる。
 *
 * 既定は gzip 圧縮した JSON（`*.replay.json.gz`）。差分にした時点で十分小さいが、
 * 座標や HP の並びは繰り返しが多く gzip がさらによく効く（実測で 1/16）。
 * ビューアの静的サーバは `Content-Encoding: gzip` を付けてそのまま返すので、
 * ブラウザ側は圧縮を意識しなくてよい。
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

import { REPLAY_FORMAT } from "./normalize.js";

/** `*.json.gz` でも素の `*.json` でも読む */
export function readReplay(path) {
    const raw = readFileSync(path);
    const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf-8") : raw.toString("utf-8");
    return JSON.parse(text);
}

/**
 * 書き出す。拡張子が `.gz` なら圧縮する。
 * @returns {number} 書いたバイト数
 */
export function writeReplay(path, doc) {
    const json = JSON.stringify(doc);
    const body = path.endsWith(".gz") ? gzipSync(Buffer.from(json, "utf-8"), { level: 9 }) : Buffer.from(json, "utf-8");
    writeFileSync(path, body);
    return body.byteLength;
}

/** 正規化済みか、生の取得結果か。ビューアと変換コマンドで分岐に使う */
export function isReplayDoc(value) {
    return Boolean(value) && typeof value === "object" && value.format === REPLAY_FORMAT;
}

/** 試合の要約を 1 行に。CLI の出力用 */
export function describeReplay(doc) {
    const formatPlayer = (p) => {
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
