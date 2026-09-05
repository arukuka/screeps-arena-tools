/**
 * Automated match runner and log collector for Screeps: Arena.
 *
 * Connects to the running Screeps: Arena (Electron) client via CDP:
 *   1. Starts test match vs Idle opponent (clicks PLAY)
 *   2. Waits until match finishes (button transitions STOP -> RESTART)
 *   3. Extracts game ObjectId from `sca-arena-tests-list-item`
 *   4. Fetches logs directly via authenticated Screeps Arena API
 *   5. Emits logs via callback, saves to output file, or prints to stdout
 *   6. Clicks RESTART to reset view to PLAY state
 *   7. Repeats until target count is reached or stopped
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    connect,
    enableInspector,
    findArenaPid,
    waitForInspector,
    type CdpSession,
} from "./cdp.js";
import { resolveArena } from "./arena_api.js";

const API = "https://arena.screeps.com/api";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fetchExpr = (url: string): string => `
    (async () => {
        const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        if (!res.ok) return { __error: true, status: res.status, statusText: res.statusText };
        return await res.json();
    })()
`;

export interface MatchResult {
    matchNumber: number;
    gameId: string;
    logs: string[];
}

export interface CollectOptions {
    /** Target arena query (e.g. "Pain and Gain") */
    arena?: string;
    /** Number of matches to run and collect (default: 10) */
    count?: number;
    /** Run continuously until manually stopped (Ctrl+C) */
    continuous?: boolean;
    /** Output file path to append collected logs */
    out?: string;
    /** Filter pattern for log lines (default: "ARENA_DUMP", pass "" for all logs) */
    filter?: string | RegExp;
    /** Stream log lines to stdout */
    stdout?: boolean;
    /** Custom inspector WebSocket URL */
    wsUrl?: string;
    /** Callback invoked after each match finishes with its extracted logs */
    onMatch?: (info: MatchResult) => void | Promise<void>;
}

/**
 * Ensure client is on the tests page with Idle opponent selected.
 */
async function ensureSetupReady(session: CdpSession, arenaId: string): Promise<void> {
    await session.evaluateInRenderer(`
        (() => {
            const currentHash = window.location.hash;
            if (!currentHash.includes(${JSON.stringify(arenaId)}) || !currentHash.includes('/tests')) {
                const root = document.querySelector('sca-root');
                const comp = root && window.ng ? window.ng.getComponent(root) : null;
                const target = '/arenas/' + ${JSON.stringify(arenaId)} + '/tests';
                if (comp && comp._router && comp._zone) {
                    comp._zone.run(() => comp._router.navigateByUrl(target));
                } else {
                    window.location.hash = '#' + target;
                }
            }

            // Ensure Idle opponent is checked if on the checkbox page
            const idle = Array.from(document.querySelectorAll('ui-form-checkbox')).find(
                el => el.innerText && el.innerText.includes('Idle opponent')
            );
            const input = idle ? idle.querySelector('input[type="checkbox"]') : null;
            if (input && !input.checked) input.click();
        })()
    `);
    await sleep(800);
}

/**
 * Get current label of main action button (PLAY, STOP, RESTART).
 */
async function getActionButtonText(session: CdpSession): Promise<string> {
    return await session.evaluateInRenderer(`
        (() => {
            const btn = document.querySelector('button.--ui-btn-play');
            if (!btn) return 'NONE';
            const txt = btn.innerText.trim().toUpperCase();
            if (txt.includes('STOP')) return 'STOP';
            if (txt.includes('RESTART')) return 'RESTART';
            if (txt.includes('PLAY')) return 'PLAY';
            return txt;
        })()
    `);
}

/**
 * Click the main action button (PLAY or RESTART).
 */
async function clickActionButton(session: CdpSession): Promise<boolean> {
    return await session.evaluateInRenderer(`
        (() => {
            const btn = document.querySelector('button.--ui-btn-play');
            if (btn && !btn.disabled && !btn.getAttribute('disabled')) {
                btn.click();
                return true;
            }
            return false;
        })()
    `);
}

/**
 * Wait until match completes: button transitions to STOP, then to RESTART.
 * Returns the completed game's ObjectId.
 */
async function waitForMatchCompletion(session: CdpSession, timeoutMs = 90000): Promise<string> {
    const start = Date.now();
    let hasSeenStop = false;

    while (Date.now() - start < timeoutMs) {
        await sleep(800);

        const status = await session.evaluateInRenderer(`
            (() => {
                const btn = document.querySelector('button.--ui-btn-play');
                const txt = btn ? btn.innerText.trim().toUpperCase() : '';
                const items = Array.from(document.querySelectorAll('sca-arena-tests-list-item'));
                const comp = items[0] && window.ng ? window.ng.getComponent(items[0]) : null;
                const gameId = comp?.game?.game?._id ?? comp?.game?._id ?? null;

                return {
                    isStop: txt.includes('STOP'),
                    isRestart: txt.includes('RESTART'),
                    gameId
                };
            })()
        `);

        if (status.isStop) {
            hasSeenStop = true;
        }

        // Match completes when button becomes RESTART and gameId is available
        if (status.isRestart && status.gameId) {
            return status.gameId;
        }
    }

    throw new Error(`Timeout (${timeoutMs / 1000}s) waiting for match completion`);
}

