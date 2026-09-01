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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CdpSession {
    evaluateInRenderer(expression: string): Promise<any>;
    close(): void;
}

/**
 * Locate the PID of the running Arena main process.
 *
 * Excludes `Helper` to avoid targeting Electron renderer/GPU child processes.
 *
 * @returns PID string or null if not found
 */
export function findArenaPid(): string | null {
    try {
        const out = execFileSync("/bin/sh", [
            "-c",
            "ps ax -o pid=,command= | grep -i '[s]creeps_arena.app/Contents/MacOS/screeps_arena' | grep -v Helper",
        ], { encoding: "utf8" });
        const line = out.trim().split("\n")[0];
        if (!line) return null;
        return line.trim().split(/\s+/)[0] ?? null;
    } catch {
        return null;
    }
}

/** Open inspector port via SIGUSR1. Safe to call if already enabled. */
export function enableInspector(pid: string | number): boolean {
    try {
        process.kill(Number(pid), "SIGUSR1");
        return true;
    } catch {
        return false;
    }
}

/** Open the match in-app to ensure the renderer has loaded the authenticated match context. */
export function openMatchInApp(shortId: string): boolean {
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
 * @param options
 */
export async function waitForInspector(options: { attempts?: number; delayMs?: number } = {}): Promise<string> {
    const attempts = options.attempts ?? 20;
    const delayMs = options.delayMs ?? 300;
    let lastError: any = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json`);
            const list: any = await res.json();
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
 * @param wsUrl
 */
export async function connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
    let nextId = 1;

    ws.onmessage = (evt) => {
        const msg = JSON.parse(String(evt.data));
        const entry = pending.get(msg.id);
        if (entry === undefined) return;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP error"));
        else entry.resolve(msg.result);
    };

    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error(`Cannot connect to WebSocket: ${wsUrl}`));
    });

    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
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
         * @param expression
         */
        async evaluateInRenderer(expression: string): Promise<any> {
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

        close(): void {
            ws.close();
        },
    };
}
