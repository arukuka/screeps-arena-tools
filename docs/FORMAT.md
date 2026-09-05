# Replay Document Format

The normalized replay format output by `screeps-arena-tools fetch` / `convert`.
Because it is standard JSON, browsers and tools can read it directly. `*.json.gz` is standard gzip compression.

```jsonc
{
  "format": "screeps-arena-replay",
  "version": 1,
  "meta": { ... },
  "terrain": "w100p3w2...",
  "objects": [ ... ],
  "ticks":   [ ... ],
  "logs":    { "600": "tick 600 planning" },
  "extensions": { "zones": { "count": 199, "firstTick": 10, "lastTick": 1990 } }
}
```

## Design Principles

1. **Static data is stored once.** Structure types, initial positions, and max HP appear only once in `objects`.
2. **Only deltas per tick.** Position, HP, energy, and ownership changes are recorded in `ticks`.
3. **Compact arrays.** Repeating object keys per tick triples file sizes. Array schemas are strictly documented here.
4. **Plain JSON.** No proprietary binary formats. Human inspectability with tools like `jq` is a core goal.

Because the raw API returns **full state snapshots per tick**, this delta encoding reduces match size from 285MB to 0.5MB (measured on `XTTCQ7DA4T`).

## `meta`

| Key | Description |
| --- | --- |
| `shortId` | `XTTCQ7DA4T`. Trailing component of the share URL |
| `gameId` | MongoDB ObjectId required by the replay API |
| `url` | Match share URL |
| `fetchedAt` / `createdAt` | Retrieval timestamp / match timestamp (ISO8601) |
| `arenaId` | Arena type identifier |
| `ticks` / `ticksLimit` | Actual tick count / tick limit |
| `width` / `height` | Board dimensions (derived from square root of terrain length) |
| `players[]` | `{ slot, side, username, userId, color, codeVersion }` |
| `result` | `{ winner, winnerName, draw, status, raw }` |
| `logChunks` | `{ requested, fetched, failed, errors[] }` or `null`. Console log retrieval statistics — see below |

**Player Slot Mapping:** Replay entity objects refer to owners only as `"player1"` or `"player2"`, while `gameData.game.users` may have a different order.
For submitted code pairs `usersCode` (`[codeA, codeB]`), if `firstPlayerIndex` is `1`, board slots (`player1` / `player2`) are inverted (matching official client `getGamePlayers` logic). Players are mapped accordingly via `codes[].user`.

**Match Winner Resolution:** The raw API `result.winner` value (`raw`) represents score from the perspective of `usersCode[0]`:
- `raw === 1`: `usersCode[0]` won
- `raw === 0`: `usersCode[1]` won
- `raw === 0.5`: Draw (`draw: true`, `winner: null`)

The tool maps this to board slot indices (`players` / `side` 0 or 1) in `result.winner` and `result.winnerName`.

## `terrain`

Run-length encoded `<character><count>` pairs, row-major order.

| Character | Terrain |
| --- | --- |
| `p` | plain |
| `w` | wall |
| `s` | swamp |

Example: `"p3w3p1s2"` = plain×3, wall×3, plain×1, swamp×2

## `objects`

All non-creep objects in their **initial state upon appearance**:

```jsonc
{
  "id": "121", "kind": "spawn", "side": 0, "x": 49, "y": 4,
  "hits": 3000, "hitsMax": 3000,
  "energy": 500, "energyCapacity": 1000,
  "controlledBy": null
}
```

`kind` uses the API `type` values directly: `spawn`, `extension`, `rampart`, `constructedWall`, `flag`.
`side` is `0` or `1`, or `null` for neutral.
`controlledBy` indicates the flag id controlling a rampart (e.g. `"rampartsLeft"`).

## `ticks`

Array where each item represents one tick's deltas **at the end of that tick**. Unchanged keys are omitted.

| Key | Description | Type / Schema |
| --- | --- | --- |
| `k` | Tick number | `number` |
| `n` | Spawned creeps | `[id, side, x, y, hits, hitsMax, body, spawning]` |
| `u` | Creep updates | `[id, x, y, hits, fatigue, spawning]` |
| `b` | Creep body part updates | `[id, body]` |
| `x` | Removed creep IDs | `string[]` |
| `a` | Actions this tick | `[id, code, x?, y?]` |
| `s` | Structure updates | `[id, hits, energy]` |
| `w` | Owner changes | `[id, side \| null]` |
| `e` | Metadata extracted from logs | `{ "<namespace>": unknown[] }` |

### `body`

Run-length encoded string **preserving original part order**: `[move, move, attack]` → `"m2a1"`.

| Character | Body Part |
| --- | --- |
| `m` | move |
| `w` | work |
| `c` | carry |
| `a` | attack |
| `r` | ranged_attack |
| `t` | tough |
| `h` | heal |

Preserving order is essential because Screeps damages parts from front to back. Knowing how many tough parts remain at the front is critical for combat analysis.

### Action Codes (`a`)

| Code | `actionLog` Key | Description |
| --- | --- | --- |
| `a` | `attack` | Melee attack |
| `r` | `rangedAttack` | Ranged attack |
| `R` | `rangedMassAttack` | Area attack (no target coordinates) |
| `h` | `heal` | Melee heal |
| `H` | `rangedHeal` | Ranged heal |
| `A` | `attacked` | Target received attack (incoming) |
| `E` | `healed` | Target received heal (incoming) |

Uppercase codes `A` / `E` represent incoming effects on target units and mirror the initiator's log. Viewers typically omit them to avoid duplicate action lines.

`rangedMassAttack` has no target coordinates and is represented as a 2-element tuple `[id, "R"]`.

### Destroyed Structures

To distinguish destroyed structures from absent entities, **`hits: 0` markers** are retained in `s`. Vacated positions provide meaningful tactical data.

## `logs` and `e`

`logs` maps tick number to human-readable console output. **Metadata lines are stripped** from `logs` and stored in `e`. This prevents bots logging per-tick telemetry from flooding the human log panel.

See [`PLUGINS.md`](PLUGINS.md) for metadata format and `extensions` indexing.

### `meta.logChunks` — telling an empty log from a failed fetch

Console logs are retrieved per 100-tick chunk from a separate endpoint
(`/api/game/{gameId}/log/{tick}`) that can fail independently of the replay frames.
When it does, `logs` and every `ticks[].e` come back empty — which looks exactly
like a match where the bot logged nothing.

`meta.logChunks` records the outcome so the two cases stay distinguishable:

```jsonc
"logChunks": { "requested": 11, "fetched": 0, "failed": 11, "errors": ["404 Not Found"] }
```

| Key | Description |
| --- | --- |
| `requested` | Chunks the fetcher attempted |
| `fetched` | Chunks retrieved successfully |
| `failed` | Chunks that failed |
| `errors` | Distinct failure reasons, capped at 5 entries |

`null` means no chunk was ever attempted (for example, a document normalized from
a raw dump that carried no `logs` key at all).

**This matters for verification workflows.** Bot telemetry emitted as
`@namespace <payload>` travels through this endpoint, so a silent failure here
silently empties the telemetry channel. `fetch` and `sync` print a warning when
`failed > 0`.

## Verification

Lossless equivalence with raw game snapshots is verified in `test/normalize.test.js` against all 2001 ticks of match `XTTCQ7DA4T` (696,435 entities compared with zero discrepancies).