/**
 * Fetch logs for a given game ID via the authenticated Screeps Arena API.
 */
async function fetchGameLogs(
    session: CdpSession,
    gameId: string,
    filter: string | RegExp = "ARENA_DUMP",
): Promise<string[]> {
    const matchedLines: string[] = [];
    const chunks = [100, 200];

    for (const chunk of chunks) {
        const logData = await session.evaluateInRenderer(fetchExpr(`${API}/game/${gameId}/log/${chunk}`));
        if (!logData || logData.__error) break;

        for (const tick of Object.keys(logData)) {
            const line = logData[tick];
            if (typeof line !== "string") continue;

            if (filter === "") {
                matchedLines.push(line);
            } else if (typeof filter === "string") {
                if (line.includes(filter)) matchedLines.push(line);
            } else if (filter instanceof RegExp) {
                if (filter.test(line)) matchedLines.push(line);
            }
        }

        // If filtering for ARENA_DUMP and terrain+objects already found, chunk 100 is sufficient
        if (
            filter === "ARENA_DUMP" &&
            matchedLines.some((l) => l.includes('"t":"terrain"')) &&
            matchedLines.some((l) => l.includes('"t":"objects"'))
        ) {
            break;
        }
    }

    return matchedLines;
}

/**
 * Main automated match execution and log collection runner.
 */
export async function collect(options: CollectOptions = {}): Promise<void> {
    const isStdout = Boolean(options.stdout);
    const log = (msg: string): void => {
        if (!isStdout) console.log(msg);
    };

    log("=== Screeps: Arena Automated Match Runner & Log Collector ===\n");

    let session: CdpSession;
    if (options.wsUrl) {
        log(`Connecting to inspector at ${options.wsUrl}...`);
        session = await connect(options.wsUrl);
    } else {
        const pid = findArenaPid();
        if (!pid) {
            throw new Error(
                "Screeps: Arena is not running.\n" +
                    "Please launch Screeps: Arena from Steam, log in, and ensure it is open.",
            );
        }
        log(`Found Screeps: Arena process (PID ${pid})`);
        enableInspector(pid);
        const wsUrl = await waitForInspector();
        log(`Connected via inspector (${wsUrl})`);
        session = await connect(wsUrl);
    }

    try {
        const rawArenaQuery = options.arena ?? "Pain and Gain";
        const normalizedArena = rawArenaQuery.replace(/_/g, " ");
        const arena = await resolveArena(session, normalizedArena);
        log(`Target Arena:   ${arena.name} (${arena.advanced ? "Advanced" : "Basic"}) [${arena._id}]\n`);

        log("Ensuring game client is ready on test screen...");
        await ensureSetupReady(session, arena._id);

        const targetCount = options.count ?? 10;
        const isContinuous = Boolean(options.continuous);
        const filter = options.filter ?? "ARENA_DUMP";
        const outPath = options.out ? resolve(options.out) : null;

        if (outPath) {
            log(`Writing logs to: ${outPath}`);
        }

        log(
            `Starting collection loop (${isContinuous ? "continuous until Ctrl+C" : `target: ${targetCount} matches`})...\n`,
        );

        let completedMatches = 0;

        while (isContinuous || completedMatches < targetCount) {
            completedMatches++;

            // 1. Prepare button state: if on RESTART, click it to reset to PLAY
            const btn = await getActionButtonText(session);
            if (btn === "RESTART") {
                await clickActionButton(session);
                await sleep(800);
            }

            // Ensure setup is ready (idle selected)
            await ensureSetupReady(session, arena._id);

            // Click PLAY to start match
            if (!isStdout) process.stdout.write(`[Match #${completedMatches}] Triggering match vs Idle opponent... `);
            const clicked = await clickActionButton(session);
            if (!clicked) {
                log("\nFailed to click PLAY button. Retrying...");
                await sleep(1500);
                continue;
            }
            log("Started.");

            // 2. Wait for match completion (STOP -> RESTART)
            if (!isStdout) process.stdout.write("  Waiting for match to finish... ");
            const gameId = await waitForMatchCompletion(session);
            log(`Finished! (ID: ${gameId})`);

            // 3. Fetch logs via API
            if (!isStdout) process.stdout.write(`  Fetching logs... `);
            const lines = await fetchGameLogs(session, gameId, filter);
            log(`Retrieved ${lines.length} line(s)`);

            // 4. Output lines
            if (lines.length > 0) {
                if (outPath) {
                    appendFileSync(outPath, lines.join("\n") + "\n", "utf-8");
                }
                if (isStdout) {
                    for (const l of lines) console.log(l);
                }
            }

            // 5. Invoke custom callback if provided
            if (options.onMatch) {
                await options.onMatch({
                    matchNumber: completedMatches,
                    gameId,
                    logs: lines,
                });
            }

            log(`  Progress: ${completedMatches}/${targetCount} matches completed\n`);

            // 6. Reset view from RESTART to PLAY for next match
            await clickActionButton(session);
            await sleep(800);
        }

        log(`\n✅ Finished! Successfully ran ${completedMatches} matches.`);
    } finally {
        session.close();
    }
}
