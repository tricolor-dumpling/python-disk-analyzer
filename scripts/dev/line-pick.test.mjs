/* 2026-09-13 第四轮 · 折线点选纯函数测试（viz/line.js 真实现）
   覆盖：nearestIndex（最近点）/ pointDist（距离口径）/ pickIndex（点选命中判定）/
   snapshotIndexOf（当前对比基准 → 数据点下标）。
   背景（用户实测反馈）：对比页多选快照后，折线图下方的对比恒取「最近一份」
   ——本轮改成「点折线上的哪个点，下方对比就换成针对那份快照」。
   点选命中判定必须是纯函数才好断言（真实点击坐标换算在 renderLine 内做）。
   line.js 无 UI 副作用（只 import motion-core 纯函数与 api.js 文本工具），可直接 import；
   实现改动须同步本文件。
   ============================================================ */
import test from "node:test";
import assert from "node:assert/strict";

import {
    pickIndex, pointDist, nearestIndex, snapshotIndexOf, PICK_RADIUS_PX,
} from "../../web/static/js/app/viz/line.js";

/* 三点折线（画布绝对坐标，与 lineGeometry 的产出同形）：x 均匀步进 100 */
const PTS = [
    { i: 0, value: 100, x: 62, y: 50, snapshot: "snap-a" },
    { i: 1, value: 200, x: 162, y: 20, snapshot: "snap-b" },
    { i: 2, value: 300, x: 262, y: 10, snapshot: "snap-c" },
];

/* ================= nearestIndex：既有语义（读数游标）================= */

test("nearestIndex：按 x 取最近点（首/中/末/越界夹取）", () => {
    assert.equal(nearestIndex(PTS, 62), 0);
    assert.equal(nearestIndex(PTS, 105), 0);   // 距 62 为 43、距 162 为 57
    assert.equal(nearestIndex(PTS, 115), 1);   // 距 162 为 47、距 62 为 53
    assert.equal(nearestIndex(PTS, 262), 2);
    assert.equal(nearestIndex(PTS, -999), 0);  // 左侧越界 → 首点
    assert.equal(nearestIndex(PTS, 9999), 2);  // 右侧越界 → 末点
});

test("nearestIndex：空集合/无点 → -1（不抛）", () => {
    assert.equal(nearestIndex([], 10), -1);
    assert.equal(nearestIndex(null, 10), -1);
});

/* ================= pointDist：距离口径 ================= */

test("pointDist：到最近点的欧氏距离（px）", () => {
    assert.equal(pointDist(PTS, 62, 50), 0);
    assert.equal(pointDist(PTS, 62, 53), 3);
    assert.equal(pointDist(PTS, 65, 54), 5); // 3-4-5
    // 最近点优先（不是「第一个点」）
    assert.equal(pointDist(PTS, 260, 10), 2);
});

test("pointDist：无点 → Infinity（不可能命中）", () => {
    assert.equal(pointDist([], 0, 0), Infinity);
    assert.equal(pointDist(null, 0, 0), Infinity);
});

/* ================= pickIndex：点选命中判定（本轮新增语义）================= */

test("pickIndex：点在数据点上 → 命中该点", () => {
    assert.equal(pickIndex(PTS, 62, 50, PICK_RADIUS_PX), 0);
    assert.equal(pickIndex(PTS, 162, 20, PICK_RADIUS_PX), 1);
    assert.equal(pickIndex(PTS, 262, 10, PICK_RADIUS_PX), 2);
});

test("pickIndex：点靠近但不精确（容错半径内）→ 命中最近点", () => {
    assert.equal(pickIndex(PTS, 66, 54, PICK_RADIUS_PX), 0);    // 距离 5
    assert.equal(pickIndex(PTS, 162, 47, PICK_RADIUS_PX), 1);   // 距离 27（< 28）
});

test("pickIndex：半径外 → -1（图上的空处点击不算点选）", () => {
    assert.equal(pickIndex(PTS, 162, 95, PICK_RADIUS_PX), -1);  // 距离 75
    assert.equal(pickIndex(PTS, 112, 90, PICK_RADIUS_PX), -1);
    // 恰在半径上算命中，超出 1px 不算（边界口径显式）
    assert.equal(pickIndex(PTS, 162, 20 + PICK_RADIUS_PX, PICK_RADIUS_PX), 1);
    assert.equal(pickIndex(PTS, 162, 20 + PICK_RADIUS_PX + 1, PICK_RADIUS_PX), -1);
});

test("pickIndex：相邻点之间取更近的那个（不会误选邻点）", () => {
    // y 固定 35（两点之间），x 决定胜负：
    assert.equal(pickIndex(PTS, 112, 35, 10), -1);   // 半径小 → 不命中（防误选）
    assert.equal(pickIndex(PTS, 140, 35, 100), 1);   // 距 162 为 22.6、距 62 为 78.9 → 中点
    assert.equal(pickIndex(PTS, 100, 35, 100), 0);   // 距 62 为 38.3、距 162 为 62.2 → 首点
    assert.equal(pickIndex(PTS, 240, 12, 100), 2);   // 距 262 为 22.1、距 162 为 78.1 → 末点
});

test("pickIndex：参数退化 → -1（不抛）", () => {
    assert.equal(pickIndex([], 10, 10, 28), -1);
    assert.equal(pickIndex(null, 10, 10, 28), -1);
    assert.equal(pickIndex(PTS, 62, 50, 0), -1);      // 半径为 0 → 不命中
    assert.equal(pickIndex(PTS, 62, 50, -5), -1);
    // 半径缺省 → PICK_RADIUS_PX
    assert.equal(pickIndex(PTS, 62, 50), 0);
});

/* ================= snapshotIndexOf：基准点标记（本轮新增） ================= */

test("snapshotIndexOf：快照路径 → 数据点下标", () => {
    assert.equal(snapshotIndexOf(PTS, "snap-a"), 0);
    assert.equal(snapshotIndexOf(PTS, "snap-b"), 1);
    assert.equal(snapshotIndexOf(PTS, "snap-c"), 2);
});

test("snapshotIndexOf：不在线上/空值 → -1（渲染时空基准环）", () => {
    assert.equal(snapshotIndexOf(PTS, "snap-x"), -1);
    assert.equal(snapshotIndexOf(PTS, ""), -1);
    assert.equal(snapshotIndexOf(PTS, null), -1);
    assert.equal(snapshotIndexOf(PTS, undefined), -1);
    assert.equal(snapshotIndexOf([], "snap-a"), -1);
    assert.equal(snapshotIndexOf(null, "snap-a"), -1);
});

test("snapshotIndexOf：点缺 snapshot 字段 / 路径需精确匹配（不做归一化）", () => {
    const pts = [{ i: 0, value: 1, x: 0, y: 0 }, { i: 1, value: 2, x: 1, y: 1, snapshot: "s" }];
    assert.equal(snapshotIndexOf(pts, "s"), 1);
    assert.equal(snapshotIndexOf(pts, "S"), -1); // 大小写不归一（快照路径来自后端原值）
    assert.equal(snapshotIndexOf(pts, "s "), -1);
});
