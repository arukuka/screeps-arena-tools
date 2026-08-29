/**
 * 例: Macro のゾーン配分を描くプラグイン。
 *
 * 本体は「誰の試合でも読める情報」だけを描く。ゾーン配分のような
 * 自分のボットにしか無い概念はここで足す。**本体の fork は要らない。**
 *
 * ------------------------------------------------------------------
 * ボット側の仕込み
 * ------------------------------------------------------------------
 * 毎 Tick、あるいは配分を決め直した Tick だけ、次の 2 行を出す。
 *
 * ```js
 * // 陣営ごとのゾーン配分（自陣ぶんだけ分かれば足りるなら片側でよい）
 * console.log(`@zones ${JSON.stringify({ 0: [3, 2, 1] })}`);
 * // creep がどのゾーンを担当しているか
 * console.log(`@creepZone ${JSON.stringify({ "335": 0, "340": 2 })}`);
 * ```
 *
 * ------------------------------------------------------------------
 * 使い方
 * ------------------------------------------------------------------
 * ```
 * arena-replay view --plugins ./examples/plugins
 * ```
 *
 * 自分のリポジトリに置いたままでもよい:
 * ```
 * arena-replay view --plugins ~/my-bot/arena-plugins
 * ```
 *
 * `@zones` を含まないログ（他人の試合）では、このプラグインは自動的に寝る。
 */

const ZONE_NAMES = ["DEFENSE", "CENTER", "ASSAULT"];
const ZONE_COLOR = ["#8ee0ff", "#ffd166", "#ff5d8f"];

/** メタ情報は必ず配列で入る（同じ Tick に複数回出せるため）。最後の 1 件を採る */
const latest = (ext, ns) => {
    const values = ext?.[ns];
    return Array.isArray(values) && values.length > 0 ? values[values.length - 1] : null;
};

/**
 * 直近に判明しているゾーン情報を遡って探す。
 *
 * 配分は「決め直した Tick だけ」出す運用もあるので、
 * その Tick に無ければ手前を見に行かないと大半の Tick で何も出せない。
 */
function lookback(api, ns, maxBack = 200) {
    for (let k = api.tick; k >= Math.max(0, api.tick - maxBack); k--) {
        const found = latest(api.extAt(k), ns);
        if (found !== null) return found;
    }
    return null;
}

export default {
    name: "macro-zones",

    // このどちらかがログに無ければ、本体が自動的にこのプラグインを無効にする
    requires: ["zones", "creepZone"],

    toggles: [{ id: "macro-zones", label: "ゾーン", default: true }],

    legend: ZONE_NAMES.map((label, i) => ({ color: ZONE_COLOR[i], label })),

    /** creep の担当ゾーンを、円の外側にリングで重ねる */
    drawOverlay(api) {
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
            title: "Macro ゾーン配分",
            render(el, api) {
                const zones = lookback(api, "zones");
                if (zones === null) {
                    el.innerHTML = '<p class="hint">この Tick までに @zones が無い</p>';
                    return;
                }
                el.innerHTML = Object.entries(zones)
                    .map(([side, ratios]) => {
                        const total = ratios.reduce((a, b) => a + b, 0) || 1;
                        const name = api.doc.meta.players[Number(side)]?.username ?? `side ${side}`;
                        const bars = ratios
                            .map((v, i) => {
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
