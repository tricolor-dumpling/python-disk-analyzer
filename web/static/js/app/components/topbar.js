/* ============================================================
   UI 2.0（SpaceLens Pro）· components/topbar.js（U2.0 从 app.js 迁入；U3.1 顶栏改版）
   - 顶栏徽章与引导态（§3.6 机制 #4/#8/#10）：
     refreshHealth / showBrowseGuide / hideBrowseGuide / evaluateEnvGate 逐字保留；
   - U3.1：
     · [N13] L2-11 导航下划线（#nav-underline：translateX+scaleX 240ms ease-inout，
       仅 transform 动画——宽度差经 scaleX 补偿，等价「translateX+width」滑动；
       pds:navigate 与 resize 时同步，reduced 由全局降级规则直切）；
     · [N13] 非活动标签圆点提醒（markNavDot：扫描完成/快照保存成功/对比完成三触发，
       触发时用户不在对应页才挂点；点击对应标签消除；pds:navigate 时同步显示）；
     · [F01] 徽章三态（N11 文案）呼吸 L2-8 + 点击 popover（数据目录/驱动状态/
       重试环境检测=红线 #8 evaluateEnvGate 第二求值点：重试只重评门控，
       15s 轮询只刷徽章不重评——语义保留；视图区引导条按定稿 6.3 保留，A8 不动）。
   ============================================================ */

import { $, api } from "../api.js";
import { APP_STATE } from "../state.js";
import { openModal, closeModal } from "./modals.js";
import { getDataDir } from "./settings.js";
import { bindNavDots } from "./nav-dots.js"; // U3.1：N13 圆点（叶子模块，防环）
import { browsePath, getCurrentRoot, getStartupBrowsePath } from "../pages/workspace.js";
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
            $("health-text").textContent = "已就绪·可开始扫描"; // U3.1：N11 文案统一
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
        /* F06（U4.2 G1 核销）：启动恢复上次浏览位置——优先恢复路径，缺失回落首根/默认 D:\；
           恢复路径与旧「首根浏览」共用同一次 browse 调用（Network 时序不变，零额外请求） */
        const startup = getStartupBrowsePath();
        browsePath((startup && startup.path) || getCurrentRoot() || "D:\\", true);
    } else {
        showBrowseGuide(h);
    }
}

/* ================= U3.1：L2-11 导航下划线（仅 transform 动画） ================= */

export function syncNavUnderline() {
    const ul = $("nav-underline");
    if (!ul) return;
    const tabs = Array.from(document.querySelectorAll(".nav-tabs .nav-tab"));
    const active = tabs.find((a) => a.classList.contains("is-active"));
    if (!active || !tabs.length) return;
    const maxW = Math.max.apply(null, tabs.map((a) => a.offsetWidth).concat([1]));
    const w = active.offsetWidth;
    ul.style.width = maxW + "px";
    ul.style.transform = "translateX(" + active.offsetLeft + "px) scaleX(" + (w / maxW) + ")";
}

/* ================= U3.1：N13 圆点提醒 =================
   （markNavDot/renderDots/bindNavDots 在独立叶子模块 nav-dots.js——
   scan.js/compare.js 直接导入该模块触发，避免 scan↔topbar↔settings 模块环） */

/* ================= U3.1：F01 徽章 popover ================= */

function renderPopover(h) {
    $("popover-data-dir").textContent = getDataDir() || "未知";
    $("popover-health").textContent = h
        ? (h.message || (h.ready ? "已就绪·可开始扫描" : "Everything 未就绪"))
        : "健康检查失败";
    $("popover-health-dll").textContent = (h && h.dll) ? h.dll : "";
}

export function openHealthPopover() {
    renderPopover(APP_STATE.health);
    openModal("health-popover");
}

function closeHealthPopover() {
    closeModal("health-popover");
}

async function retryEnvGate() {
    const btn = $("btn-popover-retry");
    if (btn) btn.disabled = true;
    setStatus("browse-status", "busy", "正在重试环境检测…");
    const h = await refreshHealth();
    renderPopover(h);
    evaluateEnvGate(h); // 红线 #8：重试=门控第二求值点（与视图区引导条重试一致）
    if (btn) btn.disabled = false;
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的引导/徽章段；壳级） */
export function bindTopbar() {
    $("btn-guide").addEventListener("click", showGuide);
    // 健康徽章 → popover（U3.1；旧 openSettings 入口由设置按钮承担）
    $("health-badge").addEventListener("click", () => {
        if ($("health-popover").classList.contains("hidden")) openHealthPopover();
        else closeHealthPopover();
    });
    $("btn-popover-retry").addEventListener("click", retryEnvGate);
    // [N13] 圆点：点击对应标签消除 + 路由变化同步（nav-dots 叶子模块）
    bindNavDots();
    // [N13] 下划线随路由与布局变化同步
    window.addEventListener("pds:navigate", syncNavUnderline);
    window.addEventListener("resize", syncNavUnderline);
    // 首帧布局完成后同步一次（字体/布局稳定兜底；pds:navigate 先行）
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(syncNavUnderline);
}

/* 引导态重试/帮助按钮：位于工作台页（route-view 渲染内容），随页挂载 */
export function bindWorkspaceGuide() {
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

/* [N13] 导航标签（顶栏壳级）：<a href="#/compare"> 原生锚点行为即为唯一接线
   （hashchange → router 转场；激活态由 router 于 pds:navigate 维护）；
   下划线滑动动效（L2-11）已由上 段接线（syncNavUnderline）。 */
