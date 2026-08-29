import assert from "node:assert/strict";
import { test } from "node:test";

import { PluginHost, pluginsFromQuery } from "../viewer/plugin.js";

test("クエリからプラグインを拾う", () => {
    assert.deepEqual(pluginsFromQuery("?plugin=/a.js&plugin=/b.js"), ["/a.js", "/b.js"]);
    assert.deepEqual(pluginsFromQuery(""), []);
});

test("外部オリジンのプラグインは読まない", async () => {
    // 共有されたリンクを開いただけで任意のスクリプトが走る事態を避ける
    const host = new PluginHost();
    await host.load("https://evil.example.com/x.js");
    assert.equal(host.entries[0].plugin, null);
    assert.match(host.entries[0].error, /同一オリジン/);
    await host.load("//evil.example.com/x.js");
    assert.match(host.entries[1].error, /同一オリジン/);
});

/** テスト用のプラグインを直接差し込む（ブラウザ無しで挙動だけ見る） */
function install(host, plugin) {
    for (const t of plugin.toggles ?? []) host.toggleState.set(t.id, t.default !== false);
    host.entries.push({ id: plugin.name, plugin, active: true, error: null });
}

test("必要な名前空間がログに無いプラグインは寝かせる", () => {
    const host = new PluginHost();
    install(host, { name: "zones", requires: ["zones"] });
    install(host, { name: "always", requires: [] });

    host.applyDocument({ extensions: {} });
    assert.equal(host.entries[0].active, false);
    assert.deepEqual(host.entries[0].missing, ["zones"]);
    assert.equal(host.entries[1].active, true);

    host.applyDocument({ extensions: { zones: { count: 1 } } });
    assert.equal(host.entries[0].active, true);
});

test("寝ているプラグインのパネルや凡例は出さない", () => {
    const host = new PluginHost();
    install(host, { name: "zones", requires: ["zones"], legend: [{ color: "#fff", label: "Z" }], panels: [{ id: "z", title: "Z", render() {} }] });
    host.applyDocument({ extensions: {} });
    assert.deepEqual(host.legend(), []);
    assert.deepEqual(host.panels(), []);
});

test("例外を出したプラグインを切り離す", () => {
    // 1 つのプラグインの失敗で盤面ごと止まると原因が分からなくなる
    const host = new PluginHost();
    const bad = {
        name: "bad",
        drawOverlay() {
            throw new Error("boom");
        },
    };
    install(host, bad);
    const errors = [];
    host.onError = (id, message) => errors.push([id, message]);

    host.drawOverlay({});
    assert.equal(host.entries[0].active, false);
    assert.deepEqual(errors, [["bad", "boom"]]);

    // 一度切り離したら以降は呼ばない
    host.drawOverlay({});
    assert.equal(errors.length, 1);
});

test("トグルの既定値を尊重し、切り替えを保持する", () => {
    const host = new PluginHost();
    install(host, { name: "p", toggles: [{ id: "on", label: "On" }, { id: "off", label: "Off", default: false }] });
    assert.equal(host.isToggled("on"), true);
    assert.equal(host.isToggled("off"), false);
    host.setToggle("on", false);
    assert.equal(host.isToggled("on"), false);
});
