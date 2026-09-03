/* ============================================================
   UI 2.0（SpaceLens Pro）· main.js 入口装配（U2.0 建，U2.1 路由化）
   - 装配顺序：壳级绑定（顶栏/主题/设置/弹窗族）
     → router 初始化（首渲染当前路由，默认工作台直装）
     → 工作台页挂载（页面内容绑定）
     → 原 init 异步链（偏好/快照/扫描轮询/概览/健康门控）；
   - 页面注册表在此注入 router（装配根，router 零业务依赖、模块图无环）；
   - smoke 页导入面另行导出（选择器不变因 id 未变）。
   ============================================================ */

import { $, api } from "./api.js";
import { toast } from "./components/toast.js"; // B-19：顶栏扫描按钮反馈 toast
import { APP_STATE } from "./state.js";
import { switchTheme, setThemePref, themePref, resolvedTheme, syncThemeControls } from "./theme.js"; // U3.5：三态偏好（设置弹窗/同源联动）
import { createRouter } from "./router.js";
import { loadGuide, bindOnboarding, showGuide } from "./components/onboarding.js";
import { refreshOverview, bindOverview } from "./components/storage.js";
import { bindSnapshotMini, renderCompareMini } from "./components/snapshot-mini.js";
import {
    bindWorkspace, renderEntries, browsePath,
    getCurrentRoot, getCurrentPath, getLastRoots, setCurrentRoot, applyLastRoots,
    getBrowseHistory, renderWorkspace, unmountWorkspace, restoreWorkspaceView,
    getTreemapView, getTreemapTiles, setMergeTop, renderTreemapFromState,
    getStartupBrowsePath,
} from "./pages/workspace.js";
import { evaluateEnvGate, refreshHealth, bindTopbar, bindWorkspaceGuide } from "./components/topbar.js";
import { markNavDot } from "./components/nav-dots.js"; // U3.1：N13 圆点（探针/引导面再导出）
import { pollFullscan, startFullscan, saveSnapshot, setAutoSaveSetting, undoLastSave, bindScan, applyScanView, probeStopSupport, isStopAvailable, requestStopScan, isSaveAvailable, downloadExport } from "./components/scan.js";
import { refreshSnapshots, getSessionsCache, setSessionsCache, applySnapshotsView, setSnapshotsActions } from "./pages/snapshots.js";
import { renderCompare, mountCompare, unmountCompare } from "./pages/compare.js";
import { renderSnapshots, mountSnapshots, unmountSnapshots } from "./pages/snapshots.js";
import { bindSettings, openSettings, setDataDir, setStatusForSettingsHealth, openWipeModal } from "./components/settings.js";
import { bindModals, openModal, closeModal } from "./components/modals.js";
import { renderApiError } from "./components/feedback.js";
import {
    setPaletteBuilder, bindPalette, openPalette, closePalette, isPaletteOpen, fuzzyScore,
} from "./components/palette-cmd.js";
import { bindKeyboard } from "./keyboard.js"; // U4.1：键盘矩阵（/ 聚焦筛选、g c/g s 连按跳页、treemap 方向键/Enter）

/* 主题按钮（U1.1 临时入口：U3.1 顶栏改版时移正——现按壳级接线保留在 start()，已归位）
   U3.5：顶栏=亮/暗显式翻转（N03 太阳/月亮语义），与设置弹窗三态同源（theme.js 单一来源）；
   翻转写入显式偏好（退出「跟随系统」），设置弹窗单选同步反映。 */
function bindTheme() {
    const themeBtn = $("btn-theme");
    if (themeBtn) themeBtn.addEventListener("click", (ev) => switchTheme(undefined, ev));
}

/* ================= U3.1：顶栏「开始扫描」（N05 骨架：全局态随 pds:scan；
   空闲=点击回主页并触发全量扫描；扫描中=微型进度环，点击回主页。
   完整状态机（停止/计时/完成分支）U3.2 补——此处只做骨架与跳转） ================= */

