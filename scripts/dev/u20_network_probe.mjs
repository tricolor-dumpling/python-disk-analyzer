/* ============================================================
   UI 2.0（SpaceLens Pro）· U2.0 验收探针：Network 请求序列（前后对照）
   - 捕获真实页（Flask 5000）加载期的全部请求：路径/方法/资源类型/相对时序；
   - 用法：node scripts/dev/u20_network_probe.mjs [--base URL] [--out 输出json]
     重构前跑一次存 before.json，重构后跑一次存 after.json，diff 即验收①证据；
   - 依赖：本机 Playwright（同 u13_viewport_probe.mjs 注记）。
   ============================================================ */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = arg("out", path.join(os.tmpdir(), "u20_network.json"));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
const reqs = [];
const t0 = Date.now();
const seen = new Set();
page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin === "http://127.0.0.1:5000") {
        const key = r.method() + " " + u.pathname + u.search;
        if (seen.has(key)) return; // 后续重复请求不影响序列锚点
        seen.add(key);
        reqs.push({
            n: reqs.length + 1,
            t: Date.now() - t0,
            method: r.method(),
            path: u.pathname + u.search,
            type: r.resourceType(),
        });
    }
});
await page.goto(BASE, { waitUntil: "load" });
// 等到首个 POST /api/browse（init 末步）或 15s 上限——
// 本机 /api/health 走 Everything DLL 探测，响应时延有环境抖动，
// 固定等待窗会漏掉「health→browse」的尾段（非逻辑问题）。
for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    if (reqs.some((r) => r.method === "POST" && r.path === "/api/browse")) break;
}
await browser.close();
fs.writeFileSync(OUT, JSON.stringify(reqs, null, 2));
console.log("请求数:", reqs.length, "→", OUT);
console.log(JSON.stringify(reqs.map((r) => r.method + " " + r.path), null, 0));
