# フィクスチャ

実試合 [`XTTCQ7DA4T`](https://arena.screeps.com/game/XTTCQ7DA4T)（2026-08-28, arukuka vs Opponent, 2000 Tick, 引き分け）から作ったもの。

| ファイル | |
| --- | --- |
| `XTTCQ7DA4T.raw-slice.json` | API が返す**生の形**。先頭 9 Tick 分だけを切り出したもの。<br>`logs["100"]["3"]` にだけ、メタ情報の経路を試すための行を**こちらで足している**（実際の試合にコンソール出力は無かった） |
| `XTTCQ7DA4T.replay.json.gz` | 上の全 2000 Tick 分を正規化したもの（29 KB） |

生の形は 1 Tick ごとに全オブジェクトを繰り返す。`raw-slice` を `jq` で覗くと、
9 Tick 分で既に 528KB あることが確かめられる（全 2001 Tick では 285MB）。