function navigateAndRun(route, action) {
    if (APP_STATE.route === route) { action(); return; }
    const onNav = (ev) => {
        if (ev.detail && ev.detail.route === route) {
            window.removeEventListener("pds:navigate", onNav);
            action();
        }
    };
    window.addEventListener("pds:navigate", onNav);
    location.hash = "#" + route;
}

function bindScanTop() {
    const btn = $("btn-scan-top");
    if (!btn) return;
    const label = btn.querySelector(".topbar-scan-label");
    const ring = btn.querySelector(".topbar-scan-ring");
    const arc = btn.querySelector(".scan-ring-arc");
    const C = 2 * Math.PI * 9; // r=9（viewBox 24）；几何常量非时长/缓动魔法数
    if (arc) arc.style.strokeDasharray = String(C);
    let running = false;
    /* 阶段B（B-19）：启动提交态——空闲点击立即给按钮态反馈（disabled→「启动中…」），
       提交结果经 pds:scan 广播接管；3s 兜底恢复（POST 挂起不永久禁用）。
       不触碰 label 内 SVG 结构（u32 断言 .topbar-scan-label 内容）——追加独立徽标。 */
    let launching = false;
    let launchTimer = 0;
    let launchBadge = null;
    function setLaunchBadge(on) {
        if (on && !launchBadge && label) {
            launchBadge = document.createElement("span");
            launchBadge.className = "topbar-scan-launching";
            launchBadge.textContent = "启动中…";
            label.appendChild(launchBadge);
            btn.title = "正在提交扫描任务…";
            btn.setAttribute("aria-label", "正在启动全量扫描…");
        } else if (!on && launchBadge) {
            launchBadge.remove();
            launchBadge = null;
            btn.title = running ? "扫描中（点击回到工作台）" : "开始全量扫描";
            btn.setAttribute("aria-label", running ? "扫描中，点击回到工作台" : "开始扫描");
        }
    }
    /* B-19：扫描中点击（已在工作台）→ toast + 扫描卡高亮滚动 */
    function highlightScanCard() {
        const card = document.querySelector('section[aria-label="全量扫描"]');
        if (card) {
            try { card.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) { /* ignore */ }
            card.classList.remove("scan-card-flash");
            void card.offsetWidth;
            card.classList.add("scan-card-flash"); // 仅 opacity 脉动（P7），CSS 见 style.css
        }
    }
    function restoreLaunchLabel() {
        launching = false;
        clearTimeout(launchTimer);
        launchTimer = 0;
        setLaunchBadge(false);
        btn.disabled = false;
    }
    btn.addEventListener("click", () => {
        if (running || launching) {
            if (launching) return; // 提交中：等待广播，不重复提交
            // B-19：扫描中点击——已在工作台 → toast+高亮滚动；不在 → 回主页
            if (APP_STATE.route !== "/") { location.hash = "#/"; return; }
            const st = APP_STATE.scan || {};
            const pct = Number(st.progress_pct);
            toast(
                "扫描进行中" + (Number.isFinite(pct) ? " " + pct + "%" : "") +
                "（" + (Number(st.done) || 0) + "/" + (Number(st.roots && st.roots.length) || 0) + " 盘）",
                "info"
            );
            highlightScanCard();
            return;
        }
        // B-19：空闲点击 → 立即按钮态反馈（disabled→「启动中…」→toast「已提交」）
        launching = true;
        btn.disabled = true;
        setLaunchBadge(true);
        clearTimeout(launchTimer);
        launchTimer = setTimeout(() => {
            if (launching && !running) restoreLaunchLabel(); // 兜底：POST 挂起恢复
        }, 3000);
        navigateAndRun("/", startFullscan);
    });
    window.addEventListener("pds:scan", (ev) => {
        const st = ev.detail || {};
        running = !!st.running;
        btn.classList.toggle("is-scanning", running);
        if (label) label.hidden = running;
        if (ring) ring.hidden = !running;
        btn.setAttribute("aria-label", running ? "扫描中，点击回到工作台" : "开始扫描");
        btn.title = running ? "扫描中（点击回到工作台）" : "开始全量扫描";
        btn.disabled = false; // B-19：广播后解除启动禁用（提交已收敛到真实状态）
        if (launching) { launching = false; clearTimeout(launchTimer); launchTimer = 0; setLaunchBadge(false); }
        if (arc) {
            const v = Math.max(0, Math.min(100, Number(st.progress_pct) || 0));
            // arc 初始 dashoffset = C（空环）；运行时按 pct 折算（微型进度环骨架）
            arc.style.strokeDashoffset = String(running ? C * (1 - v / 100) : C);
        }
    });
}

