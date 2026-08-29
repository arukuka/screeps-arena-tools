/**
 * 起動中の Screeps: Arena（Electron）に繋ぐための最小限の CDP クライアント。
 *
 * Arena のゲーム API は Steam 認証セッションを見ており、外部から直接叩くと
 * 401 で弾かれる。一方、いま自分の PC で動いているアプリはその認証を持っている。
 * そこで
 *
 *   1. `SIGUSR1` で Node.js インスペクタ（:9229）を開かせ
 *   2. CDP でメインプロセスに繋ぎ
 *   3. レンダラーの認証済みコンテキストで `fetch()` を実行する
 *
 * という順で、自分のアカウントで見られる試合を自分で取り出す。
 * 認証を偽造してはおらず、閲覧権限のある試合しか取得できない。
 */

import { execFileSync } from "node:child_process";

const INSPECTOR_PORT = 9229;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 動いている Arena のメインプロセス PID を探す。
 *
 * `Helper` を除くのは、Electron が張るレンダラー/GPU の子プロセスを
 * 掴んでしまうとシグナルの宛先が変わるため。
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

/** インスペクタを開かせる。すでに開いていれば無害 */
export function enableInspector(pid) {
    try {
        process.kill(Number(pid), "SIGUSR1");
        return true;
    } catch {
        return false;
    }
}

/** アプリに対象の試合を開かせる。レンダラーが認証済みであることの担保でもある */
export function openMatchInApp(shortId) {
    try {
        execFileSync("/usr/bin/open", [`screeps-arena:/game/${shortId}`], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/**
 * インスペクタの WebSocket URL を待って取る。
 *
 * `SIGUSR1` を受けてから待ち受けが立つまでに間があるので、開くまで数回試す。
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
        `インスペクタ (127.0.0.1:${INSPECTOR_PORT}) に繋がらない` +
            (lastError ? `: ${lastError.message}` : ""),
    );
}

/**
 * CDP セッション。`evaluate()` でレンダラー側のコードを走らせる。
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
        ws.onerror = () => reject(new Error(`WebSocket に接続できない: ${wsUrl}`));
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
         * レンダラーの認証済みコンテキストで式を評価する。
         *
         * メインプロセスからは `BrowserWindow` 越しにしかレンダラーへ届かないので、
         * 二段の `executeJavaScript` を挟む。`expression` は
         * **レンダラー側で評価される式の文字列**（Promise を返してよい）。
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
                    if (wins.length === 0) throw new Error('Arena のウィンドウが見つからない');
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
                throw new Error(`レンダラーでの評価に失敗: ${text}`);
            }
            return result.result?.value;
        },

        close() {
            ws.close();
        },
    };
}
