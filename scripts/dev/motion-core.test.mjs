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
