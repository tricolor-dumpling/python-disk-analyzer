/* ============================================================
   UI 2.0（SpaceLens Pro）· components/topbar.js（U2.0 从 app.js 迁入）
   - 顶栏徽章与引导态（§3.6 机制 #4/#8/#10）：
     refreshHealth / showBrowseGuide / hideBrowseGuide / evaluateEnvGate 逐字保留；
   - U3.1 顶栏改版（徽章 popover/搜索框）时本模块为落点。
   ============================================================ */

import { $, api } from "../api.js";
import { APP_STATE } from "../state.js";
import { openSettings } from "./settings.js";
import { browsePath, getCurrentRoot } from "../pages/workspace.js";
import { showGuide } from "./onboarding.js";
import { setStatus } from "./statusbar.js";

export async function refreshHealth() {
    const badge = $("health-badge");
    try {
        const data = await api("/api/health");
        APP_STATE.health = data;
        // P12·W2.1：busy ≠ 未就绪——busy 时保持现有徽章 class 不降级＋中性文本
        if (data.ready) {
            badge.className = "badge badge-ok";
            $("health-text").textContent = data.message || "Everything 已就绪";
            badge.title = data.dll ? "Everything DLL：" + data.dll : "";
        } else if (data.busy) {
            $("health-text").textContent = "扫描中…";
            badge.title = "扫描中：" + (data.reason || "scanning");
        } else {
            badge.className = "badge badge-warn";
            $("health-text").textContent = data.message || "Everything 未就绪";
            badge.title = data.dll ? "Everything DLL：" + data.dll : "";
        }
        return data; // P12·W1.3：门控求值需要完整 health 载荷
    } catch (e) {
        badge.className = "badge badge-err";
        $("health-text").textContent = "健康检查失败";
        return null;
    }
}

export function showBrowseGuide(h) {
    const box = $("browse-guide");
    if (!box) return;
    let title = "Everything 尚未就绪";
    let msg = "正在等待 Everything 就绪，正在加载索引，最长约 20 秒，请勿重复点击。";
    if (h && h.degraded === "not_installed") {
        title = "未检测到 Everything";
        msg = (h.message || "未检测到 Everything") + "；安装并启动后点击「重试环境检测」。";
    } else if (h && h.degraded === "dll") {
        title = "SDK DLL 缺失";
        msg = (h.message || "SDK DLL 缺失或配置失效") + "；请确认程序目录包含 everything-SDK\\dll 后重试。";
    } else if (h && h.degraded === "config") {
        title = "配置文件损坏";
        msg = (h.message || "配置文件损坏") + "；可在数据目录修复 config.json 后重试。";
    } else if (h && h.busy) {
        title = "扫描进行中";
        msg = h.message || "全量扫描进行中，完成后即可浏览。";
    }
    $("guide-title").textContent = title;
    $("guide-msg").textContent = msg;
    box.classList.remove("hidden");
}

export function hideBrowseGuide() {
    const box = $("browse-guide");
    if (box) box.classList.add("hidden");
}

/* 环境门控（RT-02 边界）：只在首次加载与「重试环境检测」两处求值；
   15s 轮询只刷徽章、绝不重评本门控。ready → 自动浏览首根；否则进引导态。 */
export function evaluateEnvGate(h) {
    if (!h) {
        showBrowseGuide(null);
        return;
    }
    if (h.ready) {
        hideBrowseGuide();
        browsePath(getCurrentRoot() || "D:\\", true);
    } else {
        showBrowseGuide(h);
    }
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的引导/徽章/引导态段） */
export function bindTopbar() {
    $("btn-guide").addEventListener("click", showGuide);
    // 健康徽章 → 设置（含 Everything 详情）
    $("health-badge").addEventListener("click", openSettings);
    // P12·W1.3 引导态：重试环境检测（门控第二求值点）与查看指引
    const guideRetry = $("btn-guide-retry");
    if (guideRetry) guideRetry.addEventListener("click", async () => {
        setStatus("browse-status", "busy", "正在重试环境检测…");
        const h = await refreshHealth();
        evaluateEnvGate(h);
    });
    const guideHelp = $("btn-guide-help");
    if (guideHelp) guideHelp.addEventListener("click", showGuide);
}
