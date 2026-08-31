/**
 * Terrain encoding and decoding utilities.
 *
 * The replay API provides terrain as a digit string in row-major order (e.g. 10,000 chars for 100x100).
 * We encode it into run-length `p` (plain), `w` (wall), `s` (swamp) segments.
 */

/** API digit code to terrain character matching Screeps TERRAIN_* masks. */
export const TERRAIN_CHARS = ["p", "w", "s"];

/** Terrain character to renderer palette index (0=plain, 1=wall, 2=swamp). */
export const TERRAIN_INDEX = { p: 0, w: 1, s: 2 };

/**
 * Encode a digit string (`"0102..."`) to run-length representation (`"p3w1s2..."`).
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
 * Decode run-length string into a 1-cell-per-element `Uint8Array`.
 *
 * Always returns an array of exact length `width * height`, clamping or padding with plain.
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
