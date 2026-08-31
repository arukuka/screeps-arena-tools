/**
 * Minimal CDP (Chrome DevTools Protocol) client to connect to running Screeps: Arena (Electron).
 *
 * The Arena game API validates Steam auth sessions and returns 401 on direct external requests.
 * However, the local running game client already holds valid authentication credentials.
 * Therefore, we:
 *
 *   1. Send `SIGUSR1` to open the Node.js inspector (:9229)
 *   2. Connect via CDP to the main process
 *   3. Execute `fetch()` in the renderer's authenticated context
 *
 * This allows fetching matches accessible to your account without forging credentials.
 */

import { execFileSync } from "node:child_process";

const INSPECTOR_PORT = 9229;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Locate the PID of the running Arena main process.
 *
 * Excludes `Helper` to avoid targeting Electron renderer/GPU child processes.
 *
 * @returns {string | null}
 */
export function findArenaPid() {
    try {
        const out = execFileSync("/bin/sh", [
            "-c",
            "ps ax -o pid=,command= | grep -i '[s]creeps_arena.app/Contents/MacOS/screeps_arena' | grep -v Helper",
        ], { encoding: "utf8" });
        const line = out.trim().split("\n")[0];
        if (!line) return null;
        return line.trim().split(/\s+/)[0];
    } catch {
        return null;
    }
}

/** Open inspector port via SIGUSR1. Safe to call if already enabled. */
export function enableInspector(pid) {
    try {
        process.kill(Number(pid), "SIGUSR1");
        return true;
    } catch {
        return false;
    }
}

/** Open the match in-app to ensure the renderer has loaded the authenticated match context. */
export function openMatchInApp(shortId) {
    try {
        execFileSync("/usr/bin/open", [`screeps-arena:/game/${shortId}`], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/**
 * Wait for and retrieve the inspector WebSocket URL.
 *
 * @param {{ attempts?: number, delayMs?: number }} [options]
 */
export async function waitForInspector(options = {}) {
    const attempts = options.attempts ?? 20;
    const delayMs = options.delayMs ?? 300;
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json`);
            const list = await res.json();
            if (Array.isArray(list) && list.length > 0 && list[0].webSocketDebuggerUrl) {
                return list[0].webSocketDebuggerUrl;
            }
        } catch (err) {
            lastError = err;
        }
        await sleep(delayMs);
    }
    throw new Error(
        `Cannot connect to inspector (127.0.0.1:${INSPECTOR_PORT})` +
            (lastError ? `: ${lastError.message}` : ""),
    );
}

/**
 * CDP session to evaluate expressions in the renderer process.
 *
 * @param {string} wsUrl
 */
export async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    ws.onmessage = (evt) => {
        const msg = JSON.parse(String(evt.data));
        const entry = pending.get(msg.id);
        if (entry === undefined) return;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP error"));
        else entry.resolve(msg.result);
    };

    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error(`Cannot connect to WebSocket: ${wsUrl}`));
    });

    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });

    await send("Runtime.enable");

    return {
        /**
         * Evaluate an expression within the authenticated renderer context.
         *
         * @param {string} expression
         */
        async evaluateInRenderer(expression) {
            const wrapper = `
                (async () => {
                    const Module = process.mainModule
                        ? process.mainModule.constructor
                        : (new Function('return this'))().module.constructor;
                    const req = Module.createRequire(process.cwd() + '/');
                    const { BrowserWindow } = req('electron');
                    const wins = BrowserWindow.getAllWindows();
                    if (wins.length === 0) throw new Error('Arena window not found');
                    return await wins[0].webContents.executeJavaScript(${JSON.stringify(expression)});
                })()
            `;
            const result = await send("Runtime.evaluate", {
                expression: wrapper,
                awaitPromise: true,
                returnByValue: true,
            });
            if (result.exceptionDetails) {
                const text =
                    result.exceptionDetails.exception?.description ??
                    result.exceptionDetails.text ??
                    "unknown error";
                throw new Error(`Renderer evaluation failed: ${text}`);
            }
            return result.result?.value;
        },

        close() {
            ws.close();
        },
    };
}
