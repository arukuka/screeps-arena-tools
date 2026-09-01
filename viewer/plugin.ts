/**
 * Viewer plugin host and runtime extension system.
 *
 * ------------------------------------------------------------------
 * Purpose
 * ------------------------------------------------------------------
 * The core viewer renders only universal game information present in every match.
 * Bot-specific state (squad assignments, tactical modes, evaluations) is transported
 * via console logs (`src/extensions.ts`) and rendered by standalone plugin scripts.
 *
 * ------------------------------------------------------------------
 * Plugin Structure
 * ------------------------------------------------------------------
 * An ES module with a default exported object. All fields are optional.
 *
 * ```js
 * export default {
 *     name: "macro-zones",
 *     requires: ["zones"],                       // Required namespaces; sleeps if missing in log
 *     toggles: [{ id: "zones", label: "Zones", default: true }],
 *     legend: [{ color: "#8ee0ff", label: "DEFENSE" }],
 *     drawOverlay(api) { ... },                  // Canvas overlay on board
 *     panels: [{ id: "zones", title: "Zones", render(el, api) { ... } }],
 * };
 * ```
 */

import type { ArenaPlugin, PluginApi, PluginLegend, PluginPanel, PluginToggle, ReplayDoc } from "../src/types.js";

export interface PluginHostEntry {
    id: string;
    plugin: ArenaPlugin | null;
    active: boolean;
    error: string | null;
    missing?: string[];
}

/**
 * Host managing loaded plugins, lifecycle, fault isolation, and dispatch.
 */
export class PluginHost {
    entries: PluginHostEntry[];
    toggleState: Map<string, boolean>;
    onError: ((id: string, message: string) => void) | null;

    constructor() {
        this.entries = [];
        this.toggleState = new Map();
        this.onError = null;
    }

    /**
     * Load a plugin from a same-origin path.
     *
     * External origins are rejected for security. Serve plugins locally using `--plugins <dir>`.
     *
     * @param url
     */
    async load(url: string): Promise<ArenaPlugin | null> {
        const id = url;
        try {
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith("//")) {
                throw new Error("plugins must use same-origin paths (serve with --plugins <dir>)");
            }
            const mod = await import(url);
            const plugin = (mod.default ?? mod) as ArenaPlugin;
            if (!plugin || typeof plugin !== "object") throw new Error("default export is not an object");

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
     * Activate or sleep plugins based on available metadata namespaces in a match replay.
     *
     * @param doc
     */
    applyDocument(doc: Partial<ReplayDoc>): void {
        const available = new Set(Object.keys(doc?.extensions ?? {}));
        for (const entry of this.entries) {
            if (entry.plugin === null) continue;
            const requires = entry.plugin.requires ?? [];
            entry.active = requires.length === 0 || requires.some((ns) => available.has(ns));
            entry.missing = requires.filter((ns) => !available.has(ns));
        }
    }

    /** Iterate over active, non-faulted plugins. */
    *active(): Generator<ArenaPlugin, void, unknown> {
        for (const entry of this.entries) {
            if (entry.active && entry.plugin !== null) yield entry.plugin;
        }
    }

    isToggled(id: string): boolean {
        return this.toggleState.get(id) !== false;
    }

    setToggle(id: string, value: boolean): void {
        this.toggleState.set(id, value);
    }

    /** Aggregate all toggle definitions across active plugins. */
    toggles(): PluginToggle[] {
        const out: PluginToggle[] = [];
        for (const plugin of this.active()) {
            for (const t of plugin.toggles ?? []) out.push({ ...t, plugin: plugin.name });
        }
        return out;
    }

    /** Aggregate all legend entries across active plugins. */
    legend(): PluginLegend[] {
        const out: PluginLegend[] = [];
        for (const plugin of this.active()) {
            for (const item of plugin.legend ?? []) out.push(item);
        }
        return out;
    }

    /** Aggregate all panel definitions across active plugins. */
    panels(): PluginPanel[] {
        const out: PluginPanel[] = [];
        for (const plugin of this.active()) {
            for (const panel of plugin.panels ?? []) out.push({ ...panel, plugin: plugin.name });
        }
        return out;
    }

    /**
     * Execute board overlay rendering across active plugins.
     * @param api
     */
    drawOverlay(api: PluginApi): void {
        for (const plugin of this.active()) {
            if (typeof plugin.drawOverlay !== "function") continue;
            this.guard(plugin, () => plugin.drawOverlay!(api));
        }
    }

    /** Safely execute plugin callbacks with error isolation. */
    guard<T>(plugin: ArenaPlugin, fn: () => T): T | undefined {
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
 * Extract plugin paths from URL query string `?plugin=...`.
 * @param search
 */
export function pluginsFromQuery(search: string): string[] {
    return new URLSearchParams(search).getAll("plugin").filter((v) => v !== "");
}