function exportRaw(fmt) {
    // 阶段B（B-15）：命令面板导出与扫描卡同源——fetch/Blob 下载（不再新开标签裸展示错误 JSON）
    downloadExport(fmt);
}

function browseDrive(root) {
    navigateAndRun("/", () => {
        setCurrentRoot(root);
        const input = $("browse-root");
        if (input) input.value = root;
        browsePath(root);
    });
}

/* ================= U3.1：命令面板数据源/执行器表（main.js 注入——
   palette-cmd 零业务依赖；数据源走既有导出访问器；页面跳转=location.hash；
   命令=复用既有函数入口，不新增 API） ================= */

function buildPaletteItems() {
    const items = [];
    // 页面 ×3
    [
        { route: "/", label: "工作台", keywords: ["workspace", "home", "gzt"] },
        { route: "/compare", label: "对比", keywords: ["compare", "diff", "db"] },
        { route: "/snapshots", label: "快照", keywords: ["snapshots", "snapshot", "kz"] },
    ].forEach((p) => items.push({
        group: "页面", label: p.label, hint: "跳转到 #" + p.route, keywords: p.keywords,
        exec: () => { if (APP_STATE.route !== p.route) location.hash = "#" + p.route; },
    }));
    // 盘符（datalist 静态建议；与「最近访问」互为去重同源）
    const drives = new Set();
    const dl = $("roots-suggest");
    if (dl) dl.querySelectorAll("option").forEach((o) => drives.add(String(o.value || "").trim()));
    drives.forEach((d) => {
        if (!d) return;
        items.push({ group: "盘符", label: d, hint: "浏览 " + d, keywords: ["drive", "root", d.replace(/\\/g, "").toLowerCase()], exec: () => browseDrive(d) });
    });
    // 最近访问（lastRoots）
    getLastRoots().forEach((r) => items.push({
        group: "最近访问", label: r, hint: "重新打开 " + r, keywords: ["recent", "last", r.replace(/\\/g, "").toLowerCase()], exec: () => browseDrive(r),
    }));
    // 浏览历史（browseHistory，最近 8 条倒序）
    getBrowseHistory().slice(-8).reverse().forEach((p) => items.push({
        group: "浏览历史", label: p, hint: "返回 " + p, keywords: ["history", "hist"], exec: () => browsePath(p),
    }));
    // 快照（会话 × 未跳过盘；执行=打开快照页）
    getSessionsCache().slice(0, 6).forEach((s) => {
        Object.values(s.roots || {}).forEach((r) => {
            if (!r || r.skipped || !r.root) return;
            items.push({
                group: "快照",
                label: r.root + " · " + String(s.created_at || "").replace("T", " "),
                hint: "打开快照页", keywords: ["snapshot", "snap", "kz"],
                exec: () => { if (APP_STATE.route !== "/snapshots") location.hash = "#/snapshots"; },
            });
        });
    });
    // 命令（复用既有函数入口）
    items.push({ group: "命令", label: "开始扫描", hint: "全量扫描所有本地盘", keywords: ["scan", "start", "fullscan", "kssm"], exec: () => navigateAndRun("/", () => startFullscan()) });
    items.push({ group: "命令", label: "保存快照", hint: "把最近一次全量结果保存为快照", keywords: ["save", "snapshot", "bckz"], exec: () => saveSnapshot(false) });
    // U3.4：命令「开始对比」= 预填默认（最近一份）+ 跳 #/compare（替换旧工作台卡 compareSnapshots）
    items.push({ group: "命令", label: "开始对比", hint: "对比工作台（基线默认最近一份）", keywords: ["compare", "diff", "ksdb"],
        exec: () => {
            APP_STATE.compare.baseline = "";
            APP_STATE.compare.root = getCurrentRoot();
            APP_STATE.compare.result = null; // 强制新一轮（默认基线）
            if (APP_STATE.route === "/compare") {
                const input = document.getElementById("compare-baseline");
                if (input) input.value = ""; // 已在本页：清输入后重跑（默认基线）
                const cmp = document.getElementById("btn-compare");
                if (cmp) cmp.click();
            } else {
                location.hash = "#/compare";
            }
        } });
    items.push({ group: "命令", label: "导出 CSV", hint: "当前目录导出为 CSV", keywords: ["export", "csv", "dc"], exec: () => exportRaw("csv") });
    items.push({ group: "命令", label: "导出 JSON", hint: "当前目录导出为 JSON", keywords: ["export", "json", "dc"], exec: () => exportRaw("json") });
    items.push({ group: "命令", label: "切换主题", hint: "亮 / 暗主题", keywords: ["theme", "dark", "light", "qhzt"], exec: () => switchTheme(undefined, null) });
    items.push({ group: "命令", label: "打开设置", hint: "自动保存、数据目录与危险区", keywords: ["settings", "config", "dksz"], exec: () => openSettings() });
    items.push({ group: "命令", label: "使用指引", hint: "重新打开首启引导", keywords: ["guide", "help", "syzy"], exec: () => showGuide() });
    return items;
}

