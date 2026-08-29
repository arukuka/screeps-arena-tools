/**
 * 地形の符号化。
 *
 * リプレイ API は地形を 1 セル 1 文字の数字列で返す（row-major, 100x100 なら 10000 文字）。
 * そのまま持つと嵩むうえ意味が読めないので、`p`/`w`/`s` の**ランレングス**に畳む。
 * ビューアもこのモジュールを読むので、符号化の定義はここ一箇所に閉じる。
 */

/** API の数字コード → 地形文字。Screeps の TERRAIN_* マスクと同じ並び */
export const TERRAIN_CHARS = ["p", "w", "s"];

/** 地形文字 → 描画側が使う添字（0=plain / 1=wall / 2=swamp） */
export const TERRAIN_INDEX = { p: 0, w: 1, s: 2 };

/**
 * 数字列（`"0102..."`）をランレングス文字列（`"p3w1s2..."`）にする。
 *
 * @param {string} digits
 * @returns {string}
 */
export function encodeTerrain(digits) {
    let out = "";
    let run = 0;
    let cur = "";
    for (let i = 0; i < digits.length; i++) {
        const ch = TERRAIN_CHARS[Number(digits[i])] ?? "p";
        if (ch === cur) {
            run++;
            continue;
        }
        if (run > 0) out += cur + run;
        cur = ch;
        run = 1;
    }
    if (run > 0) out += cur + run;
    return out;
}

/**
 * ランレングス文字列を 1 セル 1 要素の `Uint8Array` に戻す。
 *
 * `width * height` に満たない/超える入力でも、その長さちょうどの配列を返す。
 * 壊れたログで描画ごと落ちるより、欠けたぶんを plain として見せたほうが調べやすい。
 *
 * @param {string} rle
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function decodeTerrain(rle, width, height) {
    const cells = new Uint8Array(width * height);
    let pos = 0;
    const re = /([pws])(\d+)/g;
    let m;
    while ((m = re.exec(rle)) !== null) {
        const value = TERRAIN_INDEX[m[1]];
        const count = Number(m[2]);
        const end = Math.min(pos + count, cells.length);
        cells.fill(value, pos, end);
        pos = end;
        if (pos >= cells.length) break;
    }
    return cells;
}
