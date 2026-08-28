/* ============================================================
   UI 2.0（SpaceLens Pro）· treemap 布局纯函数测试（U2.2）
   - 运行：`node --test scripts/dev/`（本机沙箱需单进程变体：
     `node --test-isolation=none --test "scripts/dev/*.test.mjs"`）；
   - 用例 = 手册 §U2.2 清单：面积守恒 / 宽高比上界 / 单块 / 空输入
     （+ 边界包含 / 无重叠 / 面积比例 / 输入顺序无关的补强）；
   - 零依赖：仅 node:test + node:assert/strict；treemap.js 顶层无 DOM 访问。
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutSquaried } from "../../web/static/js/app/viz/treemap.js";

const TOL = 1e-6;

function sum(rects, pick) {
    return rects.reduce((s, r) => s + pick(r), 0);
}

test("layoutSquaried 空输入：[]、非数组、全零/负值均返回空布局", () => {
    assert.deepEqual(layoutSquaried([], 0, 0, 100, 50), []);
    assert.deepEqual(layoutSquaried(null, 0, 0, 100, 50), []);
    assert.deepEqual(layoutSquaried([{ key: "a", value: 0 }, { key: "b", value: -3 }], 0, 0, 100, 50), []);
    assert.deepEqual(layoutSquaried([{ key: "a", value: NaN }], 0, 0, 100, 50), []);
    // 零尺寸矩形：无合法布局
    assert.deepEqual(layoutSquaried([{ key: "a", value: 10 }], 0, 0, 0, 50), []);
});

test("layoutSquaried 单块：占满整个给定矩形", () => {
    const out = layoutSquaried([{ key: "only", value: 100 }], 0, 0, 200, 100);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "only");
    assert.ok(Math.abs(out[0].x - 0) < TOL && Math.abs(out[0].y - 0) < TOL);
    assert.ok(Math.abs(out[0].w - 200) < TOL && Math.abs(out[0].h - 100) < TOL);
    // 非原点起始
    const out2 = layoutSquaried([{ key: "only", value: 5 }], 10, 20, 40, 30);
    assert.ok(Math.abs(out2[0].x - 10) < TOL && Math.abs(out2[0].y - 20) < TOL);
    assert.ok(Math.abs(out2[0].w - 40) < TOL && Math.abs(out2[0].h - 30) < TOL);
});

test("layoutSquaried 面积守恒：Σ(面积) = 给定矩形总面积（任意数据/任意矩形）", () => {
    const cases = [
        { items: [6, 6, 4, 3, 2, 2, 1], w: 6, h: 4 },
        { items: [1000, 1, 1, 1], w: 300, h: 120 },
        { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], w: 137, h: 89 },
        { items: Array.from({ length: 40 }, (_, i) => (i * 7919) % 997 + 1), w: 640, h: 480 },
    ];
    for (const c of cases) {
        const items = c.items.map((v, i) => ({ key: "k" + i, value: v }));
        const out = layoutSquaried(items, 0, 0, c.w, c.h);
        const areaTotal = c.w * c.h; // 归一化：value 映射为面积，Σ面积 = 矩形总面积
        const laid = sum(out, (r) => r.w * r.h);
        assert.ok(Math.abs(laid - areaTotal) < TOL * Math.max(1, areaTotal),
                  "面积守恒失败：laid=" + laid + " areaTotal=" + areaTotal);
    }
});

test("layoutSquaried 边界包含：所有矩形都在给定矩形内（含非原点起始）", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ key: "k" + i, value: (i * 13) % 401 + 1 }));
    const out = layoutSquaried(items, 12, 34, 556, 300);
    for (const r of out) {
        assert.ok(r.x >= 12 - TOL && r.y >= 34 - TOL, "左/上越界");
        assert.ok(r.x + r.w <= 12 + 556 + TOL && r.y + r.h <= 34 + 300 + TOL, "右/下越界");
        assert.ok(r.w > 0 && r.h > 0, "不得有零尺寸块");
    }
});

test("layoutSquaried 无重叠：任意两矩形内部交集必须为空（共享边允许）", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ key: "k" + i, value: (i * 37) % 599 + 1 }));
    const out = layoutSquaried(items, 0, 0, 400, 300);
    for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
            const a = out[i], b = out[j];
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            const inter = Math.max(0, ox) * Math.max(0, oy);
            assert.ok(inter < 1e-6, "重叠：" + a.key + "×" + b.key + " inter=" + inter);
        }
    }
});

test("layoutSquaried 面积比例：每块面积 ∝ 输入 value（守恒的前提下成比例）", () => {
    const items = [{ key: "big", value: 500 }, { key: "mid", value: 300 }, { key: "small", value: 200 }];
    const out = layoutSquaried(items, 0, 0, 100, 100);
    const total = 1000, area = 100 * 100;
    for (const r of out) {
        const expect = (Number(r.key === "big" ? 500 : r.key === "mid" ? 300 : 200) / total) * area;
        assert.ok(Math.abs(r.w * r.h - expect) < 1e-4 * Math.max(1, expect), r.key + " 面积失真");
    }
});

test("layoutSquaried 宽高比上界：良态输入的最差宽高比 ≤ 3（Bruls 逐行极值）", () => {
    // 经典 Bruls 论文算例（6×4，7 项），手工验算最差 ≈ 2.78
    const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ key: "s" + i, value: v }));
    const out = layoutSquaried(items, 0, 0, 6, 4);
    let worst = 0;
    for (const r of out) {
        const ratio = Math.max(r.w / r.h, r.h / r.w);
        worst = Math.max(worst, ratio);
    }
    assert.ok(worst <= 3, "最差宽高比应 ≤3，实际 " + worst);
    // 等值 16 项正方形区域：接近 1:1
    const eq = Array.from({ length: 16 }, (_, i) => ({ key: "e" + i, value: 10 }));
    const eqOut = layoutSquaried(eq, 0, 0, 200, 200);
    let eqWorst = 0;
    for (const r of eqOut) {
        eqWorst = Math.max(eqWorst, Math.max(r.w / r.h, r.h / r.w));
    }
    assert.ok(eqWorst <= 2, "等值 16 项最差宽高比应 ≤2，实际 " + eqWorst);
});

test("layoutSquaried 输入顺序无关：相同集合不同排列给出相同布局（确定性）", () => {
    const a = [{ key: "x", value: 5 }, { key: "y", value: 9 }, { key: "z", value: 2 }];
    const b = [{ key: "z", value: 2 }, { key: "x", value: 5 }, { key: "y", value: 9 }];
    const ra = layoutSquaried(a, 0, 0, 120, 80);
    const rb = layoutSquaried(b, 0, 0, 120, 80);
    const byKey = (arr) => new Map(arr.map((r) => [r.key, r]));
    for (const [k, r] of byKey(ra)) {
        const o = byKey(rb).get(k);
        assert.deepEqual([o.x, o.y, o.w, o.h], [r.x, r.y, r.w, r.h], "键 " + k + " 布局应一致");
    }
});
