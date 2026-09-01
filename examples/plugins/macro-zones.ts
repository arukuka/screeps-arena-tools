/**
 * Example plugin: Visualizes macro zone assignments.
 *
 * The core viewer renders universal game data. Custom bot-specific concepts
 * like zone allocations are added here without forking the codebase.
 *
 * ------------------------------------------------------------------
 * Bot-side telemetry
 * ------------------------------------------------------------------
 * Emit these lines periodically or whenever allocations change:
 *
 * ```js
 * // Team zone ratios (can emit for own side only)
 * console.log(`@zones ${JSON.stringify({ 0: [3, 2, 1] })}`);
 * // Creep zone assignment
 * console.log(`@creepZone ${JSON.stringify({ "335": 0, "340": 2 })}`);
 * ```
 *
 * ------------------------------------------------------------------
 * Usage
 * ------------------------------------------------------------------
 * ```bash
 * arena-tools view --plugins ./examples/plugins
 * ```
 *
 * Or load from your bot's repository:
 * ```bash
 * arena-tools view --plugins ~/my-bot/arena-plugins
 * ```
 *
 * In matches without `@zones`, this plugin automatically sleeps.
 */

import type { ArenaPlugin, PluginApi } from "../../src/types.js";

const ZONE_NAMES = ["DEFENSE", "CENTER", "ASSAULT"];
const ZONE_COLOR = ["#8ee0ff", "#ffd166", "#ff5d8f"];

/** Metadata is always an array; extract the latest entry. */
const latest = (ext: Record<string, unknown[]> | null | undefined, ns: string): any => {
    const values = ext?.[ns];
    return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : null;
};

/**
 * Look backward for recent metadata if not present on the exact current tick.
 */
function lookback(api: PluginApi, ns: string, maxBack = 200): any {
    for (let k = api.tick; k >= Math.max(0, api.tick - maxBack); k--) {
        const found = latest(api.extAt(k), ns);
        if (found !== null) return found;
    }
    return null;
}

const plugin: ArenaPlugin = {
    name: "macro-zones",

    // Automatically disabled if neither namespace appears in logs
    requires: ["zones", "creepZone"],

    toggles: [{ id: "macro-zones", label: "Zones", default: true }],

    legend: ZONE_NAMES.map((label, i) => ({ color: ZONE_COLOR[i], label })),

    /** Render creep zone assignments as colored outer rings */
    drawOverlay(api: PluginApi): void {
        if (!api.isToggled("macro-zones")) return;
        const assign = lookback(api, "creepZone");
        if (assign === null) return;

        const { ctx, cell } = api;
        for (const creep of api.state.creeps.values()) {
            const zone = assign[creep.id];
            if (zone === undefined || zone === null) continue;
            ctx.beginPath();
            ctx.arc(creep.x * cell + cell / 2, creep.y * cell + cell / 2, cell * 1.35, 0, Math.PI * 2);
            ctx.strokeStyle = ZONE_COLOR[zone] ?? "#ffffff";
            ctx.lineWidth = Math.max(1, cell * 0.16);
            ctx.stroke();
        }
    },

    panels: [
        {
            id: "macro-zones",
            title: "Macro Zone Allocation",
            render(el: HTMLElement, api: PluginApi): void {
                const zones = lookback(api, "zones");
                if (zones === null) {
                    el.innerHTML = '<p class="hint">No @zones before this tick</p>';
                    return;
                }
                el.innerHTML = Object.entries(zones)
                    .map(([side, ratios]: [string, any]) => {
                        const ratioArr = Array.isArray(ratios) ? ratios : [];
                        const total = ratioArr.reduce((a: number, b: number) => a + b, 0) || 1;
                        const name = api.doc.meta.players[Number(side)]?.username ?? `side ${side}`;
                        const bars = ratioArr
                            .map((v: number, i: number) => {
                                const pct = ((v / total) * 100).toFixed(0);
                                return `<div style="display:grid;grid-template-columns:62px 1fr 42px;gap:2px 6px;align-items:center">
                                    <span style="color:${ZONE_COLOR[i]}">${ZONE_NAMES[i] ?? i}</span>
                                    <span class="bar"><span style="width:${pct}%;background:${ZONE_COLOR[i]}"></span></span>
                                    <span>${pct}%</span>
                                </div>`;
                            })
                            .join("");
                        return `<div class="side-block"><div class="side-name" style="color:${api.sideColor(Number(side))}">${name}</div>${bars}</div>`;
                    })
                    .join("");
            },
        },
    ],
};

export default plugin;
