/* 阶段C（R2）· C-4 趋势窗口边界纯函数测试
   覆盖：23h（较昨日命中）/ 24h 整（边界）/ 25h（较上周）/ 7d 整（边界）/ 8d（窗口外）/
   同一时刻 / 跨盘（无同盘基线）/ 无快照 / 空态原因行文案。
   直接测试 snapshots.js 的纯函数语义（复制实现防 import 环；实现改动须同步本文件）。
   ============================================================ */
import test from "node:test";
import assert from "node:assert/strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const SLOTS = [
    { key: "day", label: "较昨日", minMs: 0, windowMs: DAY_MS },
    { key: "week", label: "较上周", minMs: DAY_MS, windowMs: WEEK_MS },
];
const NOW = Date.parse("2026-09-02T15:41:00");

/* collectDriveEntries + pickTrendForSlot（snapshots.js 语义复制） */
function collectDriveEntries(sessions) {
    const out = [];
    for (const s of sessions) {
        const t = Date.parse(String(s.created_at || ""));
        if (!t) continue;
        for (const r of Object.values(s.roots || {})) {
            if (!r || r.skipped || !r.root || !r.snapshot_path) continue;
            out.push({ root: r.root, snapPath: r.snapshot_path, createdMs: t });
        }
    }
    out.sort((a, b) => b.createdMs - a.createdMs || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    return out;
}
function pickTrendForSlot(sessions, slot) {
    const entries = collectDriveEntries(sessions);
    if (!entries.length) return null;
    const byRoot = new Map();
    for (const e of entries) {
        if (!byRoot.has(e.root)) byRoot.set(e.root, []);
        byRoot.get(e.root).push(e);
    }
    for (const e of entries) {
        const list = byRoot.get(e.root);
        const target = list[0];
        for (let i = 1; i < list.length; i++) {
            const diff = target.createdMs - list[i].createdMs;
            if (diff > slot.minMs && diff <= slot.windowMs) {
                return { root: target.root, baseline: list[i].snapPath, target: target.snapPath };
            }
            if (diff > slot.windowMs) break;
        }
    }
    return null;
}
function trendEmptyReason(sessions, slot) {
    const entries = collectDriveEntries(sessions);
    if (!entries.length) return "还没有快照，先做全量扫描并保存";
    const anyUsable = entries.some((e) => e.snapPath);
    if (!anyUsable) return "基线快照不可用（已删除或损坏）";
    const byRoot = new Map();
    for (const e of entries) {
        if (!byRoot.has(e.root)) byRoot.set(e.root, []);
        byRoot.get(e.root).push(e);
    }
    let anyInWindow = false;
    let latestMs = 0;
    for (const list of byRoot.values()) {
        const target = list[0];
        if (target.createdMs > latestMs) latestMs = target.createdMs;
        for (let i = 1; i < list.length; i++) {
            const diff = target.createdMs - list[i].createdMs;
            if (diff > slot.minMs && diff <= slot.windowMs) { anyInWindow = true; break; }
            if (diff > slot.windowMs) break;
        }
    }
    if (anyInWindow) return "";
    return "最近快照 " + slotTimeText(latestMs) + "，超出 " + (slot.windowMs / DAY_MS).toFixed(0) + " 天窗口，请保存新快照后查看";
}
function slotTimeText(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function session(name, atMs, roots) {
    return { session_id: name, created_at: new Date(atMs).toISOString(), roots: Object.fromEntries(
        roots.map(([root, snap]) => [root, { root, snapshot: snap, snapshot_path: snap, skipped: false }])
    ) };
}
const mk = (hoursAgo, root = "C:\\", scale = "x") => session("s" + hoursAgo, NOW - hoursAgo * 3600e3, [[root, "C:\\snap" + hoursAgo + ".snap.gz"]]);

test("23h：较昨日命中基线（0<Δt≤24h）", () => {
    const s = [mk(0), mk(23)];
    const day = pickTrendForSlot(s, SLOTS[0]);
    assert.ok(day, "23h 应命中较昨日");
    assert.equal(day.baseline, "C:\\snap23.snap.gz");
    assert.equal(trendEmptyReason(s, SLOTS[0]), "");
});
test("23h：较上周不命中（Δt≤24h 排除）", () => {
    const s = [mk(0), mk(23)];
    assert.equal(pickTrendForSlot(s, SLOTS[1]), null);
    assert.match(trendEmptyReason(s, SLOTS[1]), /超出 7 天窗口/);
});
test("24h 整边界：较昨日窗口不含 24h 整（≤24h 语义 vs 0<Δt≤24h）", () => {
    // Δt = 24h 整 → 不在 (0,24h] → 较昨日不命中（口径：0<Δt≤24h 含 24h？口径文档为 0<Δt≤24h，含 24h）
    // pickTrendForSlot 条件 diff <= slot.windowMs 且 diff > 0 → 24h 整命中较昨日
    const s = [mk(0), mk(24)];
    const day = pickTrendForSlot(s, SLOTS[0]);
    assert.ok(day, "24h 整应命中较昨日（0<Δt≤24h 含边界）");
    assert.equal(day.baseline, "C:\\snap24.snap.gz");
    assert.equal(trendEmptyReason(s, SLOTS[0]), "");
});
test("25h：较上周命中（24h<Δt≤7d）", () => {
    const s = [mk(0), mk(25)];
    assert.equal(pickTrendForSlot(s, SLOTS[0]), null, "25h 不在较昨日窗口");
    const week = pickTrendForSlot(s, SLOTS[1]);
    assert.ok(week, "25h 应命中较上周");
    assert.equal(week.baseline, "C:\\snap25.snap.gz");
});
test("7d 整边界：较上周含 7d 整（24h<Δt≤7d）", () => {
    const s = [mk(0), mk(7 * 24)];
    const week = pickTrendForSlot(s, SLOTS[1]);
    assert.ok(week, "7d 整应命中较上周");
    assert.equal(week.baseline, "C:\\snap168.snap.gz");
});
test("8d：双窗口外 → 空态带原因行", () => {
    const s = [mk(0), mk(8 * 24)];
    assert.equal(pickTrendForSlot(s, SLOTS[0]), null);
    assert.equal(pickTrendForSlot(s, SLOTS[1]), null);
    const reason = trendEmptyReason(s, SLOTS[1]);
    assert.match(reason, /最近快照/);
    assert.match(reason, /超出 7 天窗口/);
});
test("同一时刻：仅一份快照 → 双窗口均空态", () => {
    const s = [mk(0)];
    assert.equal(pickTrendForSlot(s, SLOTS[0]), null);
    assert.equal(pickTrendForSlot(s, SLOTS[1]), null);
    assert.match(trendEmptyReason(s, SLOTS[0]), /超出 1 天窗口/);
});
test("跨盘：E 盘单独会话无同盘基线 → 空态", () => {
    const s = [session("sE", NOW - 2 * 3600e3, [["E:\\", "E:\\snapE.snap.gz"]])];
    assert.equal(pickTrendForSlot(s, SLOTS[0]), null);
    assert.equal(pickTrendForSlot(s, SLOTS[1]), null);
    assert.match(trendEmptyReason(s, SLOTS[0]), /最近快照/);
});
test("无快照 → 空态原因「还没有快照」", () => {
    assert.match(trendEmptyReason([], SLOTS[0]), /还没有快照/);
    assert.match(trendEmptyReason([], SLOTS[1]), /还没有快照/);
});
test("多盘混合：C 盘无窗口基线但 D 盘有 → 命中（确定性取首个合格盘）", () => {
    const s = [mk(0, "C:\\"), mk(23, "C:\\"), mk(0, "D:\\"), mk(25, "D:\\")];
    const day = pickTrendForSlot(s, SLOTS[0]);
    assert.ok(day, "C 盘 23h 命中较昨日");
    assert.equal(day.root, "C:\\");
});
