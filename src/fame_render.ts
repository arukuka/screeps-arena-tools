/**
 * Pure HTML rendering functions for Fame dashboard and arena cards.
 *
 * Designed to be zero-dependency and executable in both Node.js (SSR)
 * and browser environments.
 */

export function escapeHtml(str: any): string {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function getArenaThemeClass(name: string): string {
    const n = name.toLowerCase();
    if (n.includes("pain and gain")) return "theme-pain-and-gain";
    if (n.includes("spawn and swamp")) return "theme-spawn-and-swamp";
    if (n.includes("escort run")) return "theme-escort-run";
    return "";
}

export function renderFameCardHtml(a: any): string {
    const isAdv = a.advanced;
    const isLocked = !a.unlocked;
    const isFinished = a.isFinished;
    const canPlay = a.canPlay;
    const themeClass = getArenaThemeClass(a.arenaName || "");

    const progressPercent = Math.min(100, Math.round(((a.gamesPlayed || 0) / 10) * 100));

    // Status badge
    let statusBadge = "";
    if (isLocked) {
        statusBadge = `<span class="badge badge-locked">Locked</span>`;
    } else if (isFinished) {
        statusBadge = `<span class="badge badge-finished">Finished Today</span>`;
    } else if (canPlay) {
        statusBadge = `<span class="badge badge-canplay">Ready</span>`;
    } else {
        statusBadge = `<span class="badge badge-finished">Max Matches (10/10)</span>`;
    }

    // Rewards chips
    let rewardsHtml = `<span class="hint">No rewards claimed yet</span>`;
    if (Array.isArray(a.rewards) && a.rewards.length > 0) {
        rewardsHtml =
            `<div class="rewards-list">` +
            a.rewards
                .map(
                    (r: any) => `
                <div class="reward-chip" title="${escapeHtml(r.description || r.name)}">
                    ${r.icon_url ? `<img src="${escapeHtml(r.icon_url)}" alt="${escapeHtml(r.name)}" />` : "🎁"}
                    <span>${escapeHtml(r.name)} x${r.quantity}</span>
                </div>
            `,
                )
                .join("") +
            `</div>`;
    }

    // Recent games list: display all matches today
    let recentGamesHtml = `<div class="hint">No matches played today</div>`;
    if (Array.isArray(a.games) && a.games.length > 0) {
        recentGamesHtml =
            `<div class="fame-recent-games">` +
            a.games
                .map((g: any, idx: number) => {
                    const outcomeClass = g.draw ? "draw" : g.won ? "win" : "loss";
                    const outcomeText = g.draw ? "DRAW" : g.won ? "WIN" : "LOSS";
                    const matchNum = a.games.length - idx;
                    const replayBtn = g.shortId
                        ? `<button class="btn-view-match" data-short-id="${escapeHtml(g.shortId)}" data-game-id="${escapeHtml(g._id)}">▶ Replay</button>`
                        : "";
                    return `
                    <div class="game-row">
                        <span class="game-match-num">#${matchNum}</span>
                        <span class="game-outcome ${outcomeClass}">${outcomeText}</span>
                        <span class="game-opponent" title="vs ${escapeHtml(g.opponent)}">vs ${escapeHtml(g.opponent)}</span>
                        <span class="game-ticks">${g.ticks}t</span>
                        ${replayBtn}
                    </div>
                `;
                })
                .join("") +
            `</div>`;
    }

    return `
        <div class="fame-card ${themeClass} ${isLocked ? "locked" : ""}">
            <div class="fame-card-head">
                <div>
                    <div class="fame-card-title">${escapeHtml(a.arenaName)}</div>
                    <div class="fame-card-badges">
                        <span class="badge ${isAdv ? "badge-adv" : "badge-basic"}">${isAdv ? "Advanced" : "Basic"}</span>
                        ${statusBadge}
                    </div>
                </div>
                <div class="fame-points-badge" style="text-align: right;">
                    <div style="font-size: 11px; color: var(--fg-dim);">Fame Points</div>
                    <div style="font-size: 18px; font-weight: 700; color: var(--accent);">${a.famePoints ?? 0}</div>
                </div>
            </div>

            ${
                !isLocked
                    ? `
                <div class="fame-progress-wrap">
                    <div class="fame-progress-meta">
                        <span>Progress: <strong>${a.gamesPlayed ?? 0} / 10</strong></span>
                        <span>${progressPercent}%</span>
                    </div>
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill" style="width: ${progressPercent}%"></div>
                    </div>
                </div>

                <div class="fame-stats-row">
                    <div class="stat-pill"><span class="k">Record</span><span class="v">${a.wins ?? 0}W - ${a.losses ?? 0}L - ${a.draws ?? 0}D</span></div>
                    <div class="stat-pill"><span class="k">Win Rate</span><span class="v">${a.gamesPlayed > 0 ? Math.round(((a.wins || 0) / a.gamesPlayed) * 100) : 0}%</span></div>
                    <div class="stat-pill"><span class="k">Chest Lvl</span><span class="v">Lvl ${a.rewardsLevel ?? 0} (${a.rewardsTaken ? "Claimed" : "Unclaimed"})</span></div>
                </div>

                <div class="fame-rewards-box">
                    <div class="rewards-header">
                        <span>Earned Rewards</span>
                    </div>
                    ${rewardsHtml}
                </div>

                <div class="fame-rewards-box">
                    <div class="rewards-header">
                        <span>Today's Matches (${Array.isArray(a.games) ? a.games.length : 0})</span>
                    </div>
                    ${recentGamesHtml}
                </div>
            `
                    : `
                <div class="hint" style="padding: 12px 0;">This arena is locked in Screeps: Arena. Unlock in game to enable Fame daily matches.</div>
            `
            }
        </div>
    `;
}

export const ARENA_ORDER = ["pain and gain", "spawn and swamp", "escort run"];

export function getArenaOrderIndex(name: string): number {
    const idx = ARENA_ORDER.findIndex((o) => name.toLowerCase().includes(o));
    return idx !== -1 ? idx : 99;
}

export function renderFameCardsHtml(arenas: any[] = []): string {
    const basicArenas = arenas
        .filter((a) => !a.advanced)
        .sort((a, b) => getArenaOrderIndex(a.arenaName || "") - getArenaOrderIndex(b.arenaName || ""));

    const advArenas = arenas
        .filter((a) => a.advanced)
        .sort((a, b) => getArenaOrderIndex(a.arenaName || "") - getArenaOrderIndex(b.arenaName || ""));

    return `
        <div class="fame-tier-section">
            <div class="fame-tier-title">
                <span class="tier-indicator basic"></span>
                <h3>Basic Arenas</h3>
            </div>
            <div class="fame-cards-row">
                ${basicArenas.map((a) => renderFameCardHtml(a)).join("")}
            </div>
        </div>

        <div class="fame-tier-section">
            <div class="fame-tier-title">
                <span class="tier-indicator adv"></span>
                <h3>Advanced Arenas</h3>
            </div>
            <div class="fame-cards-row">
                ${advArenas.map((a) => renderFameCardHtml(a)).join("")}
            </div>
        </div>
    `;
}

export function getFameSummaryStats(data: any): {
    unlockedCount: string;
    totalPoints: string;
    statusText: string;
    statusColor: string;
} {
    const arenas: any[] = data.arenas || [];
    const unlocked = arenas.filter((a) => a.unlocked);
    const totalPoints = arenas.reduce((sum, a) => sum + (a.famePoints || 0), 0);

    const anyCanPlay = unlocked.some((a) => a.canPlay);
    const anyInProg = unlocked.some((a) => a.gamesPlayed > 0 && !a.isFinished);

    let statusText = "Finished Today";
    let statusColor = "var(--accent)";

    if (anyInProg) {
        statusText = "In Progress";
        statusColor = "var(--ok)";
    } else if (anyCanPlay) {
        statusText = "Ready to Play";
        statusColor = "var(--ok)";
    }

    return {
        unlockedCount: `${unlocked.length} / ${arenas.length}`,
        totalPoints: String(totalPoints),
        statusText,
        statusColor,
    };
}

export function formatCountdown(nextResetUtc: string | Date | null | undefined): string {
    if (!nextResetUtc) return "--:--:--";
    const target = typeof nextResetUtc === "string" ? new Date(nextResetUtc).getTime() : nextResetUtc.getTime();
    const remainingMs = Math.max(0, target - Date.now());
    const totalSec = Math.floor(remainingMs / 1000);
    const h = Math.floor(totalSec / 3600).toString().padStart(2, "0");
    const m = Math.floor((totalSec % 3600) / 60).toString().padStart(2, "0");
    const s = (totalSec % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
}

/**
 * Transforms viewer index.html for server-side rendering (SSR) of the /fame route.
 * Injects initial fame data and pre-renders cards and status badges into HTML.
 */
export function renderFamePageHtml(baseHtml: string, fameData: any | null): string {
    let html = baseHtml;

    // 1. Switch active tabs
    html = html.replace('id="tab-btn-replays" class="tab-btn active"', 'id="tab-btn-replays" class="tab-btn"');
    html = html.replace('id="tab-btn-fame" class="tab-btn"', 'id="tab-btn-fame" class="tab-btn active"');

    // 2. Switch visible views
    if (!html.includes('id="view-replays" class="app-layout" hidden')) {
        html = html.replace('id="view-replays" class="app-layout"', 'id="view-replays" class="app-layout" hidden');
    }
    html = html.replace(/(<div id="view-fame"[^>]*?)\s+hidden\b/g, "$1");

    // 3. Inject pre-rendered dashboard if data is available
    if (fameData && fameData.ok && Array.isArray(fameData.arenas)) {
        const stats = getFameSummaryStats(fameData);
        const countdown = formatCountdown(fameData.nextResetUtc);

        html = html.replace(
            /(<div [^>]*id="fame-reset-countdown"[^>]*>)[^<]*(<\/div>)/,
            `$1${countdown}$2`,
        );
        html = html.replace(
            /(<div [^>]*id="fame-unlocked-count"[^>]*>)[^<]*(<\/div>)/,
            `$1${escapeHtml(stats.unlockedCount)}$2`,
        );
        html = html.replace(
            /(<div [^>]*id="fame-total-points"[^>]*>)[^<]*(<\/div>)/,
            `$1${escapeHtml(stats.totalPoints)}$2`,
        );
        html = html.replace(
            /(<div [^>]*id="fame-overall-status")([^>]*>)[^<]*(<\/div>)/,
            `$1 style="color: ${stats.statusColor};"$2${escapeHtml(stats.statusText)}$3`,
        );

        const cardsHtml = renderFameCardsHtml(fameData.arenas);
        const originalContent = `<div id="fame-cards-container" class="fame-cards-container">\n            <div class="fame-loading">Connecting to Screeps: Arena…</div>\n        </div>`;
        if (html.includes(originalContent)) {
            html = html.replace(
                originalContent,
                `<div id="fame-cards-container" class="fame-cards-container">\n${cardsHtml}\n        </div>`,
            );
        } else {
            // Fallback regex in case of slight whitespace variance
            html = html.replace(
                /<div id="fame-cards-container"[^>]*>[\s\S]*?<\/div>(\s*<\/div>\s*<!--)/,
                `<div id="fame-cards-container" class="fame-cards-container">\n${cardsHtml}\n        </div>$1`,
            );
        }
    } else if (fameData && !fameData.ok) {
        html = html.replace(
            /(<div [^>]*id="fame-overall-status")([^>]*>)[^<]*(<\/div>)/,
            `$1 style="color: var(--fg-dim);"$2Offline$3`,
        );
        const errorContent = `<div class="fame-loading">Screeps: Arena is not running or inspector unavailable.<br><span class="hint">${escapeHtml(fameData.error ?? "")}</span></div>`;
        const originalContent = `<div id="fame-cards-container" class="fame-cards-container">\n            <div class="fame-loading">Connecting to Screeps: Arena…</div>\n        </div>`;
        if (html.includes(originalContent)) {
            html = html.replace(
                originalContent,
                `<div id="fame-cards-container" class="fame-cards-container">\n            ${errorContent}\n        </div>`,
            );
        } else {
            html = html.replace(
                /<div id="fame-cards-container"[^>]*>[\s\S]*?<\/div>(\s*<\/div>\s*<!--)/,
                `<div id="fame-cards-container" class="fame-cards-container">\n            ${errorContent}\n        </div>$1`,
            );
        }
    }

    // 4. Inject __INITIAL_FAME_DATA__ script into <head>
    const scriptTag = `<script id="__INITIAL_FAME_DATA__">window.__INITIAL_FAME_DATA__ = ${JSON.stringify(fameData)};</script>\n</head>`;
    html = html.replace("</head>", scriptTag);

    return html;
}
