/* ============================================================
   UI 2.0（SpaceLens Pro）· motion-core 纯函数测试（U1.2）
   - 运行：`node --test scripts/dev/`（本机沙箱需单进程变体：
     `node --test-isolation=none --test "scripts/dev/*.test.mjs"`，无子进程 spawn）；
   - 8 用例 = 手册 §U1.2 清单：lerp 两端/中点、easeOutExpo(0)/(1)、
     clamp01 越界、formatElapsed(3722)、fnv1a 稳定性与异名异色；
   - 零依赖：仅 node:test + node:assert/strict（Node ≥18）。
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    lerp,
    easeOutExpo,
    easeOutCubic,
    easeSpring,
    clamp01,
    formatElapsed,
    fnv1a,
    cubicBezier,
    estimateRemainingSec,
    etaShouldUpdate,
    sparklinePath,
    sparklineLastPoint,
} from "../../web/static/js/app/motion-core.js";

test("lerp 两端：t=0 精确等于 a、t=1 精确等于 b", () => {
    assert.equal(lerp(10, 20, 0), 10);
    assert.equal(lerp(10, 20, 1), 20);
    assert.equal(lerp(-3, 7, 1), 7);
    assert.equal(lerp(-3, 7, 0), -3);
});

test("lerp 中点：t=0.5 为 a、b 的算术平均", () => {
    assert.equal(lerp(10, 20, 0.5), 15);
    assert.equal(lerp(20, 10, 0.5), 15); // 递减区间同样成立
    assert.equal(lerp(0, 100, 0.25), 25);
});

test("easeOutExpo(0) 精确为 0（动画起点），且越界负值也归 0", () => {
    assert.equal(easeOutExpo(0), 0);
    assert.equal(easeOutExpo(-0.1), 0);
});

test("easeOutExpo(1) 精确为 1（动画终点不残留 1-2^-10 尾差），且中点值稳定", () => {
    assert.equal(easeOutExpo(1), 1);
    assert.equal(easeOutExpo(2), 1);
    assert.equal(easeOutExpo(0.5), 0.96875); // 1 - 2^-5（黄金值锚点）
});

test("clamp01 越界：<0 归 0、>1 归 1、区间内原样", () => {
    assert.equal(clamp01(-0.001), 0);
    assert.equal(clamp01(1.001), 1);
    assert.equal(clamp01(0), 0);
    assert.equal(clamp01(1), 1);
    assert.equal(clamp01(0.37), 0.37);
});

test("formatElapsed：3722 秒 → \"01:02:02\"，且 0/负数/整点边界正确", () => {
    assert.equal(formatElapsed(3722), "01:02:02");
    assert.equal(formatElapsed(0), "00:00:00");
    assert.equal(formatElapsed(-5), "00:00:00");
    assert.equal(formatElapsed(3600), "01:00:00");
    assert.equal(formatElapsed(65), "00:01:05");
});

test("fnv1a 稳定性：同输入恒同输出、uint32 域内、与公开参考值一致", () => {
    const a1 = fnv1a("D:/data");
    const a2 = fnv1a("D:/data");
    assert.equal(a1, a2, "同输入必须逐次同值");
    assert.equal(a1, 4082083572, "黄金值回归（D:/data）");
    assert.equal(fnv1a("a"), 0xe40c292c, "经典 FNV-1a 参考值（\"a\"）");
    assert.ok(Number.isInteger(a1) && a1 >= 0 && a1 <= 0xffffffff, "结果必须是 uint32");
});

test("fnv1a 异名异色：不同目录名给出不同哈希（% 10 亦不同，供 palette 取色）", () => {
    const p1 = fnv1a("D:/data");
    const p2 = fnv1a("D:/docs");
    assert.notEqual(p1, p2, "不同名称不得同哈希");
    assert.notEqual(p1 % 10, p2 % 10, "palette 取色槽位应不同（%10）");
    assert.notEqual(fnv1a("alpha"), fnv1a("beta"));
});

/* easeSpring 常量与 tokens.css --ease-spring 镜像一致性（U1.2 §设计 提及） */
test("easeSpring 常量：4 控制点且与 --ease-spring 镜像一致", () => {
    assert.deepEqual(easeSpring, [0.34, 1.56, 0.64, 1]);
});

/* cubicBezier（U2.2 增补：treemap L1-1 入场缓动 = tokens.css --ease-out 求值器） */
test("cubicBezier 端点精确：沿 --ease-out 镜像 (.16,1,.3,1) 求值 0→0、1→1", () => {
    const e = cubicBezier(0.16, 1, 0.3, 1);
    assert.equal(e(0), 0);
    assert.equal(e(1), 1);
    assert.equal(e(-0.5), 0); // 越界归端
    assert.equal(e(1.5), 1);
});

test("cubicBezier 单调性与 ease-out 形态：(.16,1,.3,1) 中间值先快后缓", () => {
    const e = cubicBezier(0.16, 1, 0.3, 1);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
        const v = e(i / 20);
        assert.ok(v >= prev - 1e-9, "必须单调不减，i=" + i + " v=" + v);
        assert.ok(v >= 0 - 1e-9 && v <= 1 + 1e-9, "输出必须 ∈ [0,1]");
        prev = v;
    }
    assert.ok(e(0.5) > 0.5 && e(0.5) < 1, "ease-out 在中点应已过半（前快），实际 " + e(0.5));
});

