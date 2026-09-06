/**
 * Fame match automation service for Screeps: Arena.
 *
 * Automates daily Fame match series (up to 10 matches), reward collection,
 * and session finalization via running Screeps: Arena Electron renderer context.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CdpSession } from "./cdp.js";
import { openArenaSession } from "./sync.js";

const API = "https://arena.screeps.com/api";
const FAME_MAX_GAMES = 10;
const DEFAULT_CONFIG_FILE = "fame.config.json";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fetchExpr = (url: string, init?: { method?: string; body?: any; headers?: Record<string, string> }): string => `
    (async () => {
        try {
            const opts = ${JSON.stringify(init ?? {})};
            opts.credentials = 'include';
            const res = await fetch(${JSON.stringify(url)}, opts);
            if (!res.ok) return { __error: true, status: res.status, statusText: res.statusText };
            return await res.json();
        } catch (e) {
            return { __error: true, status: -1, statusText: String(e) };
        }
    })()
`;

export interface FameRewardDef {
    itemdefid: string;
    type: string;
    name: string;
    description: string;
    icon_url?: string;
    tags?: string;
}

export interface FameSessionInfo {
    _id: string;
    arena: string;
    createdAt: string;
    points: number;
    rewardedAt?: string | null;
    rewards?: Array<[string, number]>;
    rewardsLevel?: number;
    finishedAt?: string | null;
    defs?: FameRewardDef[];
}

export interface FameGameSummary {
    _id: string;
    shortId?: string | null;
    status: string;
    winner: number | null;
    won: boolean;
    draw: boolean;
    ticks: number;
    createdAt: string;
    opponent: string;
}

export interface ArenaFameStatus {
    arenaId: string;
    arenaName: string;
    advanced: boolean;
    folderName?: string;
    unlocked: boolean;
    canPlay: boolean;
    isFinished: boolean;
    gamesPlayed: number;
    wins: number;
    losses: number;
    draws: number;
    famePoints: number;
    rewardsLevel: number;
    rewardsTaken: boolean;
    rewards: Array<{
        itemdefid: string;
        quantity: number;
        name: string;
        description: string;
        icon_url?: string;
    }>;
    nextResetUtc: string;
    nextResetMs: number;
    fameSession?: FameSessionInfo | null;
    games: FameGameSummary[];
    sourceFolder?: string | null;
}

export interface FameArenaConfig {
    id: string;
    name?: string;
    enabled?: boolean;
    sourceFolder?: string;
}

export interface FameConfig {
    stopOnDefeat?: boolean;
    continuous?: boolean;
    pollIntervalSec?: number;
    arenas?: FameArenaConfig[];
}

export interface FameRunOptions {
    arena?: string;
    stopOnDefeat?: boolean;
    continuous?: boolean;
    config?: string;
    pollIntervalSec?: number;
    onLog?: (msg: string) => void;
    onMatchStart?: (info: { arena: ArenaFameStatus; matchNumber: number }) => void;
    onMatchFinish?: (info: { arena: ArenaFameStatus; matchNumber: number; game: FameGameSummary }) => void;
}

/**
 * Parse Fame match list according to Screeps Arena usersCode score specification.
 *
 * In Screeps Arena, `game.result.winner` is the score from the perspective of `usersCode[0]`:
 *   - 1: usersCode[0] won
 *   - 0: usersCode[1] won
 *   - 0.5: Draw
 */
export function parseFameGames(
    rawGames: any[],
    myUserId: string | null,
): { games: FameGameSummary[]; wins: number; losses: number; draws: number } {
    let wins = 0;
    let losses = 0;
    let draws = 0;

    const parsedGames: FameGameSummary[] = rawGames.map((item: any) => {
        const g = item.game ?? {};
        const rawWinner = g.result?.winner;
        const isDraw = rawWinner === 0.5 || rawWinner === -1 || g.result?.draw === true;

        const code0Id = Array.isArray(g.usersCode) ? g.usersCode[0] : null;
        const code0 = Array.isArray(item.codes) ? item.codes.find((c: any) => c._id === code0Id) : null;
        const isMyCode0 = code0 ? code0.user === myUserId : false;

        let won = false;
        let opponent = "System";

        if (Array.isArray(item.users)) {
            const oppUser = item.users.find((u: any) => u._id !== myUserId);
            if (oppUser) opponent = oppUser.username || "Opponent";
        }

        if (!isDraw && typeof rawWinner === "number") {
            won = isMyCode0 ? rawWinner === 1 : rawWinner === 0;
        }

        if (g.status === "finished") {
            if (isDraw) draws++;
            else if (won) wins++;
            else losses++;
        }

        return {
            _id: g._id ?? item._id,
            shortId: g.shortId ?? null,
            status: g.status ?? "unknown",
            winner: rawWinner ?? null,
            won,
            draw: isDraw,
            ticks: g.meta?.ticks ?? g.ticks ?? 0,
            createdAt: g.createdAt ?? item.createdAt ?? null,
            opponent,
        };
    });

    // Sort games latest first (descending by createdAt, so games[0] is always the most recent match)
    const games = parsedGames.sort((a, b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tB - tA;
    });

    return { games, wins, losses, draws };
}

