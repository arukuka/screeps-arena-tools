/**
 * Screeps: Arena API helper via CDP session.
 *
 * Executes authenticated requests in the running Electron renderer context.
 */

import type { CdpSession } from "./cdp.js";
import type { ArenaSummary, RatingHistoryItem } from "./types.js";

const API = "https://arena.screeps.com/api";

const fetchExpr = (url: string): string => `
    (async () => {
        const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        if (!res.ok) return { __error: true, status: res.status, statusText: res.statusText };
        return await res.json();
    })()
`;

export interface UserAuthInfo {
    _id: string;
    username: string;
    steam?: {
        steamid: string;
        personaname: string;
    };
}

/**
 * Get authenticated user information.
 */
export async function getCurrentUser(session: CdpSession): Promise<UserAuthInfo | null> {
    const data = await session.evaluateInRenderer(fetchExpr(`${API}/auth/me`));
    if (!data || data.__error || !data.ok) return null;
    return {
        _id: data._id,
        username: data.username,
        steam: data.steam,
    };
}

/**
 * List all arenas in the current season.
 */
export async function getSeasonArenas(session: CdpSession): Promise<ArenaSummary[]> {
    const seasonData = await session.evaluateInRenderer(fetchExpr(`${API}/season/current`));
    if (!seasonData || seasonData.__error || !seasonData.season?._id) {
        throw new Error("Cannot fetch current season information from Screeps: Arena API");
    }
    const seasonId = seasonData.season._id;
    const arenasData = await session.evaluateInRenderer(fetchExpr(`${API}/season/${seasonId}/arenas`));
    if (!arenasData || arenasData.__error || !Array.isArray(arenasData.arenas)) {
        throw new Error(`Cannot fetch arenas for season ${seasonId}`);
    }
    return arenasData.arenas.map((a: any) => ({
        _id: a._id,
        name: a.name,
        advanced: Boolean(a.advanced),
        folderName: a.folderName,
        active: Boolean(a.active),
        rating: a.rating,
        games: a.games ?? 0,
        rank: a.rank,
    }));
}

/**
 * Resolve an arena by query string, ID, or pick the currently active one.
 */
export async function resolveArena(session: CdpSession, query?: string): Promise<ArenaSummary> {
    const arenas = await getSeasonArenas(session);
    if (arenas.length === 0) {
        throw new Error("No arenas found for the current season.");
    }

    if (!query) {
        // Find first arena with games played, or active
        const played = arenas.filter((a) => (a.games ?? 0) > 0);
        if (played.length === 1) return played[0];
        if (played.length > 1) {
            // Pick the one with the highest number of games
            played.sort((a, b) => (b.games ?? 0) - (a.games ?? 0));
            return played[0];
        }
        return arenas[0];
    }

    const q = query.trim().toLowerCase();

    // 1. Direct ID match
    const byId = arenas.find((a) => a._id.toLowerCase() === q);
    if (byId) return byId;

    // 2. Folder name match (e.g. season4-pain_and_gain)
    const byFolder = arenas.find((a) => a.folderName?.toLowerCase() === q);
    if (byFolder) return byFolder;

    // 3. Name match with basic/advanced distinction
    const wantsAdvanced = q.includes("advanced") || q.includes("adv");
    const matchedByName = arenas.filter((a) => {
        const n = a.name.toLowerCase();
        return n.includes(q.replace(/advanced|adv|basic/g, "").trim());
    });

    if (matchedByName.length > 0) {
        if (wantsAdvanced) {
            const adv = matchedByName.find((a) => a.advanced);
            if (adv) return adv;
        } else {
            const basic = matchedByName.find((a) => !a.advanced);
            if (basic) return basic;
        }
        return matchedByName[0];
    }

    throw new Error(
        `Arena "${query}" not found. Available arenas in current season:\n` +
            arenas.map((a) => `  - ${a.name} (${a.advanced ? "Advanced" : "Basic"}) [id: ${a._id}]`).join("\n"),
    );
}

/**
 * Fetch rating history for a specific arena.
 */
export async function fetchRatingHistory(
    session: CdpSession,
    arenaId: string,
    options: { limit?: number; offset?: number } = {},
): Promise<{ items: RatingHistoryItem[]; total: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const url = `${API}/arena/${arenaId}/rating-history?limit=${limit}&offset=${offset}`;

    const data = await session.evaluateInRenderer(fetchExpr(url));
    if (!data || data.__error || !data.ok || !Array.isArray(data.history)) {
        throw new Error(`Failed to fetch rating history for arena ${arenaId}: ${data?.statusText ?? "unknown error"}`);
    }

    const total = data.meta?.length ?? data.history.length;
    const items: RatingHistoryItem[] = data.history.map((h: any) => {
        const g = h.game ?? {};
        const isDraw = g.result?.winner === -1 || g.result?.draw === true;
        return {
            _id: h._id,
            gameId: g._id ?? h._id,
            shortId: g.shortId ?? null,
            createdAt: g.createdAt ?? h.createdAt,
            ticks: g.meta?.ticks ?? g.ticks ?? 0,
            winner: isDraw ? -1 : (g.result?.winner ?? null),
            draw: isDraw,
            users: Array.isArray(h.users) ? h.users.map((u: any) => ({ _id: u._id, username: u.username })) : [],
            codes: Array.isArray(h.codes) ? h.codes.map((c: any) => ({ _id: c._id, user: c.user, version: c.version })) : [],
            ratingChange: h.ratingHistory
                ? {
                      previousRating: h.ratingHistory.previousRating,
                      rating: h.ratingHistory.rating,
                      previousRank: h.ratingHistory.previousRank ?? null,
                      rank: h.ratingHistory.rank ?? null,
                  }
                : undefined,
            hasReplay: Boolean(g.hasReplay ?? true),
        };
    });

    return { items, total };
}
