/**
 * ビューアの拡張機構。
 *
 * ------------------------------------------------------------------
 * ねらい
 * ------------------------------------------------------------------
 * 本体は「誰の試合でも同じように見える情報」だけを描く。
 * 自分のボットの内部状態（役割分担・作戦モード・評価値）は人それぞれなので、
 * 本体に入れると他人には無意味な UI が増えるし、入れた人は fork の維持に縛られる。
 *
 * そこで内部状態は
 *
 *   1. ボットが `console.log("@<名前空間> <JSON>")` で吐き（`src/extensions.js`）
 *   2. 取得時に `tick.e.<名前空間>` へ載り
 *   3. **外部ファイルとして置いたプラグイン**がそれを読んで描く
 *
 * という経路を通る。本体のコードにもリプレイ形式にも手を入れる必要がない。
 *
 * ------------------------------------------------------------------
 * プラグインの書き方
 * ------------------------------------------------------------------
 * ES モジュールで、既定エクスポートに以下の形のオブジェクトを置く。
 * すべての項目が任意。
 *
 * ```js
 * export default {
 *     name: "macro-zones",
 *     requires: ["zones"],                       // 必要な名前空間。無いログでは自動的に無効
 *     toggles: [{ id: "zones", label: "ゾーン", default: true }],
 *     legend: [{ color: "#8ee0ff", label: "DEFENSE" }],
 *     drawOverlay(api) { ... },                  // 盤面へ重ねて描く
 *     panels: [{ id: "zones", title: "ゾーン配分", render(el, api) { ... } }],
 * };
 * ```
 *
 * 置き場所は自分のディレクトリでよい:
 *
 * ```
 * arena-replay view --plugins ~/my-bot/arena-plugins
 * ```
 */

/**
 * 読み込んだプラグインの管理。
 *
 * 1 つのプラグインが投げた例外で盤面ごと止まると原因が分からなくなるので、
 * 呼び出しはすべて包んで、落ちたプラグインだけを切り離す。
 */
export class PluginHost {
    constructor() {
        /** @type {Array<{ id: string, plugin: any, active: boolean, error: string | null, missing?: string[] }>} */
        this.entries = [];
        /** トグルの状態。`toggles[].id` → boolean */
        this.toggleState = new Map();
        this.onError = null;
    }

    /**
     * プラグインを読み込む。
     *
     * 読めるのは**同一オリジンのパス**だけ。外部 URL を許すと、
     * 共有されたリンクを開いただけで任意のスクリプトが走ることになる。
     * 自分のプラグインは `--plugins <dir>` で配ること。
     *
     * @param {string} url
     */
    async load(url) {
        const id = url;
        try {
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith("//")) {
                throw new Error("プラグインは同一オリジンのパスのみ（--plugins <dir> で配ること）");
            }
            const mod = await import(url);
            const plugin = mod.default ?? mod;
            if (!plugin || typeof plugin !== "object") throw new Error("既定エクスポートがオブジェクトでない");

            for (const t of plugin.toggles ?? []) {
                if (!this.toggleState.has(t.id)) this.toggleState.set(t.id, t.default !== false);
            }
            this.entries.push({ id, plugin, active: true, error: null });
            return plugin;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.entries.push({ id, plugin: null, active: false, error: message });
            this.onError?.(id, message);
            return null;
        }
    }

    /**
     * 読み込んだリプレイに対して、各プラグインを有効にするか決める。
     *
     * `requires` の名前空間がログに 1 つも無ければ、そのプラグインは黙って寝かせる
     * （他人の試合を開いたときに空のパネルが並ばないように）。
     *
     * @param {any} doc
     */
    applyDocument(doc) {
        const available = new Set(Object.keys(doc?.extensions ?? {}));
        for (const entry of this.entries) {
            if (entry.plugin === null) continue;
            const requires = entry.plugin.requires ?? [];
            entry.active = requires.length === 0 || requires.some((ns) => available.has(ns));
            entry.missing = requires.filter((ns) => !available.has(ns));
        }
    }

    /** 有効なプラグインだけを回す */
    *active() {
        for (const entry of this.entries) {
            if (entry.active && entry.plugin !== null) yield entry.plugin;
        }
    }

    isToggled(id) {
        return this.toggleState.get(id) !== false;
    }

    setToggle(id, value) {
        this.toggleState.set(id, value);
    }

    /** 全プラグインのトグル定義を集める */
    toggles() {
        const out = [];
        for (const plugin of this.active()) {
            for (const t of plugin.toggles ?? []) out.push({ ...t, plugin: plugin.name });
        }
        return out;
    }

    /** 全プラグインの凡例を集める */
    legend() {
        const out = [];
        for (const plugin of this.active()) {
            for (const item of plugin.legend ?? []) out.push(item);
        }
        return out;
    }

    /** 全プラグインのパネル定義を集める */
    panels() {
        const out = [];
        for (const plugin of this.active()) {
            for (const panel of plugin.panels ?? []) out.push({ ...panel, plugin: plugin.name });
        }
        return out;
    }

    /**
     * 盤面へのオーバーレイ描画を回す。
     * @param {any} api
     */
    drawOverlay(api) {
        for (const plugin of this.active()) {
            if (typeof plugin.drawOverlay !== "function") continue;
            this.guard(plugin, () => plugin.drawOverlay(api));
        }
    }

    /** 例外を出したプラグインは切り離して、以降呼ばない */
    guard(plugin, fn) {
        try {
            return fn();
        } catch (err) {
            const entry = this.entries.find((e) => e.plugin === plugin);
            if (entry !== undefined) {
                entry.active = false;
                entry.error = err instanceof Error ? err.message : String(err);
                this.onError?.(entry.id, entry.error);
            }
            return undefined;
        }
    }
}

/**
 * URL の `?plugin=` からプラグインのパスを集める。複数指定してよい。
 * @param {string} search
 */
export function pluginsFromQuery(search) {
    return new URLSearchParams(search).getAll("plugin").filter((v) => v !== "");
}
