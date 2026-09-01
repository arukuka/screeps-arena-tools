import assert from "node:assert/strict";
import { test } from "node:test";

import { PluginHost, pluginsFromQuery } from "../viewer/plugin.js";
import type { ArenaPlugin } from "../src/types.js";

test("extracts plugins from query string", () => {
    assert.deepEqual(pluginsFromQuery("?plugin=/a.js&plugin=/b.js"), ["/a.js", "/b.js"]);
    assert.deepEqual(pluginsFromQuery(""), []);
});

test("refuses to load plugins from external origins", async () => {
    const host = new PluginHost();
    await host.load("https://evil.example.com/x.js");
    assert.equal(host.entries[0]?.plugin, null);
    assert.match(host.entries[0]?.error ?? "", /same-origin/);
    await host.load("//evil.example.com/x.js");
    assert.match(host.entries[1]?.error ?? "", /same-origin/);
});

/** Install a test plugin directly without browser imports. */
function install(host: PluginHost, plugin: ArenaPlugin): void {
    for (const t of plugin.toggles ?? []) host.toggleState.set(t.id, t.default !== false);
    host.entries.push({ id: plugin.name, plugin, active: true, error: null });
}

test("disables plugins when required namespaces are missing in log", () => {
    const host = new PluginHost();
    install(host, { name: "zones", requires: ["zones"] });
    install(host, { name: "always", requires: [] });

    host.applyDocument({ extensions: {} });
    assert.equal(host.entries[0]?.active, false);
    assert.deepEqual(host.entries[0]?.missing, ["zones"]);
    assert.equal(host.entries[1]?.active, true);

    host.applyDocument({ extensions: { zones: { count: 1, firstTick: 0, lastTick: 0 } } });
    assert.equal(host.entries[0]?.active, true);
});

test("omits panels and legends from inactive plugins", () => {
    const host = new PluginHost();
    install(host, { name: "zones", requires: ["zones"], legend: [{ color: "#fff", label: "Z" }], panels: [{ id: "z", title: "Z", render() {} }] });
    host.applyDocument({ extensions: {} });
    assert.deepEqual(host.legend(), []);
    assert.deepEqual(host.panels(), []);
});

test("isolates and disables plugins that throw exceptions", () => {
    const host = new PluginHost();
    const bad: ArenaPlugin = {
        name: "bad",
        drawOverlay() {
            throw new Error("boom");
        },
    };
    install(host, bad);
    const errors: [string, string][] = [];
    host.onError = (id, message) => errors.push([id, message]);

    host.drawOverlay({} as any);
    assert.equal(host.entries[0]?.active, false);
    assert.deepEqual(errors, [["bad", "boom"]]);

    // Subsequent invocations must skip the faulted plugin
    host.drawOverlay({} as any);
    assert.equal(errors.length, 1);
});

test("respects default toggle values and persists toggle changes", () => {
    const host = new PluginHost();
    install(host, { name: "p", toggles: [{ id: "on", label: "On" }, { id: "off", label: "Off", default: false }] });
    assert.equal(host.isToggled("on"), true);
    assert.equal(host.isToggled("off"), false);
    host.setToggle("on", false);
    assert.equal(host.isToggled("on"), false);
});
