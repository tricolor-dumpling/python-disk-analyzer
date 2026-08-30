/* ============================================================
   UI 2.0（SpaceLens Pro）· components/feedback.js（U2.0 模块化迁出）
   - renderApiError 统一 API 错误渲染器（§3.6 机制 #4）逐字保留；
   - 独立叶子模块：workspace（浏览错误）与 U3.2 扫描/对比共用，
     避免 workspace ↔ topbar 互引成环。
   ============================================================ */

import { esc } from "../api.js";
import { showGuide } from "./onboarding.js";

/* 统一 API 错误渲染器：主文案 + 错误码标记（仅新形态）+ detail 小字 +
   [重试][查看帮助]。err.code===undefined 即旧形态错误响应，仅显示主文案。 */
export function renderApiError(box, err, onRetry) {
    if (!box) return;
    const hasCode = err && err.code !== undefined && err.code !== null;
    box.innerHTML =
        esc((err && err.message) || "请求失败") +
        (hasCode ? ' <span class="tag tag-skip">错误码 ' + esc(String(err.code)) + "</span>" : "") +
        (err && err.detail ? '<div class="muted">' + esc(err.detail) + "</div>" : "") +
        ' <button class="btn btn-sm" data-api-retry>重试</button> <button class="btn btn-sm btn-ghost" data-api-help>查看帮助</button>';
    const retryBtn = box.querySelector("[data-api-retry]");
    if (retryBtn) retryBtn.addEventListener("click", () => { if (typeof onRetry === "function") onRetry(); });
    const helpBtn = box.querySelector("[data-api-help]");
    if (helpBtn) helpBtn.addEventListener("click", showGuide);
}
