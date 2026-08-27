/* ============================================================
   UI 2.0（SpaceLens Pro）· components/statusbar.js（U2.0 从 app.js 迁入）
   - setStatus 状态行工具（browse/scan/compare 共用）；
     App Shell 的 32px 常驻状态栏（F22）内容装配归 U2.x statusbar 组件。
   ============================================================ */

import { $ } from "../api.js";

/* kind: "" | ok | warn | err | busy */
export function setStatus(id, kind, text) {
    const el = $(id);
    el.className = "status-line" + (kind ? " " + kind : "");
    $(id + "-text").textContent = text;
}
