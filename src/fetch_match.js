/**
 * 試合リプレイの取得。
 *
 * チャンクを 1 つ取っては差分に畳み、生フレームを捨てる。
 * 全部集めてから変換すると、その瞬間だけ生データを丸ごと抱えることになり、
 * 2000 Tick の試合では 280MB を超える（`src/normalize.js` の説明を参照）。
 */

import { connect, enableInspector, findArenaPid, openMatchInApp, waitForInspector } from "./cdp.js";
import { createNormalizer } from "./normalize.js";
import { matchUrl } from "./arena_url.js";

const API = "https://arena.screeps.com/api";

/** 1 チャンクあたりの Tick 数。クライアント本体がこの粒度で取りに行っている */
const CHUNK_SIZE = 100;

/**
 * レンダラー側で 1 回の `fetch` を行う式を組む。
 *
 * 失敗をそのまま例外にすると 1 チャンクのために全体が落ちる。
 * ステータスを値として返し、呼び出し側で扱えるようにする。
 */
const fetchExpr = (url) => `
    (async () => {
        const res = await fetch(${JSON.stringify(url)});
        if (!res.ok) return { __error: true, status: res.status, statusText: res.statusText };
        return await res.json();
    })()
`;

/**
 * 試合を取得して正規化リプレイを返す。
 *
 * @param {string} shortId 短縮 ID（`parseMatchRef` で正規化済みのもの）
 * @param {{ onProgress?: (info: { phase: string, done?: number, total?: number, message?: string }) => void }} [options]
 */
export async function fetchMatch(shortId, options = {}) {
    const report = options.onProgress ?? (() => {});

    if (process.platform !== "darwin") {
        throw new Error(
            `このフェッチャは macOS 向け（検出: ${process.platform}）。\n` +
                "  `ps` / `open` / SIGUSR1 に依存している。他 OS では手動で\n" +
                "  インスペクタを開いて `--ws <url>` を渡すこと。",
        );
    }

    const pid = findArenaPid();
    if (pid === null) {
        throw new Error(
            "Screeps: Arena が起動していない。\n" +
                "  Steam から起動し、ログイン済みの状態にしてから再実行すること。",
        );
    }
    report({ phase: "found-app", message: `PID ${pid}` });

    enableInspector(pid);
    // 対象の試合を開かせておく。レンダラーが確実に認証済みの画面を持つ
    openMatchInApp(shortId);

    const wsUrl = await waitForInspector();
    report({ phase: "connected", message: wsUrl });

    const session = await connect(wsUrl);
    try {
        // 1. 短縮 ID を本物の ObjectId に解決する。
        //    リプレイ API は DB の主キーしか受け付けず、短縮 ID を渡すと 502 になる。
        const gameData = await session.evaluateInRenderer(fetchExpr(`${API}/game/${shortId}`));
        if (!gameData || gameData.__error) {
            throw new Error(
                `試合情報を取得できない (${gameData?.status ?? "?"} ${gameData?.statusText ?? ""}).\n` +
                    `  ${matchUrl(shortId)} が自分のアカウントで見られるか確認すること`,
            );
        }
        const gameId = gameData.game?._id;
        const totalTicks = gameData.game?.meta?.ticks;
        if (typeof gameId !== "string" || typeof totalTicks !== "number") {
            throw new Error("応答に game._id / meta.ticks が無い（API 仕様が変わった可能性）");
        }
        report({ phase: "resolved", message: `${gameId} / ${totalTicks} ticks` });

        const normalizer = createNormalizer({
            gameData,
            shortId,
            gameId,
            fetchedAt: new Date().toISOString(),
        });

        // 2. チャンク境界。0 は初期状態だけ、以降は 100 Tick ずつ。
        //    最後の端数を取りこぼさないよう totalTicks を明示的に足す。
        const targets = [0];
        for (let t = CHUNK_SIZE; t < totalTicks; t += CHUNK_SIZE) targets.push(t);
        if (totalTicks > 0 && targets[targets.length - 1] !== totalTicks) targets.push(totalTicks);

        for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            const frames = await session.evaluateInRenderer(fetchExpr(`${API}/game/${gameId}/replay/${t}`));
            if (Array.isArray(frames)) normalizer.pushFrames(frames);

            const logs = await session.evaluateInRenderer(fetchExpr(`${API}/game/${gameId}/log/${t}`));
            if (logs && !logs.__error) normalizer.pushLogs(logs);

            report({ phase: "chunk", done: i + 1, total: targets.length, message: `tick ${t}` });
        }

        return normalizer.finish();
    } finally {
        session.close();
    }
}