/* 工作台页挂载（页面内容绑定集合 = 原 bind() 的页面段；组成见 U2.0 注记）
   随后从模块级状态回灌视图（切页不丢：状态与显示均保持）。
   概览刷新仅回挂路径执行——首挂仍由 start() 的 init 链按历史时序
   （settings→snapshots→status→overview→health→browse）负责，
   保证 Network 时序与重构前一致（验收①）。 */
let _workspaceMountedOnce = false;
function mountWorkspacePage() {
    bindOverview();
    bindWorkspace();
    bindScan();
    // U3.4：bindCompare 随旧「历史对比」卡摘除——对比交互整体迁 #/compare 页
    //（mountCompare 负责页面接线；主页仅剩「最近对比」迷你入口）
    bindSnapshotMini();   // U2.4：管理快照/全部会话折叠/最近对比入口
    renderCompareMini();  // U2.4：最近对比迷你卡（state.compare.lastSummary 回灌）
    bindWorkspaceGuide();
    if (_workspaceMountedOnce) refreshOverview();
    applySnapshotsView();     // 快照列表/基线下拉回灌（含 N06 迷你条目）
    applyScanView();          // 扫描卡最近状态回灌
    restoreWorkspaceView();   // 浏览视图回灌（缓存渲染，不重发请求）
    _workspaceMountedOnce = true;
}

/* 页面注册表（router 由 main 装配，保持 router 零业务依赖） */
const pages = {
    "/": { name: "workspace", render: renderWorkspace, mount: mountWorkspacePage, unmount: unmountWorkspace },
    "/compare": { name: "compare", render: renderCompare, mount: mountCompare, unmount: unmountCompare },
    "/snapshots": { name: "snapshots", render: renderSnapshots, mount: mountSnapshots, unmount: unmountSnapshots },
};
const router = createRouter(pages);

export function __router() { return router; }

