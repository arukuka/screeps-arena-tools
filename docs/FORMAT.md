# Replay Document 形式

`arena-tools fetch` / `convert` が書き出す正規化リプレイの形。
素の JSON なので、ビューアがブラウザでそのまま読める。`*.json.gz` は gzip をかけただけ。

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

## 設計方針

1. **動かないものは 1 回だけ。** 構造物の種類・座標・最大 HP は `objects` に初出時のみ。
2. **変わったものだけ Tick に。** 位置・HP・エネルギー・所有者の変化だけを `ticks` に。
3. **配列で持つ。** 毎 Tick オブジェクトのキーを繰り返すと同じ情報でファイルが 3 倍になる。
   並びの定義はこの文書が唯一の出典。
4. **素の JSON。** 独自バイナリにしない。`jq` で覗けることに価値がある。

API が返す生データは**毎 Tick の完全スナップショット**なので、
この畳み込みだけで 285MB が 0.5MB になる（実測 `XTTCQ7DA4T`）。

## `meta`

| 鍵 | 内容 |
| --- | --- |
| `shortId` | `XTTCQ7DA4T`。共有 URL の末尾 |
| `gameId` | 本物の MongoDB ObjectId。リプレイ API が要求する側 |
| `url` | 共有 URL |
| `fetchedAt` / `createdAt` | 取得時刻 / 対戦日時（ISO8601） |
| `arenaId` | Arena の識別子 |
| `ticks` / `ticksLimit` | 実際の Tick 数 / 上限 |
| `width` / `height` | 盤面の大きさ。地形文字列の長さの平方根から決まる |
| `players[]` | `{ slot, side, username, userId, color, codeVersion }` |
| `result` | `{ winner, winnerName, draw, status, raw }` |

**`players` の対応付けに注意。** リプレイ中のオブジェクトは所有者を `"player1"` としか言わず、
`gameData.game.users` は別の順序で並んでいることがある。
`usersCode[i]` が「スロット `i+1` の提出コード」なので、そこから `codes[].user` を辿って解決している。

**`result.winner` は引き分けのとき `0.5`。** 整数でなければ引き分けとして `draw: true` にし、
生値を `raw` に残す。

## `terrain`

`<文字><個数>` の連結。row-major。

| 文字 | |
| --- | --- |
| `p` | plain |
| `w` | wall |
| `s` | swamp |

例: `"p3w3p1s2"` = plain×3, wall×3, plain×1, swamp×2

## `objects`

creep 以外のすべて。**初出時の状態**。

```jsonc
{
  "id": "121", "kind": "spawn", "side": 0, "x": 49, "y": 4,
  "hits": 3000, "hitsMax": 3000,
  "energy": 500, "energyCapacity": 1000,
  "controlledBy": null
}
```

`kind` は API の `type` をそのまま使う: `spawn` / `extension` / `rampart` / `constructedWall` / `flag`。
`side` は `0` / `1`、中立は `null`。
`controlledBy` は rampart が属する flag の id（例 `"rampartsLeft"`）。

## `ticks`

1 要素が 1 Tick。**その Tick 終了時点**の変化ぶんだけを持つ。変化が無い項目は鍵ごと省く。

| 鍵 | 内容 | 形 |
| --- | --- | --- |
| `k` | Tick 番号 | `number` |
| `n` | 生まれた creep | `[id, side, x, y, hits, hitsMax, body, spawning]` |
| `u` | creep の変化 | `[id, x, y, hits, fatigue, spawning]` |
| `b` | body 構成の変化 | `[id, body]` |
| `x` | 消えた creep の id | `string[]` |
| `a` | この Tick の行動 | `[id, code, x?, y?]` |
| `s` | 構造物の変化 | `[id, hits, energy]` |
| `w` | 所有者の変化 | `[id, side \| null]` |
| `e` | ログ由来のメタ情報 | `{ "<名前空間>": unknown[] }` |

### `body`

パーツを**並び順のまま**ランレングスにした文字列。`[move, move, attack]` → `"m2a1"`。

| 文字 | パーツ |
| --- | --- |
| `m` | move |
| `w` | work |
| `c` | carry |
| `a` | attack |
| `r` | ranged_attack |
| `t` | tough |
| `h` | heal |

並びを保つのは、Screeps ではダメージが**前方のパーツから**入るため。
「tough が先頭に何枚あるか」が読めなくなると意味が無い。

### `a` の行動コード

| コード | `actionLog` の鍵 | |
| --- | --- | --- |
| `a` | `attack` | 近接攻撃 |
| `r` | `rangedAttack` | 遠距離攻撃 |
| `R` | `rangedMassAttack` | 範囲攻撃（対象座標なし） |
| `h` | `heal` | 回復 |
| `H` | `rangedHeal` | 遠距離回復 |
| `A` | `attacked` | **攻撃された**側の記録 |
| `E` | `healed` | **回復された**側の記録 |

大文字 `A` / `E` は受けた側の記録で、撃った側の記録と重複する。
ビューアは線が二重にならないよう、既定では描かない。

`rangedMassAttack` は対象を持たないので `[id, "R"]` の 2 要素になる。

### 破壊された構造物

配列から消えるだけだと「そこに何も無い」と区別が付かないので、
**`hits: 0` の墓標**を `s` に残す。跡地が空くこと自体が戦況の情報になる。

## `logs` と `e`

`logs` は Tick 番号 → コンソール出力の本文。**メタ情報行は取り除かれている**（`e` に入る）。
毎 Tick メタ情報を吐くボットだと、残したままではログ欄が埋まって本来の出力が読めなくなるため。

メタ情報の書式と `extensions` 索引については [`PLUGINS.md`](PLUGINS.md) を参照。

## 検証

この形式が生データと等価であることは `test/normalize.test.js` で確認している。
実試合 `XTTCQ7DA4T` の全 Tick について、差分から復元した盤面を生スナップショットと
突き合わせている（696,435 エンティティ、差異 0）。
