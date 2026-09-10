/* ============================================================
   UI 2.0（SpaceLens Pro）· components/drives.js（P5 新增·D5-3/D5-4）
   - 本地盘符清单的**唯一来源** = 后端 GET /api/roots（复用 fullscan._enumerate_roots，
     只读复用、实现体零改动）。P5 前前端在 workspace.js 模板里硬编码
     `C:\ D:\ E:\ F:\` 四个 option、默认根兜底写死 "D:\\"——真机上多一个盘就选不到，
     少一个盘就选了不存在的盘（问题 7 的第二半：「首次启动没有选盘，也不知道该选哪个」）。
   - 本模块只做三件事：取清单（带 in-flight 去重）/ 归一化 / 记住用户选择。
     不渲染任何 DOM（渲染归 onboarding.js 与 workspace.js），保持零循环依赖。
   - 可用性：`ready=false`（未就绪/无介质）的盘符**保留在清单里**（UI 灰置但可见），
     不静默丢弃——静默丢弃会让用户以为程序没看见他的盘。
   ============================================================ */

import { api, postJson } from "../api.js";

export const PICK_KEY = "pds_selected_drives_v1";

/* 归一化盘符：去尾部反斜杠 → "D:"；统一大写盘符字母 */
export function driveLabel(root) {
    const s = String(root || "").trim().replace(/[\\/]+$/, "");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/* 清单排序：可用盘在前（稳定：同组按盘符字典序）——选盘列表把能用的排前面 */
function sortDrives(list) {
    return list.slice().sort((a, b) => {
        if (!!b.ready !== !!a.ready) return b.ready ? 1 : -1;
        return String(a.root).localeCompare(String(b.root));
    });
}

let cache = null;      // 成功取回的清单（含 ready/label）
let inflight = null;   // 进行中的请求（同一 tick 内多次调用只打一次接口）
let failed = null;     // 取清单失败原因（UI 据此显示「请选择盘符」而不编造盘符）

/* 取盘符清单（幂等；失败返回空数组并记 failed，绝不硬编码兜底） */
export async function loadDrives() {
    if (cache) return cache;
    if (!inflight) {
        inflight = (async () => {
            try {
                const data = await api("/api/roots");
                cache = sortDrives((data && data.roots) || []);
                failed = null;
            } catch (e) {
                cache = [];
                failed = e && e.message ? e.message : String(e);
            } finally {
                inflight = null;
            }
            return cache;
        })();
    }
    return inflight;
}

export function getDrives() { return cache ? cache.slice() : null; }
export function drivesFailed() { return failed; }
export function resetDrivesCache() { cache = null; inflight = null; failed = null; }

/* 后端选盘结果 → 设置：写 last_roots（与设置弹窗同一键；截断 5 项由后端校验兜底）。
   失败不抛（选盘只是引导步骤，不该阻塞首开）——返回 {ok, error} 供 UI 决定是否提示。 */
export async function saveSelectedRoots(roots) {
    const clean = (roots || [])
        .map((r) => String(r || "").trim())
        .filter(Boolean)
        .slice(0, 5);
    try {
        localStorage.setItem(PICK_KEY, JSON.stringify(clean));
    } catch (e) { /* localStorage 不可用时仅本次会话生效 */ }
    if (!clean.length) return { ok: true, saved: false, roots: clean };
    try {
        await postJson("/api/settings", { last_roots: clean });
        return { ok: true, saved: true, roots: clean };
    } catch (e) {
        return { ok: false, saved: false, roots: clean, error: e && e.message ? e.message : String(e) };
    }
}

/* 上次选中的盘（localStorage 记忆；引导「跳过」后再打开时可回显） */
export function lastPickedRoots() {
    try {
        const raw = localStorage.getItem(PICK_KEY);
        const v = raw ? JSON.parse(raw) : null;
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch (e) {
        return [];
    }
}