/* 启动：壳绑定 → 路由初始化（首渲染）→ 工作台挂载 → 原 init 链 */
export async function start() {
    bindTopbar();
    bindTheme();
    bindSettings();
    bindModals();
    bindOnboarding();   // U3.1：引导弹层迁壳级（close 按钮绑定一次，不等页面挂载）
    bindPalette();      // U3.1：命令面板（Ctrl/⌘K、面板内键盘）
    bindKeyboard();     // U4.1：键盘矩阵（/ 聚焦筛选、g c/g s 连按跳页、treemap 方向键/Enter）
    bindScanTop();      // U3.1：顶栏开始扫描（N05 骨架；U3.2 完整态随状态机数据）
    probeStopSupport(); // U3.2：停止接口特性探测（OPTIONS 零副作用；404 → 隐藏停止按钮）
    setPaletteBuilder(buildPaletteItems); // U3.1：执行器表注入（palette 零业务依赖）
    // U3.3：快照页页头动作注入（创建=保存流程 / 撤销=确认弹窗流程 / 可用性镜像扫描状态；
    // 防 scan↔snapshots 环——snapshots.js 零 scan.js 依赖）
    setSnapshotsActions({ create: () => saveSnapshot(false), undo: undoLastSave, canCreate: isSaveAvailable });
    router.init();
    loadGuide();

    // 读取偏好（自动保存开关 + 最近浏览）
    try {
        const data = await api("/api/settings");
        setAutoSaveSetting(!!data.settings.auto_save);
        setDataDir(data.data_dir || "");
        const roots = data.settings.last_roots;
        if (Array.isArray(roots) && roots.length) {
            applyLastRoots(roots.slice(0, 5));
        }
    } catch (e) { /* 设置读取失败不影响使用 */ }

    refreshSnapshots();
    pollFullscan(); // 页面刷新后也能恢复「扫描中」状态
    refreshOverview();

    const firstRoot = getLastRoots()[0] || "D:\\";
    /* F06（U4.2 G1 核销）：启动恢复上次浏览位置（pds_last_browse_v1——成功浏览时写入；
       非法/缺失回落首根；恢复路径经既有 init 链同一 browse 调用加载——零额外请求） */
    const startup = getStartupBrowsePath();
    setCurrentRoot((startup && startup.root) || firstRoot);
    $("browse-root").value = (startup && startup.path) || firstRoot;

    // P12·W1.3 init 门控（RT-02 边界：仅首拍求值；替换旧的无条件浏览）：
    // ready → 自动浏览首根；未就绪 → 引导态。15s 轮询只刷徽章不重评门控。
    const h = await refreshHealth();
    evaluateEnvGate(h);

    setInterval(refreshHealth, 15000);
}

start();

/* ================= smoke 页导入面（行为等价；选择器不变因 id 未变） =================
   按需导出：旧全局写法（window.switchTheme 等）改为显式导入；smoke 断言经
   访问器读取/恢复状态（getSessionsCache/setSessionsCache、getCurrentPath）。
   U2.2：treemap 访问器（A12 命中断言 + 附录B 1000 块基准控制台桥）。 */
export {
    $, APP_STATE, switchTheme,
    /* U3.5：主题三态（设置弹窗接线 + smoke A19 断言面） */
    setThemePref, themePref, resolvedTheme, syncThemeControls,
    renderApiError, refreshSnapshots, refreshHealth, setStatusForSettingsHealth,
    undoLastSave, renderEntries, openModal, closeModal, browsePath,
    getCurrentPath, getSessionsCache, setSessionsCache,
    getTreemapView, getTreemapTiles, setMergeTop, renderTreemapFromState,
    /* U3.1：命令面板/圆点/访问器（探针与 smoke 断言面） */
    openPalette, closePalette, isPaletteOpen, fuzzyScore, markNavDot,
    getBrowseHistory,
    /* U3.2：停止接口（探针与 smoke A16 断言面） */
    probeStopSupport, isStopAvailable, requestStopScan,
    /* U3.5：清空确认弹窗（A19/探针走查入口） */
    openWipeModal,
};