test("cubicBezier 线性镜像：cubic-bezier(0,0,1,1) 为恒等映射", () => {
    const l = cubicBezier(0, 0, 1, 1);
    assert.ok(Math.abs(l(0.25) - 0.25) < 1e-3);
    assert.ok(Math.abs(l(0.5) - 0.5) < 1e-3);
    assert.ok(Math.abs(l(0.8) - 0.8) < 1e-3);
});

/* 阶段D（D-3b）：估算剩余（根间平台期口径）与 ETA 不闪跳纯函数 */
test("estimateRemainingSec：已完成根均耗时 × 剩余根数，向上取整", () => {
    // 已完成 1 根耗时 100s，剩余 1 根 → ~100s（允许多 1s 取整误差）
    assert.equal(estimateRemainingSec(100, 1, 2), 100);
    assert.equal(estimateRemainingSec(100, 1, 3), 200); // 剩 2 根 → 2×100
    assert.equal(estimateRemainingSec(50, 2, 4), 50);   // 均 25s/根 × 剩 2 根
    assert.equal(estimateRemainingSec(30, 1, 2), 30);
    assert.equal(estimateRemainingSec(30.5, 1, 2), 31); // ceil（向上取整）
});

test("estimateRemainingSec：无法估算返回 null（0 根已完/已完尽/无耗时）", () => {
    assert.equal(estimateRemainingSec(100, 0, 2), null);  // done<=0
    assert.equal(estimateRemainingSec(100, 2, 2), null);  // total<=done
    assert.equal(estimateRemainingSec(0, 1, 2), null);    // elapsed=0
    assert.equal(estimateRemainingSec(-5, 1, 2), null);   // 负数按 0
    assert.equal(estimateRemainingSec(100, 1, 0), null);  // total=0
});

test("etaShouldUpdate：首采样/阈值跨越必更新；变化 ≤10% 不更新（不闪跳）", () => {
    assert.equal(etaShouldUpdate(500, null, false), true);   // 首采样必更新
    assert.equal(etaShouldUpdate(500, 500, false), false);   // 无变化 → 不更新
    assert.equal(etaShouldUpdate(505, 500, false), false);   // Δ5 ≤ 50（10%）→ 不更新
    assert.equal(etaShouldUpdate(500, 460, false), false);   // Δ40 ≤ 46（460 的 10%）→ 不更新
    assert.equal(etaShouldUpdate(507, 460, false), true);    // Δ47 > 46 → 更新
    assert.equal(etaShouldUpdate(551, 500, false), true);    // Δ51 > 50 → 更新
    // 阈值跨越（soon 档/普通档互跨）
    assert.equal(etaShouldUpdate(25, 31, true), true);       // 进入 soon（≤30）→ 必更新
    assert.equal(etaShouldUpdate(25, 25, true), false);      // soon 内微小变化 → 不更新
    assert.equal(etaShouldUpdate(35, 25, false), true);      // 离开 soon → 必更新
});

/* 阶段G（G-2）：sparkline 折线纯函数（P-4 数据源启用；与差值卡 total_current 同口径） */
test("sparklinePath：<2 点返回空串（无折线）", () => {
    assert.equal(sparklinePath([], 100, 30), "");
    assert.equal(sparklinePath([10], 100, 30), "");
    assert.equal(sparklinePath([10, 20, 30], 0, 30), "");   // w=0 非法 → 空（防御）
});

test("sparklinePath：两点 → 水平/斜线，端点精确到 w 边界", () => {
    const p = sparklinePath([0, 10], 100, 20);
    assert.match(p, /^M0\.00 \d+\.\d\d L100\.00 \d+\.\d\d$/); // 首点 x=0、末点 x=w
    const pFlat = sparklinePath([5, 5], 100, 20);
    assert.match(pFlat, /M0\.00 10\.00 L100\.00 10\.00/);      // 全等值 → 水平中线 y=h/2
});

test("sparklinePath：三点递增 → 归一化 y 单调（末点在底部 h）", () => {
    const p = sparklinePath([0, 5, 10], 100, 20);
    // path 形如 "M0.00 20.00 L50.00 10.00 L100.00 0.00"（中间点 x=50 为半程）
    const pts = p.trim().split(/\s+/);
    assert.equal(pts[0], "M0.00");
    assert.equal(pts[1], "20.00");   // 最小值 → 底部 y=h
    assert.equal(pts[2], "L50.00");  // 中间点 x = w*(1/2)
    assert.equal(pts[3], "10.00");   // 半值 → y=h/2
    assert.equal(pts[4], "L100.00");
    assert.equal(pts[5], "0.00");    // 最大值 → 顶部 y=0
});

test("sparklineLastPoint：终点坐标 = 末点（w 处、按值归一）", () => {
    assert.equal(sparklineLastPoint([], 100, 20), null);
    const pt = sparklineLastPoint([0, 5, 10], 100, 20);
    assert.equal(pt.x, 100);
    assert.equal(pt.y, 0);             // 最大值 → 顶部
    const ptFlat = sparklineLastPoint([3, 3], 100, 20);
    assert.equal(ptFlat.y, 10);        // 全等值 → 中线 h/2
});

test("sparklinePath：非法/非数字值过滤；字符串数字容忍", () => {
    const p = sparklinePath(["0", 5, "abc", "10"], 100, 20);
    assert.match(p, /^M/);
    assert.match(p, /L100\.00 0\.00$/); // 仅 0/5/10 三点有效（"abc" → NaN 过滤）
});
