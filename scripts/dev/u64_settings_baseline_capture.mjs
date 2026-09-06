/* E-5 基线先行：亮/暗两档设置弹窗基线截图（排版修改前）——逐像素对比的基线 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright");

const OUT = path.resolve(process.argv[2] || path.join(process.env.TEMP || ".", "u64_settings_baseline"));
fs.mkdirSync(OUT, { recursive: true });

const STUB = `
window.__stub = { startCount: 0 };
window.fetch = function (url, options) {
  options = options || {};
  const key = (options.method || "GET").toUpperCase() + " " + String(url).split("?")[0];
  const json = (o, s) => Promise.resolve({ ok: (s || 200) < 400, status: s || 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(o))) });
  if (key === "OPTIONS /api/fullscan/stop") return json({ ok: true }, 200);
  if (key === "GET /api/health") return json({ ok: true, ready: true, dll: "stub-dll", message: "Everything 已就绪", busy: false });
  if (key === "GET /api/settings") return json({ ok: true, settings: { auto_save: true, last_roots: ["D:\\\\", "C:\\\\"] }, data_dir: "C:\\\\Users\\\\demo\\\\PythonDiskScanner", snapshots_dir: "C:\\\\Users\\\\demo\\\\PythonDiskScanner\\\\snapshots" });
  if (key === "POST /api/settings") return json({ ok: true, settings: {} });
  if (key === "POST /api/browse") return json({ ok: true, root: "D:\\\\", parent: null, directories: [{ name: "data", path: "D:\\\\data", is_dir: true, size: 12000, size_human: "11.72 KB" }], files: [{ name: "readme.txt", path: "D:\\\\readme.txt", is_dir: false, size: 100, size_human: "100 B" }], total_dirs: 1, total_files: 1, source: "sdk", source_at: "2026-09-05T12:00:00" });
  if (key === "GET /api/fullscan/status") return json({ ok: true, status: { running: false, roots: ["C:\\\\", "D:\\\\"], roots_done: 0, roots_total: 2, current_root: null, error: null, result_ready: false, save_ready: false, progress_pct: 0, scan_version: 1, stop_requested: false, stop_reason: null, phase: "idle", lock_holder: null, row_done: 0, row_total: 0, stop_ack_at: null } });
  if (key === "POST /api/fullscan/start") { window.__stub.startCount += 1; return json({ ok: true, message: "ok" }); }
  if (key === "GET /api/snapshots") return json({ ok: true, sessions: [], count: 0 });
  if (key === "GET /api/overview") return json({ ok: true, ready: false, scanning: false, empty_reason: "no_scan", roots: [] });
  if (key === "GET /api/export") return json({ ok: false, error: "x" }, 404);
  return json({ ok: true });
};
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.addInitScript((t) => { try { localStorage.setItem("pds_theme_v1", t); } catch (e) {} }, theme);
    await page.addInitScript(() => { try { localStorage.setItem("pds_onboarding_dismissed_v1", "1"); } catch (e) {} try { sessionStorage.setItem("pds_auto_started_v1", "1"); } catch (e) {} });
    await page.addInitScript(STUB);
    await page.goto("http://127.0.0.1:5000/", { waitUntil: "load", timeout: 20000 });
    await page.waitForFunction(() => !!document.getElementById("btn-settings"), { timeout: 15000 });
    await page.click("#btn-settings");
    await page.waitForFunction(() => !document.getElementById("settings-modal").classList.contains("hidden"), { timeout: 10000 });
    await page.waitForTimeout(500);
    const f = path.join(OUT, `settings-baseline-${theme}.png`);
    await page.screenshot({ path: f, clip: { x: 380, y: 100, width: 606, height: 600 } });
    console.log("baseline " + theme + " -> " + f);
    await ctx.close();
  }
  await browser.close();
})();
