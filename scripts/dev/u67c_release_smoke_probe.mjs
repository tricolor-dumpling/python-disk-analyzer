/* 阶段F（R6）· u67c_release_smoke_probe.mjs（P-10 打包版 windowed 冒烟）
   运行：node scripts/dev/u67c_release_smoke_probe.mjs [--base http://127.0.0.1:5000/] [--out <目录>]
   前提：PythonDiskScanner.exe 已用 --no-browser 启动（隔离 LOCALAPPDATA）。
   验收（阶段 F 发布链路纪律，P-10 核销条件）：
   ① /api/health 200 + ready 确定态（≤15s 进入确定态已由启动侧验证）；
   ② 页面 console 0（无未处理 Promise/运行时错误）；
   ③ 冒烟截图（供 gpt-5.6-luna 判读——健康徽章就绪/页面完整渲染）；
   ④ DLL 随包存在（启动侧已核，此处补 exe 目录核对）。 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg("base", "http://127.0.0.1:5000/");
const OUT = path.resolve(arg("out", path.join(os.tmpdir(), "stage_f_u67c")));
fs.mkdirSync(OUT, { recursive: true });
const RESULT = { meta: { base: BASE, out: OUT, node: process.version, startedAt: new Date().toISOString() }, checks: [], consoleErrors: [], shots: [] };

(async () => {
    // ① health
    const h = await fetch(BASE + "api/health").then((r) => r.json()).catch((e) => ({ fetchError: String(e) }));
    RESULT.checks.push({ name: "打包版 /api/health 200 + ready", pass: h.ok === true && h.ready === true, detail: JSON.stringify({ ok: h.ok, ready: h.ready, busy: h.busy, dll: h.dll, message: h.message }) });

    // ②③ 页面 console 0 + 截图
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("requestfailed", (r) => {
        // probeStopSupport 的 OPTIONS 特性探测（停止接口）失败是正常降级（停止按钮隐藏）——
        // 不属于运行时错误（阶段 B-19 设计：未上线接口 OPTIONS 探测静默降级）
        if (/\/api\/fullscan\/stop/.test(r.url()) && (r.method() === "OPTIONS" || r.failure() && /net::ERR_ABORTED/i.test(String(r.failure().errorText)))) return;
        errs.push("requestfailed: " + r.method() + " " + r.url() + (r.failure() ? " :: " + r.failure().errorText : ""));
    });
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await page.goto(BASE, { waitUntil: "load", timeout: 20000 }).catch((e) => { RESULT.gotoError = String(e); });
    await page.waitForFunction(() => document.querySelector("#health-badge") !== null || document.body.textContent.includes("就绪"), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const healthText = await page.evaluate(() => { const t = document.querySelector("#health-text"); return t ? t.textContent : document.body.innerText.split("\n").filter((l) => /就绪|检查|扫描/.test(l)).slice(0, 4).join(" | "); });
    const shot = path.join(OUT, "u67c-release-smoke.png");
    await page.screenshot({ path: shot });
    RESULT.shots.push(shot);
    RESULT.checks.push({ name: "页面渲染确定态（健康就绪可见）", pass: /就绪/.test(healthText), detail: shot + " healthText=" + JSON.stringify(healthText) });

    RESULT.consoleErrors = errs;
    RESULT.checks.push({ name: "页面 console 0（无未处理 Promise/运行时错误）", pass: errs.length === 0, detail: JSON.stringify(errs) });

    // ④ DLL 随包
    const exeDir = "D:/.python/文件大小扫描/releases/PythonDiskScanner-web";
    const dll64 = fs.existsSync(path.join(exeDir, "everything-SDK/dll/Everything64.dll"));
    const dll32 = fs.existsSync(path.join(exeDir, "everything-SDK/dll/Everything32.dll"));
    RESULT.checks.push({ name: "everything-SDK\\dll 随包存在", pass: dll64 && dll32, detail: "Everything64.dll=" + dll64 + " Everything32.dll=" + dll32 });

    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(RESULT, null, 2));
    console.log("result=" + path.join(OUT, "result.json"));
    const fails = RESULT.checks.filter((c) => !c.pass);
    console.log("checks=" + RESULT.checks.length + " fail=" + fails.length);
    fails.forEach((f) => console.log("FAIL " + f.name + " :: " + f.detail));
    await browser.close();
    process.exit(fails.length ? 1 : 0);
})();