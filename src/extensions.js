/**
 * Extraction of metadata embedded in console logs.
 *
 * ------------------------------------------------------------------
 * Why embed metadata in logs?
 * ------------------------------------------------------------------
 * This tool prioritizes universal viewing for any player's match.
 * However, developers often want to visualize internal bot state (roles, evaluations, modes).
 *
 * Instead of requiring forks, we use Screeps: Arena's standard console log API
 * (`/api/game/{id}/log/{chunk}`) as a metadata carrier.
 * Bots only need to use `console.log`; no changes are needed to replay formats or fetchers.
 *
 * Bot side:
 *
 * ```js
 * console.log(`@zones ${JSON.stringify({ 0: [3, 2, 1], 1: [1, 1, 4] })}`);
 * ```
 *
 * Viewer side: `viewer/plugin.js` plugins read `tick.e.zones` and render them.
 * Plugins can be loaded dynamically (`?plugin=<url>`) without forking the codebase.
 *
 * ------------------------------------------------------------------
 * Format
 * ------------------------------------------------------------------
 * A metadata line starts with `@` followed by a namespace and whitespace-delimited payload:
 *
 *     `@<namespace> <payload>`
 *
 * - `<namespace>`: `[A-Za-z0-9_.:-]+`. Key used by plugins to locate their data
 * - `<payload>`: Parsed as JSON if valid; stored as a raw string otherwise
 *
 * Multiple lines for the same namespace in a single tick are preserved as an array.
 * Values are always stored as arrays (even single occurrences) for consistent consumption.
 */

/** Metadata line regex pattern capturing leading `@` and namespace. */
const META_LINE_RE = /^@([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/;

/**
 * Split a single tick's console log into human-readable text and metadata.
 *
 * Metadata lines are removed from the plain log text so high-frequency
 * telemetry does not flood the human-readable log viewer.
 *
 * @param {string} text Console output for 1 tick (newline separated)
 * @returns {{ log: string, ext: Record<string, unknown[]> | null }}
 */
export function splitLogLine(text) {
    if (typeof text !== "string" || text === "") return { log: "", ext: null };
    // Fast return if no metadata indicator exists
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
 * Parse payload as JSON if possible; otherwise return as raw string.
 *
 * @param {string | undefined} raw
 * @returns {unknown}
 */
function parsePayload(raw) {
    if (raw === undefined) return true; // Flag marker without payload (e.g. `@flagCaptured`)
    const text = raw.trim();
    if (text === "") return true;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Index metadata across all ticks to summarize active namespaces and tick ranges.
 *
 * Used by the viewer to determine which plugins can activate for a match.
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
