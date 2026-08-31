# Test Fixtures

Generated from match [`XTTCQ7DA4T`](https://arena.screeps.com/game/XTTCQ7DA4T) (2026-08-28, arukuka vs Opponent, 2000 ticks, draw).

| File | Description |
| --- | --- |
| `XTTCQ7DA4T.raw-slice.json` | **Raw API response format** containing the first 9 ticks.<br>Includes injected sample metadata lines in `logs["100"]["3"]` for testing parser pipelines (the original match had no console output). |
| `XTTCQ7DA4T.replay.json.gz` | Normalized replay of all 2000 ticks (29 KB). |

Raw snapshots repeat all entities every tick. Inspecting `raw-slice` with `jq` shows 9 ticks alone taking 528 KB (all 2001 ticks equal ~285 MB).
