/* ============================================================
   UI 2.0（SpaceLens Pro）· components/statusbar.js（U2.0 模块化迁入）
   - setStatus 状态行工具（browse/scan/compare 共用）；
     App Shell 的 32px 常驻状态栏（F22）内容装配归 U2.x statusbar 组件。
   ============================================================ */

import { $ } from "../api.js";

/* kind: "" | ok | warn | err | busy */
export function setStatus(id, kind, text) {
    const el = $(id);
    if (!el) return; // U2.1：路由切至子页面时目标状态行不在 DOM（全局轮询容错）
    el.className = "status-line" + (kind ? " " + kind : "");
    const textEl = $(id + "-text");
    if (textEl) textEl.textContent = text;
}

/* F22（G3 核销）：状态栏右侧「已选 N 项」——多选时显示、清零隐藏；
   由 list.js refreshSelectionUI 统一调用（selection 单一来源 APP_STATE.selection） */
export function renderStatusbarSelection(n) {
    const el = $("statusbar-selected");
    if (!el) return; // smoke 脚手架无该元素（空守卫）
    const count = Number(n) || 0;
    el.hidden = count <= 0;
    el.textContent = count > 0 ? "已选 " + count + " 项" : "";
}
