/**
 * コンソールログに載せたメタ情報の取り出し。
 *
 * ------------------------------------------------------------------
 * なぜログに載せるのか
 * ------------------------------------------------------------------
 * このキットは「誰の試合でも同じように見られる」ことを最優先にしている。
 * 一方で、自分のボットだけが知っている内部状態（役割分担・評価値・作戦モードなど）を
 * 一緒に眺めたい、という要求は当然ある。
 *
 * そこを fork で解決すると、本体が更新されるたびに追従が要る。
 * 代わりに **Screeps: Arena が誰にでも返すコンソールログ（`/api/game/{id}/log/{chunk}`）を
 * メタ情報の運搬路として使う**。ボット側は `console.log` するだけでよく、
 * リプレイ形式にもフェッチャにも手を入れない。
 *
 * ボット側:
 *
 * ```js
 * console.log(`@zones ${JSON.stringify({ 0: [3, 2, 1], 1: [1, 1, 4] })}`);
 * ```
 *
 * ビューア側: `viewer/plugin.js` のプラグインが `tick.e.zones` を読んで描く。
 * 表示スクリプトは外から差し込む（`?plugin=<url>`）。本体の fork は要らない。
 *
 * ------------------------------------------------------------------
 * 書式
 * ------------------------------------------------------------------
 * 行頭が `@` で始まり、続く名前空間と空白で区切られた 1 行がメタ情報。
 *
 *     `@<namespace> <payload>`
 *
 * - `<namespace>`: `[A-Za-z0-9_.:-]+`。プラグインが自分の取り分を見つける鍵
 * - `<payload>`: JSON として読めれば構造として、読めなければ文字列として保持
 *
 * 同じ Tick に同じ名前空間が複数回出てもよい。**値はつねに配列**で持つ
 * （1 回だけのときも要素 1 の配列）。読む側で場合分けが要らないほうが事故が少ない。
 */

/** メタ情報行の形。行頭の `@` と名前空間を取る */
const META_LINE_RE = /^@([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/;

/**
 * 1 Tick 分のコンソールログを「人が読む本文」と「メタ情報」に分ける。
 *
 * メタ情報行は本文から取り除く。毎 Tick メタ情報を吐くボットだと、
 * 残したままではログ欄が埋まって本来のデバッグ出力が読めなくなるため。
 *
 * @param {string} text 1 Tick 分のコンソール出力（改行区切り）
 * @returns {{ log: string, ext: Record<string, unknown[]> | null }}
 */
export function splitLogLine(text) {
    if (typeof text !== "string" || text === "") return { log: "", ext: null };
    // メタ情報を使わないログでは走査だけ無駄になるので、`@` が無ければ即返す
    if (!text.includes("@")) return { log: text, ext: null };

    const plain = [];
    /** @type {Record<string, unknown[]>} */
    const ext = {};
    let found = false;

    for (const line of text.split("\n")) {
        const m = META_LINE_RE.exec(line.trim());
        if (m === null) {
            plain.push(line);
            continue;
        }
        found = true;
        const ns = m[1];
        (ext[ns] ??= []).push(parsePayload(m[2]));
    }

    return { log: plain.join("\n"), ext: found ? ext : null };
}

/**
 * ペイロードを JSON として読む。読めなければ文字列のまま返す。
 *
 * `@mode swarm` のような素朴な書き方も通したいので、失敗を例外にしない。
 *
 * @param {string | undefined} raw
 * @returns {unknown}
 */
function parsePayload(raw) {
    if (raw === undefined) return true; // `@flagCaptured` のような値なしの印
    const text = raw.trim();
    if (text === "") return true;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Tick ごとのメタ情報から「どの名前空間が、どの範囲に出たか」の索引を作る。
 *
 * ビューアが「このログにはこのプラグインが使える」と判断するのに使う。
 *
 * @param {ReadonlyArray<{ k: number, e?: Record<string, unknown[]> }>} ticks
 * @returns {Record<string, { count: number, firstTick: number, lastTick: number }>}
 */
export function indexExtensions(ticks) {
    /** @type {Record<string, { count: number, firstTick: number, lastTick: number }>} */
    const index = {};
    for (const tick of ticks) {
        if (!tick.e) continue;
        for (const [ns, values] of Object.entries(tick.e)) {
            const entry = (index[ns] ??= { count: 0, firstTick: tick.k, lastTick: tick.k });
            entry.count += values.length;
            entry.lastTick = tick.k;
        }
    }
    return index;
}
