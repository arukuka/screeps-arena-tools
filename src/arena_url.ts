/**
 * Normalize match references into short IDs.
 *
 * Screeps: Arena matches are shared in the browser as:
 * `https://arena.screeps.com/game/XTTCQ7DA4T`.
 * Users can provide full URLs, short IDs, or custom scheme links.
 */

/** Short ID pattern (uppercase alphanumeric string). */
const SHORT_ID_RE = /^[A-Z0-9]{6,32}$/;

/** MongoDB ObjectId required by `/api/game/{id}/replay/...`. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/;

/**
 * Extract a short ID (or ObjectId) from user input.
 *
 * Accepted formats:
 *   - `XTTCQ7DA4T`
 *   - `https://arena.screeps.com/game/XTTCQ7DA4T`
 *   - `http://arena.screeps.com/game/XTTCQ7DA4T?utm=...#frag`
 *   - `screeps-arena:/game/XTTCQ7DA4T` (app custom scheme)
 *   - `arena.screeps.com/game/XTTCQ7DA4T` (omitted scheme)
 *   - `6a91f24fe5664ad5be8d41a3` (MongoDB ObjectId)
 *
 * @param input
 * @returns Short ID or ObjectId
 * @throws {Error} If input cannot be parsed
 */
export function parseMatchRef(input: string): string {
    if (typeof input !== "string") throw new Error("match reference must be a string");
    const text = input.trim().replace(/^["']|["']$/g, "");
    if (text === "") throw new Error("match reference is empty");

    // Plain ID check
    if (OBJECT_ID_RE.test(text)) return text;
    if (SHORT_ID_RE.test(text)) return text;

    const candidate = extractFromUrl(text);
    if (candidate !== null) return candidate;

    throw new Error(
        `Cannot resolve match reference: ${JSON.stringify(input)}\n` +
            "  Provide a short ID (e.g. XTTCQ7DA4T) or URL (e.g. https://arena.screeps.com/game/XTTCQ7DA4T)",
    );
}

/**
 * Extract `/game/<id>` from a URL-like string.
 *
 * @param text
 * @returns Short ID or ObjectId, or null
 */
function extractFromUrl(text: string): string | null {
    // Strip custom scheme so relative parsing works cleanly
    const path = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/{0,3}/, "/");
    const m = /\/game\/([A-Za-z0-9]+)/.exec(path);
    if (m === null) return null;

    const id = m[1];
    if (OBJECT_ID_RE.test(id)) return id;
    const upper = id.toUpperCase();
    if (SHORT_ID_RE.test(upper)) return upper;
    return null;
}

/** Construct a shareable URL from a short ID for logging and UI. */
export function matchUrl(shortId: string): string {
    return `https://arena.screeps.com/game/${shortId}`;
}

export const _internal = { SHORT_ID_RE, OBJECT_ID_RE };