/**
 * Calculate the next UTC 00:00:00 timestamp and remaining milliseconds.
 */
export function getNextUtcReset(): { nextResetUtc: string; nextResetMs: number } {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    const nextResetMs = Math.max(0, next.getTime() - now.getTime());
    return {
        nextResetUtc: next.toISOString(),
        nextResetMs,
    };
}

/**
 * Format milliseconds into human-readable hh:mm:ss.
 */
export function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Load Fame configuration from a JSON file.
 */
export function loadFameConfig(configPath?: string): FameConfig {
    const file = configPath ? resolve(process.cwd(), configPath) : resolve(process.cwd(), DEFAULT_CONFIG_FILE);
    if (!existsSync(file)) return {};
    try {
        const raw = readFileSync(file, "utf8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

/**
 * Save default Fame configuration file.
 */
export function saveDefaultFameConfig(
    arenas: ArenaFameStatus[],
    configPath?: string,
    options?: { stopOnDefeat?: boolean },
): string {
    const file = configPath ? resolve(process.cwd(), configPath) : resolve(process.cwd(), DEFAULT_CONFIG_FILE);
    const config: FameConfig = {
        stopOnDefeat: options?.stopOnDefeat ?? false,
        continuous: true,
        pollIntervalSec: 5,
        arenas: arenas.map((a) => ({
            id: a.arenaId,
            name: `${a.arenaName} (${a.advanced ? "Advanced" : "Basic"})`,
            enabled: a.unlocked,
            sourceFolder: a.sourceFolder ?? "",
        })),
    };
    writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
    return file;
}

/**
 * Ensure renderer navigates to the Fame page for the specified arena.
 */
export async function ensureFamePage(session: CdpSession, arenaId: string): Promise<void> {
    await session.evaluateInRenderer(`
        (() => {
            const currentHash = window.location.hash;
            const target = '/arenas/' + ${JSON.stringify(arenaId)} + '/fame';
            if (!currentHash.includes(${JSON.stringify(arenaId)}) || !currentHash.includes('/fame')) {
                const root = document.querySelector('sca-root');
                const comp = root && window.ng ? window.ng.getComponent(root) : null;
                if (comp && comp._router && comp._zone) {
                    comp._zone.run(() => comp._router.navigateByUrl(target));
                } else {
                    window.location.hash = '#' + target;
                }
            }
        })()
    `);
    await sleep(600);
}

/**
 * Fetch all arenas in the current season and their Fame & unlock statuses.
 */
export async function getAllArenasFameStatus(session: CdpSession): Promise<ArenaFameStatus[]> {
    let seasonData: any = null;
    for (let i = 0; i < 3; i++) {
        seasonData = await session.evaluateInRenderer(fetchExpr(`${API}/season/current`));
        if (seasonData && !seasonData.__error && seasonData.season?._id) break;
        await sleep(500);
    }
    if (!seasonData || seasonData.__error || !seasonData.season?._id) {
        throw new Error("Cannot fetch current season information from Screeps: Arena API");
    }
    const seasonId = seasonData.season._id;
    const arenasData = await session.evaluateInRenderer(fetchExpr(`${API}/season/${seasonId}/arenas`));
    if (!arenasData || arenasData.__error || !Array.isArray(arenasData.arenas)) {
        throw new Error(`Cannot fetch arenas for season ${seasonId}`);
    }

    // Get current user id to determine match winner
    const meData = await session.evaluateInRenderer(fetchExpr(`${API}/auth/me`));
    const myUserId: string | null = meData?._id ?? null;

    const results: ArenaFameStatus[] = [];
    for (const a of arenasData.arenas) {
        const status = await getSingleArenaFameStatus(session, a, myUserId);
        results.push(status);
    }
    return results;
}

/**
 * Fetch Fame status for a single arena.
 */
async function getSingleArenaFameStatus(
    session: CdpSession,
    arena: any,
    myUserId: string | null,
): Promise<ArenaFameStatus> {
    const arenaId = arena._id;
    const { nextResetUtc, nextResetMs } = getNextUtcReset();

    // 1. Fetch arena detail (unlocked state)
    const detailData = await session.evaluateInRenderer(fetchExpr(`${API}/arena/${arenaId}`));
    const unlocked: boolean = Boolean(detailData?.arena?.unlocked ?? arena.unlocked ?? false);

    // 2. Fetch fame session
    const fameData = await session.evaluateInRenderer(fetchExpr(`${API}/fame/${arenaId}`));
    const fameSession: FameSessionInfo | null = fameData?.fame ?? null;

    // 3. Fetch fame games
    const gamesData = await session.evaluateInRenderer(fetchExpr(`${API}/fame/${arenaId}/games`));
    const rawGames: any[] = Array.isArray(gamesData?.items) ? gamesData.items : [];

    // 4. Read sourceFolder from localStorage
    const sourceFolder: string | null = await session.evaluateInRenderer(`
        (() => {
            const key = "arena_local_settings_" + ${JSON.stringify(arenaId)} + "_running_game";
            const val = localStorage.getItem(key);
            if (!val) return null;
            try { return JSON.parse(val).sourceFolder || null; } catch { return null; }
        })()
    `);

    // Parse games using Screeps Arena usersCode score specification
    const { games, wins, losses, draws } = parseFameGames(rawGames, myUserId);

    const isFinished = Boolean(fameSession?.finishedAt);
    const gamesPlayed = games.length;
    const canPlay = unlocked && !isFinished && gamesPlayed < FAME_MAX_GAMES;

    // Parse rewards
    const defsMap = new Map<string, FameRewardDef>();
    if (Array.isArray(fameSession?.defs)) {
        for (const d of fameSession.defs) {
            defsMap.set(d.itemdefid, d);
        }
    }

    const rewards: Array<{
        itemdefid: string;
        quantity: number;
        name: string;
        description: string;
        icon_url?: string;
    }> = [];
    if (Array.isArray(fameSession?.rewards)) {
        for (const [defId, qty] of fameSession.rewards) {
            const def = defsMap.get(defId);
            rewards.push({
                itemdefid: defId,
                quantity: qty,
                name: def?.name ?? `Item ${defId}`,
                description: def?.description ?? "",
                icon_url: def?.icon_url,
            });
        }
    }

    const rewardsTaken = Boolean(fameSession?.rewardedAt);
    const rewardsLevel = fameSession?.rewardsLevel ?? 0;
    const pointsPerWin = fameSession?.points ?? 1;
    const famePoints = pointsPerWin * wins;

    return {
        arenaId,
        arenaName: arena.name,
        advanced: Boolean(arena.advanced),
        folderName: arena.folderName,
        unlocked,
        canPlay,
        isFinished,
        gamesPlayed,
        wins,
        losses,
        draws,
        famePoints,
        rewardsLevel,
        rewardsTaken,
        rewards,
        nextResetUtc,
        nextResetMs,
        fameSession,
        games,
        sourceFolder,
    };
}

/**
 * Start a Fame match by packing source code and sending POST /api/fame/start.
 */
export async function startFameMatch(
    session: CdpSession,
    arenaId: string,
    sourceFolder?: string,
): Promise<{ gameId: string }> {
    await ensureFamePage(session, arenaId);

    const result = await session.evaluateInRenderer(`
        (async () => {
            const arenaId = ${JSON.stringify(arenaId)};
            let folder = ${JSON.stringify(sourceFolder ?? null)};
            if (!folder) {
                const key = "arena_local_settings_" + arenaId + "_running_game";
                const val = localStorage.getItem(key);
                if (val) {
                    try { folder = JSON.parse(val).sourceFolder; } catch {}
                }
            }
            if (!folder) {
                return { __error: true, message: "No sourceFolder configured for arena " + arenaId };
            }

            // Obtain SCACodeSourcesService from Angular component (retry up to 5s if component is still mounting)
            let codeSourcesSvc = null;
            for (let attempt = 0; attempt < 50; attempt++) {
                const sidebar = document.querySelector("sca-arena-fame-sidebar");
                const comp = sidebar && window.ng ? window.ng.getComponent(sidebar) : null;
                const playSvc = comp ? comp._scaPlaySeriesService : null;
                if (playSvc && playSvc._scaCodeSourcesService) {
                    codeSourcesSvc = playSvc._scaCodeSourcesService;
                    break;
                }
                await new Promise((r) => setTimeout(r, 100));
            }

            let zipBlob = null;
            if (codeSourcesSvc) {
                zipBlob = await codeSourcesSvc.getSourcesFileZip(folder);
            } else {
                return { __error: true, message: "Could not access Angular SCACodeSourcesService in renderer (timed out waiting for sca-arena-fame-sidebar component)" };
            }

            if (!zipBlob) {
                return { __error: true, message: "Failed to generate code zip" };
            }

            const formData = new FormData();
            formData.append("arena", arenaId);
            formData.append("code", zipBlob, "code.zip");

            const res = await fetch("https://arena.screeps.com/api/fame/start", {
                method: "POST",
                body: formData,
                credentials: "include"
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                return { __error: true, status: res.status, message: res.statusText + ": " + errText };
            }

            const data = await res.json();
            return {
                ok: true,
                gameId: data?.game?._id ?? data?._id
            };
        })()
    `);

    if (!result || result.__error || !result.gameId) {
        throw new Error(`Failed to start Fame match: ${result?.message ?? "unknown error"}`);
    }

    return { gameId: result.gameId };
}

/**
 * Poll game until finished.
 */
export async function pollGameFinished(
    session: CdpSession,
    gameId: string,
    options: { timeoutMs?: number; intervalMs?: number; onProgress?: (ticks: number) => void } = {},
): Promise<any> {
    const timeoutMs = options.timeoutMs ?? 300_000; // 5 minutes max per match
    const intervalMs = options.intervalMs ?? 3_000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const data = await session.evaluateInRenderer(fetchExpr(`${API}/game/${gameId}`));
        if (data && !data.__error && data.game) {
            const outer = data.game;
            const inner = outer.game ?? outer;
            const status = inner.status ?? outer.status;
            const ticks = outer.meta?.ticks ?? inner.meta?.ticks ?? inner.ticks ?? outer.ticks ?? 0;

            if (options.onProgress) options.onProgress(ticks);

            if (status === "finished") {
                return inner;
            }
            if (status === "error" || status === "failed") {
                throw new Error(`Game failed with status: ${status}`);
            }
        }
        await sleep(intervalMs);
    }
    throw new Error(`Game polling timed out after ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Take rewards (claim chest).
 */
export async function takeFameRewards(session: CdpSession, arenaId: string): Promise<any> {
    const res = await session.evaluateInRenderer(
        fetchExpr(`${API}/fame/${arenaId}/take`, {
            method: "POST",
            body: "{}",
            headers: { "Content-Type": "application/json" },
        }),
    );
    if (!res || res.__error) {
        throw new Error(`Failed to take rewards: ${res?.statusText ?? "unknown error"}`);
    }
    return res;
}

/**
 * Finalize fame session (Finish and Leave).
 */
export async function finishFameSession(session: CdpSession, arenaId: string): Promise<any> {
    const res = await session.evaluateInRenderer(
        fetchExpr(`${API}/fame/${arenaId}/finish`, {
            method: "POST",
            body: "{}",
            headers: { "Content-Type": "application/json" },
        }),
    );
    if (!res || res.__error) {
        throw new Error(`Failed to finish Fame session: ${res?.statusText ?? "unknown error"}`);
    }
    return res;
}

/**
 * Execute all remaining Fame matches for an arena, then take rewards and leave.
 */
export async function runFameForArena(
    session: CdpSession,
    arena: ArenaFameStatus,
    options: FameRunOptions = {},
): Promise<{
    completed: boolean;
    matchesPlayed: number;
    stoppedOnDefeat: boolean;
    finalStatus: ArenaFameStatus;
}> {
    const log = options.onLog ?? console.log;
    const stopOnDefeat = options.stopOnDefeat ?? false;

    log(`\n--- Starting Fame runner for: ${arena.arenaName} (${arena.advanced ? "Advanced" : "Basic"}) ---`);

    let currentStatus = arena;
    let matchesPlayed = 0;
    let stoppedOnDefeat = false;

    // Check if arena can be played
    if (!currentStatus.unlocked) {
        log(`  Arena is locked. Skipping.`);
        return { completed: false, matchesPlayed: 0, stoppedOnDefeat: false, finalStatus: currentStatus };
    }

    if (currentStatus.isFinished) {
        log(`  Fame for today is already finished. Next reset in ${formatDuration(currentStatus.nextResetMs)}.`);
        return { completed: true, matchesPlayed: 0, stoppedOnDefeat: false, finalStatus: currentStatus };
    }

    // Play loop
    while (currentStatus.gamesPlayed < FAME_MAX_GAMES) {
        const matchNum = currentStatus.gamesPlayed + 1;
        log(`\n  [Match ${matchNum}/${FAME_MAX_GAMES}] Starting...`);
        if (options.onMatchStart) {
            options.onMatchStart({ arena: currentStatus, matchNumber: matchNum });
        }

        try {
            const { gameId } = await startFameMatch(session, arena.arenaId, currentStatus.sourceFolder ?? undefined);
            log(`  Game ID: ${gameId}. Waiting for match to finish...`);

            const game = await pollGameFinished(session, gameId, {
                intervalMs: (options.pollIntervalSec ?? 5) * 1000,
                onProgress: (ticks) => {
                    if (process.stdout.isTTY) {
                        process.stdout.write(`\r    Tick: ${ticks}...   `);
                    }
                },
            });

            if (process.stdout.isTTY) process.stdout.write("\n");

            // Refresh status
            const meData = await session.evaluateInRenderer(fetchExpr(`${API}/auth/me`));
            currentStatus = await getSingleArenaFameStatus(session, arena, meData?._id ?? null);
            matchesPlayed++;

            const lastGame = currentStatus.games[0];
            const outcome = lastGame?.draw ? "DRAW" : lastGame?.won ? "VICTORY" : "DEFEAT";
            log(`  Result: ${outcome} vs ${lastGame?.opponent ?? "Opponent"} (${lastGame?.ticks ?? 0} ticks)`);
            log(`  Current Record: ${currentStatus.wins}W / ${currentStatus.losses}L / ${currentStatus.draws}D (Points: ${currentStatus.famePoints})`);

            if (options.onMatchFinish && lastGame) {
                options.onMatchFinish({ arena: currentStatus, matchNumber: matchNum, game: lastGame });
            }

            // Check stopOnDefeat
            if (stopOnDefeat && lastGame && !lastGame.won && !lastGame.draw) {
                log(`  Defeat detected and --stop-on-defeat is enabled. Stopping series early.`);
                stoppedOnDefeat = true;
                break;
            }

            // Brief rest between matches
            await sleep(2000);
        } catch (err: any) {
            log(`\n  [CRITICAL ERROR] Failed during match ${matchNum}: ${err.message}`);
            log(`  Aborting program immediately. The session was NOT finalized and remains open.`);
            log(`  You can safely resume Fame automation by re-running the command after resolving the issue.\n`);
            throw err;
        }
    }

    // Finalize session (Leave and Finish) and claim rewards ONLY on clean completion
    const isCleanFinish = currentStatus.gamesPlayed >= FAME_MAX_GAMES || stoppedOnDefeat;
    if (!isCleanFinish) {
        log(`\n  Fame series paused (${currentStatus.gamesPlayed}/${FAME_MAX_GAMES} played). Session kept open for retry.`);
        return {
            completed: false,
            matchesPlayed,
            stoppedOnDefeat,
            finalStatus: currentStatus,
        };
    }

    log(`\n  Series finished cleanly. Total matches played today: ${currentStatus.gamesPlayed}/${FAME_MAX_GAMES}`);

    // If rewards exist and not claimed yet, claim them
    if (currentStatus.rewardsLevel > 0 && !currentStatus.rewardsTaken) {
        log(`  Claiming Fame Chest rewards (Level ${currentStatus.rewardsLevel})...`);
        try {
            await takeFameRewards(session, arena.arenaId);
            log(`  Rewards successfully claimed!`);
        } catch (e: any) {
            log(`  Notice on claiming rewards: ${e.message}`);
        }
    }

    // Finalize session (Leave and Finish)
    if (!currentStatus.isFinished) {
        log(`  Finalizing Fame session (Leave and Finish)...`);
        try {
            await finishFameSession(session, arena.arenaId);
            log(`  Fame session finalized.`);
        } catch (e: any) {
            log(`  Notice on finalizing session: ${e.message}`);
        }
    }

    // Refresh final status again after take/finish
    const finalMeData = await session.evaluateInRenderer(fetchExpr(`${API}/auth/me`));
    currentStatus = await getSingleArenaFameStatus(session, arena, finalMeData?._id ?? null);

    return {
        completed: true,
        matchesPlayed,
        stoppedOnDefeat,
        finalStatus: currentStatus,
    };
}

/**
 * Top-level Fame automation runner.
 *
 * Runs across all configured / unlocked arenas.
 * In continuous mode, sleeps until UTC 00:00:00 and repeats daily until interrupted.
 */
export async function runFameAutomation(options: FameRunOptions = {}): Promise<void> {
    const log = options.onLog ?? console.log;
    const config = loadFameConfig(options.config);

    const stopOnDefeat = options.stopOnDefeat ?? config.stopOnDefeat ?? false;
    const continuous = options.continuous ?? config.continuous ?? false;

    let aborted = false;
    const onSigint = () => {
        log("\nReceived SIGINT (Ctrl+C). Exiting Fame runner...");
        aborted = true;
    };
    process.on("SIGINT", onSigint);

    try {
        do {
            log(`\n======================================================`);
            log(`=== Screeps Arena: Fame Daily Runner (${new Date().toLocaleString()}) ===`);
            log(`======================================================`);

            const session = await openArenaSession();
            try {
                const allArenas = await getAllArenasFameStatus(session);

                // Filter target arenas
                let targets = allArenas.filter((a) => a.unlocked);

                // Check arena filter option
                if (options.arena) {
                    const q = options.arena.toLowerCase().trim();
                    targets = targets.filter(
                        (a) =>
                            a.arenaId.toLowerCase() === q ||
                            a.arenaName.toLowerCase().includes(q) ||
                            (a.folderName && a.folderName.toLowerCase().includes(q)),
                    );
                } else if (config.arenas && config.arenas.length > 0) {
                    const enabledMap = new Map(config.arenas.map((c) => [c.id, c]));
                    targets = targets.filter((a) => {
                        const conf = enabledMap.get(a.arenaId);
                        if (conf && conf.sourceFolder) a.sourceFolder = conf.sourceFolder;
                        return conf ? conf.enabled !== false : true;
                    });
                }

                if (targets.length === 0) {
                    log("No unlocked / eligible arenas found for Fame matches.");
                } else {
                    log(`Target arenas: ${targets.map((t) => `${t.arenaName} (${t.advanced ? "Adv" : "Basic"})`).join(", ")}`);

                    for (const arena of targets) {
                        if (aborted) break;
                        await runFameForArena(session, arena, {
                            ...options,
                            stopOnDefeat,
                        });
                    }
                }
            } finally {
                session.close();
            }

            if (!continuous || aborted) {
                break;
            }

            // Calculate wait time until next UTC 00:00:00
            const { nextResetUtc, nextResetMs } = getNextUtcReset();
            log(`\nAll daily Fame matches finished for today.`);
            log(`Next reset: ${nextResetUtc} (in ${formatDuration(nextResetMs)})`);
            log(`Waiting in continuous mode (press Ctrl+C to stop)...`);

            // Sleep loop in 5-second intervals to allow responsive Ctrl+C
            const targetTime = Date.now() + nextResetMs + 5000; // +5s buffer after midnight
            while (Date.now() < targetTime && !aborted) {
                const remaining = Math.max(0, targetTime - Date.now());
                if (process.stdout.isTTY) {
                    process.stdout.write(`\r  Next run in: ${formatDuration(remaining)}   `);
                }
                await sleep(5000);
            }
            if (process.stdout.isTTY) process.stdout.write("\n");
        } while (continuous && !aborted);
    } finally {
        process.removeListener("SIGINT", onSigint);
    }
}
