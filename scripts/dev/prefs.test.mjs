/* 2026-09-13：使用偏好持久化单测（app/prefs.js）
   覆盖：默认值回落、非法枚举/越界数值清洗、未登记 id 拒写、显式存储计数、
   恢复默认、注册表 → 设置弹窗分组结构；以及「存储不可用」时的静默降级。 */
import test from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
    const store = new Map();
    return {
        store,
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
    };
}

globalThis.localStorage = makeStorage();

const prefs = await import("../../web/static/js/app/prefs.js");
const { APP_STATE } = await import("../../web/static/js/app/state.js");

test("未设置 → 注册表默认值；未登记 id → null / 拒写", () => {
    localStorage.clear();
    assert.equal(prefs.getPref("view.mode"), "treemap");
    assert.equal(prefs.getPref("view.mergeTop"), 24);
    assert.equal(prefs.getPref("compare.depth"), "");
    assert.equal(prefs.getPref("compare.hideZero"), true);
    assert.equal(prefs.getPref("nope.nope"), null);
    assert.equal(prefs.setPref("nope.nope", 1), false);
});

test("写入/读取：合法值持久化到单一文档 pds_prefs_v1", () => {
    localStorage.clear();
    assert.equal(prefs.setPref("view.mode", "table"), true);
    assert.equal(prefs.setPref("compare.depth", "3"), true);
    assert.equal(prefs.setPref("compare.hideZero", false), true);
    const doc = JSON.parse(localStorage.getItem(prefs.PREFS_KEY));
    assert.equal(doc.v, prefs.PREFS_VERSION);
    assert.equal(doc.values["view.mode"], "table");
    assert.equal(doc.values["compare.depth"], "3");
    assert.equal(doc.values["compare.hideZero"], false);
    assert.equal(prefs.getPref("view.mode"), "table");
    // 全量读取（含未设置项的默认）
    const all = prefs.readPrefs();
    assert.equal(all["view.mode"], "table");
    assert.equal(all["list.kind"], "all");
    assert.equal(all["view.mergeTop"], 24);
});

test("清洗：非法枚举拒绝、数值越界夹取、类型不符回落默认", () => {
    localStorage.clear();
    prefs.setPref("view.mode", "hacker");          // 不在枚举内 → 不落盘
    assert.equal(prefs.getPref("view.mode"), "treemap");
    prefs.setPref("view.mergeTop", 9999);          // 越界 → 夹到 200
    assert.equal(prefs.getPref("view.mergeTop"), 200);
    prefs.setPref("view.mergeTop", -5);            // 下界 → 1
    assert.equal(prefs.getPref("view.mergeTop"), 1);
    prefs.setPref("view.mergeTop", 12.7);          // 取整
    assert.equal(prefs.getPref("view.mergeTop"), 12);
    prefs.setPref("compare.hideZero", "yes");      // 类型不符 → 不落盘
    assert.equal(prefs.getPref("compare.hideZero"), true);
    // 手写脏文档（越权 id + 非法值）→ 读取时全部回落默认，不抛
    localStorage.setItem(prefs.PREFS_KEY, JSON.stringify({ v: 1, values: { "evil.key": 1, "view.mode": 42, "list.sort": "nope" } }));
    assert.equal(prefs.getPref("view.mode"), "treemap");
    assert.equal(prefs.getPref("list.sort"), "size-desc");
    assert.equal(prefs.getPref("evil.key"), null);
    // 损坏 JSON → 默认值，不抛
    localStorage.setItem(prefs.PREFS_KEY, "{oops");
    assert.equal(prefs.getPref("view.mode"), "treemap");
});

test("显式存储计数 + 写回默认值即从文档删除（不算自定义）", () => {
    localStorage.clear();
    assert.deepEqual(prefs.storedPrefIds(), []);
    prefs.setPref("view.mode", "ranking");
    prefs.setPref("compare.depth", "2");
    assert.deepEqual(prefs.storedPrefIds().sort(), ["compare.depth", "view.mode"]);
    prefs.setPref("view.mode", "treemap"); // 写回默认 = 取消自定义
    assert.deepEqual(prefs.storedPrefIds(), ["compare.depth"]);
});

test("prefText / prefGroups：展示文本与分组结构", () => {
    localStorage.clear();
    assert.equal(prefs.prefText("view.mode", "treemap"), "矩形图");
    assert.equal(prefs.prefText("compare.depth", "3"), "3 层");
    assert.equal(prefs.prefText("compare.depth", ""), "叶子（默认）");
    assert.equal(prefs.prefText("compare.hideZero", true), "开");
    assert.equal(prefs.prefText("compare.hideZero", false), "关");
    assert.equal(prefs.prefText("list.sort", "name-asc"), "按名称");
    const groups = prefs.prefGroups();
    assert.deepEqual(groups.map((g) => g.group), ["工作台", "列表", "对比"]);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    assert.deepEqual(ids, prefs.PREF_REGISTRY.map((d) => d.id));
    const mode = groups[0].items[0];
    assert.equal(mode.value, "treemap");
    assert.equal(mode.text, "矩形图");
    assert.ok(Array.isArray(mode.options) && mode.options.length === 4);
});

test("resetPrefs：整份文档删除 → 全部回落默认", () => {
    localStorage.clear();
    prefs.setPref("view.mode", "relate");
    prefs.setPref("view.mergeTop", 60);
    assert.equal(prefs.getPref("view.mode"), "relate");
    assert.equal(prefs.resetPrefs(), true);
    assert.equal(localStorage.getItem(prefs.PREFS_KEY), null);
    assert.equal(prefs.getPref("view.mode"), "treemap");
    assert.equal(prefs.getPref("view.mergeTop"), 24);
});

test("initPrefs：持久化值落进 APP_STATE（首渲染前口径）", () => {
    localStorage.clear();
    prefs.setPref("view.mode", "table");
    prefs.setPref("view.mergeTop", 40);
    prefs.setPref("compare.depth", "1");
    prefs.setPref("compare.hideZero", false);
    prefs.initPrefs();
    assert.equal(APP_STATE.view.mode, "table");
    assert.equal(APP_STATE.view.mergeTop, 40);
    assert.equal(APP_STATE.compare.depth, "1");
    assert.equal(APP_STATE.compare.hideZero, false);
});

test("存储不可用：读写静默降级（不抛、回落默认、返回 false/[]）", () => {
    const good = globalThis.localStorage;
    globalThis.localStorage = {
        getItem() { throw new Error("denied"); },
        setItem() { throw new Error("denied"); },
        removeItem() { throw new Error("denied"); },
    };
    assert.equal(prefs.getPref("view.mode"), "treemap");
    assert.equal(prefs.setPref("view.mode", "ranking"), false);
    assert.deepEqual(prefs.storedPrefIds(), []);
    assert.deepEqual(prefs.readPrefs()["view.mode"], "treemap");
    assert.equal(prefs.resetPrefs(), false);
    globalThis.localStorage = good;
});
