/**
 * 試合の指定を「短縮 ID」に正規化する。
 *
 * Screeps: Arena の試合はブラウザ上では
 * `https://arena.screeps.com/game/XTTCQ7DA4T` の形で共有される。
 * 利用者がその URL をそのまま貼り付けても、短縮 ID だけを打っても、
 * 同じように動いてほしいのでここで吸収する。
 */

/** 短縮 ID の字形。英数大文字の並び（実例は 10 文字だが長さは決め打ちしない） */
const SHORT_ID_RE = /^[A-Z0-9]{6,32}$/;

/** MongoDB ObjectId。`/api/game/{id}/replay/...` が要求する本物の ID */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/;

/**
 * 入力から短縮 ID（または ObjectId）を取り出す。
 *
 * 受け付ける形:
 *   - `XTTCQ7DA4T`
 *   - `https://arena.screeps.com/game/XTTCQ7DA4T`
 *   - `http://arena.screeps.com/game/XTTCQ7DA4T?utm=...#frag`
 *   - `screeps-arena:/game/XTTCQ7DA4T`（アプリのカスタムスキーム）
 *   - `arena.screeps.com/game/XTTCQ7DA4T`（スキーム省略）
 *   - `6a91f24fe5664ad5be8d41a3`（本物の ObjectId）
 *
 * @param {string} input
 * @returns {string} 短縮 ID もしくは ObjectId
 * @throws {Error} 解釈できなかったとき
 */
export function parseMatchRef(input) {
    if (typeof input !== "string") throw new Error("match reference must be a string");
    const text = input.trim().replace(/^["']|["']$/g, "");
    if (text === "") throw new Error("match reference is empty");

    // 素の ID。URL でないならこれで終わり
    if (OBJECT_ID_RE.test(text)) return text;
    if (SHORT_ID_RE.test(text)) return text;

    const candidate = extractFromUrl(text);
    if (candidate !== null) return candidate;

    throw new Error(
        `試合を特定できない: ${JSON.stringify(input)}\n` +
            "  短縮 ID (例: XTTCQ7DA4T) か URL (例: https://arena.screeps.com/game/XTTCQ7DA4T) を渡すこと",
    );
}

/**
 * URL らしき文字列から `/game/<id>` を拾う。
 *
 * `new URL()` に頼りきると `arena.screeps.com/game/X` のようなスキーム無しを
 * 落としてしまうので、パス部分の正規表現も併用する。
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractFromUrl(text) {
    // `screeps-arena:/game/ID` は URL としては相対パス扱いになるので先に潰す
    const path = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/{0,3}/, "/");
    const m = /\/game\/([A-Za-z0-9]+)/.exec(path);
    if (m === null) return null;

    const id = m[1];
    if (OBJECT_ID_RE.test(id)) return id;
    // URL 経由なら大文字小文字の揺れは直してやる
    const upper = id.toUpperCase();
    if (SHORT_ID_RE.test(upper)) return upper;
    return null;
}

/** 短縮 ID から共有 URL を組み立てる（ログ表示用） */
export function matchUrl(shortId) {
    return `https://arena.screeps.com/game/${shortId}`;
}

export const _internal = { SHORT_ID_RE, OBJECT_ID_RE };
