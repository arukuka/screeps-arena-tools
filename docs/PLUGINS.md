# プラグイン

ビューア本体が描くのは **誰の試合でも読み取れる情報だけ**（地形・構造物・creep・行動・エネルギー・flag）。
役割分担や作戦モードのような、自分のボットにしか無い概念は本体に入れない。

理由は 2 つ。他人の試合を開いたときに無意味な UI が並ぶこと。そして
入れた人が **fork の維持に縛られる**こと。

代わりに、内部状態は次の経路を通る。

```
ボットの console.log("@zones {...}")
        ↓  Screeps: Arena が誰にでも返すコンソールログ API
   fetch / convert が tick.e.zones へ載せる
        ↓
   外部ファイルとして置いたプラグインが描く
```

**リプレイ形式にもフェッチャにもビューア本体にも手を入れない。**

---

## 1. ボット側 — メタ情報を吐く

行頭が `@` で始まる 1 行がメタ情報として扱われる。

```
@<名前空間> <ペイロード>
```

```js
// 陣営ごとのゾーン配分
console.log(`@zones ${JSON.stringify({ 0: [3, 2, 1], 1: [1, 1, 4] })}`);

// creep がどのゾーンを担当しているか
console.log(`@creepZone ${JSON.stringify({ "335": 0, "340": 2 })}`);

// JSON でなくてもよい
console.log("@mode swarm");

// 値なしの印
console.log("@flagCaptured");
```

| | |
| --- | --- |
| 名前空間 | `[A-Za-z0-9_.:-]+`。プラグインが自分の取り分を見つける鍵 |
| ペイロード | JSON として読めれば構造として、読めなければ文字列として保持 |
| 値なし | `true` になる |

**値はつねに配列で入る。** 同じ Tick に同じ名前空間を複数回出せるため、
1 回だけのときも要素 1 の配列になる。読む側で場合分けが要らないほうが事故が少ない。

```jsonc
// tick.e
{ "zones": [ { "0": [3,2,1], "1": [1,1,4] } ], "mode": ["swarm"] }
```

メタ情報行は**人が読むログ本文からは取り除かれる**。毎 Tick 吐いてもログ欄が埋まらない。

行中に現れた `@`（`foo@example.com` など）はメタ情報にならない。行頭だけを見る。

### 出す頻度

毎 Tick 出す必要はない。決め直した Tick だけ出して、プラグイン側で遡って探すのが安い
（`examples/plugins/macro-zones.js` の `lookback` を参照）。

---

## 2. プラグイン側 — 描く

ES モジュールで、既定エクスポートにオブジェクトを置く。**すべての項目が任意**。

```js
export default {
    name: "macro-zones",

    // 必要な名前空間。ログに 1 つも無ければ本体が自動的にこのプラグインを寝かせる
    requires: ["zones", "creepZone"],

    // 下部のバーに出る表示切り替え
    toggles: [{ id: "macro-zones", label: "ゾーン", default: true }],

    // 凡例に足す項目
    legend: [{ color: "#8ee0ff", label: "DEFENSE" }],

    // 盤面へ重ねて描く。本体の描画の後に呼ばれる
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

    // 右サイドに足すパネル
    panels: [
        {
            id: "macro-zones",
            title: "Macro ゾーン配分",
            render(el, api) {
                el.textContent = JSON.stringify(api.ext?.zones ?? null);
            },
        },
    ],
};
```

### `api`

`drawOverlay` と `panels[].render` に渡る取っ手。

| | |
| --- | --- |
| `ctx` | 盤面の `CanvasRenderingContext2D` |
| `cell` | 1 セルあたりのピクセル数 |
| `doc` | リプレイ本体（`meta` / `objects` / `logs` など） |
| `timeline` | `objectById` などを持つ |
| `state` | いまの Tick の盤面。`creeps` / `struct` / `owner` / `actions` |
| `tick` / `index` | Tick 番号 / `doc.ticks` 上の添字 |
| `ext` | いまの Tick のメタ情報。無ければ `null` |
| `extAt(k)` | 任意の Tick のメタ情報。索引済みなので遡っても安い |
| `selected` | 選択中の creep id |
| `sideColor(side)` / `fade(hex, a)` | 本体と同じ配色を使うための補助 |
| `isToggled(id)` | 自分のトグルの状態 |

---

## 3. 置く

```bash
arena-replay view --plugins ~/my-bot/arena-plugins
```

置き場のディレクトリにある `*.js` が自動で読み込まれる。
自分のボットのリポジトリに置いたままでよく、このキットに取り込む必要はない。

URL からの指定もできる。

```
http://localhost:5544/?plugin=/plugins/macro-zones.js
```

---

## 決めごと

- **同一オリジンのプラグインしか読まない。** 外部 URL を許すと、共有されたリンクを
  開いただけで任意のスクリプトが走ることになる。自分のプラグインは `--plugins` で配ること。
- **落ちたプラグインは切り離される。** 1 つの例外で盤面ごと止まると原因が分からなくなるので、
  例外を出したプラグインだけを無効にして、左の一覧に理由を出す。
- **`requires` が満たされないプラグインは寝る。** 他人の試合を開いたときに
  空のパネルが並ばないようにするため。左の一覧には灰色で残り、何が足りないかを表示する。

---

## 動く例

[`examples/plugins/macro-zones.js`](../examples/plugins/macro-zones.js) —
Macro のゾーン配分を creep のリングとパネルの棒グラフで描く。
`@zones` / `@creepZone` を消費し、決め直した Tick だけ出す運用に合わせて遡って探す。
