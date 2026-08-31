# Plugins

The core viewer renders **only universal game information present in any match** (terrain, structures, creeps, actions, energy, and flags).
It deliberately avoids built-in UI for bot-specific logic such as squad assignments, strategy states, or tactical evaluations.

This design avoids cluttering UI when viewing matches between other players and prevents developers from being trapped in maintenance loops maintaining forks.

Instead, custom internal state flows through this pipeline:

```
Bot executes console.log("@zones {...}")
        ↓  Screeps: Arena standard console log API
   fetch / convert places data into tick.e.zones
        ↓
   Standalone plugin files render custom visuals and panels
```

**No changes are required to the replay format, fetcher, or core viewer.**

---

## 1. Bot Side — Emitting Metadata

Lines starting with `@` are treated as metadata lines:

```
@<namespace> <payload>
```

```js
// Team zone distribution
console.log(`@zones ${JSON.stringify({ 0: [3, 2, 1], 1: [1, 1, 4] })}`);

// Creep zone assignment
console.log(`@creepZone ${JSON.stringify({ "335": 0, "340": 2 })}`);

// Non-JSON string payloads are supported
console.log("@mode swarm");

// Marker flags without values
console.log("@flagCaptured");
```

| Field | Description |
| --- | --- |
| Namespace | `[A-Za-z0-9_.:-]+`. Key used by plugins to locate their data |
| Payload | Parsed as JSON if valid; stored as a raw string otherwise |
| No value | Evaluates to `true` |

**Values are always stored in arrays.** Because multiple lines with the same namespace can occur in a single tick, values are normalized into an array (even for single occurrences) to simplify consumer code.

```jsonc
// tick.e
{ "zones": [ { "0": [3,2,1], "1": [1,1,4] } ], "mode": ["swarm"] }
```

Metadata lines are **automatically stripped from human-readable console logs**, ensuring telemetry does not obscure standard debug logs.

Characters like `@` inside sentences (e.g. `foo@example.com`) are ignored; only leading `@` tokens are processed.

### Emission Frequency

Emitting metadata every tick is unnecessary. Emitting updates only on decision changes and letting plugins look backward is significantly more efficient (see `lookback` in [`examples/plugins/macro-zones.js`](../examples/plugins/macro-zones.js)).

---

## 2. Plugin Side — Rendering

Plugins are ES modules exporting a default configuration object. **All properties are optional.**

```js
export default {
    name: "macro-zones",

    // Required namespaces. If none exist in the log, the plugin is automatically disabled
    requires: ["zones", "creepZone"],

    // Toggle controls added to the bottom transport bar
    toggles: [{ id: "macro-zones", label: "Zones", default: true }],

    // Legend entries
    legend: [{ color: "#8ee0ff", label: "DEFENSE" }],

    // Canvas overlay on the game board (called after core rendering)
    drawOverlay(api) {
        if (!api.isToggled("macro-zones")) return;
        const { ctx, cell } = api;
        for (const creep of api.state.creeps.values()) {
            ctx.beginPath();
            ctx.arc(creep.x * cell + cell / 2, creep.y * cell + cell / 2, cell * 1.35, 0, Math.PI * 2);
            ctx.strokeStyle = "#8ee0ff";
            ctx.stroke();
        }
    },

    // Custom inspector panels added to the right sidebar
    panels: [
        {
            id: "macro-zones",
            title: "Macro Zone Allocation",
            render(el, api) {
                el.textContent = JSON.stringify(api.ext?.zones ?? null);
            },
        },
    ],
};
```

### `api` Context Object

Passed to `drawOverlay` and `panels[].render`:

| Property | Description |
| --- | --- |
| `ctx` | Board `CanvasRenderingContext2D` |
| `cell` | Pixel size per grid cell |
| `doc` | Replay document (`meta`, `objects`, `logs`, etc.) |
| `timeline` | Timeline object with `objectById` and keyframes |
| `state` | Current tick state (`creeps`, `struct`, `owner`, `actions`) |
| `tick` / `index` | Tick number / index in `doc.ticks` |
| `ext` | Metadata object for the current tick (or `null`) |
| `extAt(k)` | Indexed metadata for any tick `k` (fast backward lookups) |
| `selected` | Currently selected creep ID (or `null`) |
| `sideColor(side)` / `fade(hex, a)` | Palette helper functions matching core styles |
| `isToggled(id)` | Current boolean state of a registered toggle |

---

## 3. Loading Plugins

```bash
arena-tools view --plugins ~/my-bot/arena-plugins
```

All `*.js` files in the specified directory are loaded automatically. Plugins can stay in your bot's own repository without copying into `screeps-arena-tools`.

Plugins can also be specified via URL queries:

```
http://localhost:5544/?plugin=/plugins/macro-zones.js
```

---

## Security & Runtime Isolation

- **Same-origin only:** The viewer refuses to load scripts from external origins to prevent cross-site execution when opening shared links. Serve custom plugins with `--plugins`.
- **Fault isolation:** If a plugin throws an error, it is automatically disabled with an error report in the sidebar without halting playback or crashing other components.
- **Dependency checks:** If `requires` namespaces are missing in a match, the plugin is disabled silently and displayed as inactive in the sidebar.

---

## Example

[`examples/plugins/macro-zones.js`](../examples/plugins/macro-zones.js) — Renders macro zone allocations as creep overlay rings and inspector bar charts using `@zones` and `@creepZone`.
