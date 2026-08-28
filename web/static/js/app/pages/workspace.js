/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/workspace.js（U2.0 从 app.js 迁入）
   - 目录浏览卡片全套逻辑逐一迁入（§3.6 机制 #1 browseSeq 竞态、
     #11 文件行零请求、#12 筛选空态清除）；
   - ⚠️ 偏差注记：映射表既定「browse-chart 与 renderComposition 删除（D12）」
     本项落地——renderComposition 函数及其 2 处调用移除（U1.3 已用 CSS 隐藏过渡，
     视觉无变化；Treemap 由 U2.2 承接）；
   - U2.2：视图区接入 treemap（viz/treemap.js 渲染器 + palette.js 取色）：
     · 数据接入 = /api/browse 响应 children（directories+files）→ tiles
       [{key:path,name,size,pct,color,path,isDir,isOther}]；
       ⚠️ 偏差注记：browse 实际字段 = name/path/is_dir/size/size_human
       （app.py api_browse 核对确认；手册「children」表述为数据结构语义）；
     · state.view.mergeTop（默认 24）之外的项并入「其他」（fixed color）；
     · ⚠️ 裁决：默认视图保持「排行」至 U2.5（v2-A4/A5/A6 断言基于排行行渲染，
       不可静默破坏；定稿 N01「默认矩形图」由 U2.5 三视图框架统一切换时接管）；
     · hit 回调：仅目录块（isDir && !isOther）触发 browsePath——文件块 0 请求
       （红线 #11 在 treemap 语义下同样成立，smoke A12 双向断言）。
   - U2.3：交互与特效接线：
     · 单击下钻（confirme 后 FLIP 450ms 预览）+ 双击回本级根（300ms 防抖窗口，
       渲染器侧判定）+ Backspace 上级（键盘矩阵 §7.4 的 Backspace 部分，U4.1 收口其余）；
     · 返回上级反向播放（zoomOutTo——需上级构成缓存，缓存缺失时直入场并记偏差）；
     · 迷你条带（L3-7：48px 上级构成，数据=本模块 browsesCache 上级响应缓存，
       DOM 渲染静态不动画，hover 提亮+title，点击跳回；盘根/无缓存隐藏）；
     · 合并阈值 −/+（L3-9：工具栏步长 10，min 1 / max 200，reflow lerp 300ms 重排）；
     · 全屏（L3-8：view-area fixed 铺满 + 压暗 veil（--veil）+ FLIP 300ms + Esc 退出；
       工具栏 z 提层保持可点（「Esc 或工具栏退出」）；
     · 扫描实时生长（L3-2：pds:scan 事件驱动——主页矩形图 500ms 高频、子页面 2s
       低频更新缓存，reflow lerp 300ms + 新块光晕；扫描中雷达扫掠 L3-3 setSweep）；
     · L2-5 双向联动（事件委托数据层：tile hover → 列表行高亮+scrollIntoView；
       行 hover → hoverKey——⚠️ 偏差：§3.2 布局中列表与矩形图为互斥视图，双侧
       联动机制已就位，待 U2.5 三视图框架或双栏形态显式激活后可见生效）。
   - 跨模块可变状态经导出访问器读写（模块化拆分导出 setter/getter，行为等价）。
   ============================================================ */

import { $, esc, postJson, humanBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { createTreemap } from "../viz/treemap.js";
import { colorFor, OTHER_COLOR } from "../palette.js";
import { toast } from "../components/toast.js";
import { setStatus } from "../components/statusbar.js";
import { renderApiError } from "../components/feedback.js";
import { flip as motionFlip, motionDur } from "../motion.js";

/* ================= 目录浏览 ================= */

let currentRoot = "D:\\"; // 用户本次浏览会话的根（面包屑/返回不越过它）
let currentPath = "D:\\"; // 当前正在查看的目录
let browseHistory = [];

export function getCurrentRoot() { return currentRoot; }
export function setCurrentRoot(v) { currentRoot = v; }
export function getCurrentPath() { return currentPath; }
export function resetBrowseHistory() { browseHistory = []; }

/* P12·W1.4 行动闭环：行内 hover 操作区（打开所在文件夹 / 复制路径） */
function rowActions(path) {
    return (
        '<span class="row-actions">' +
        '<button class="icon-btn act-open" data-act-path="' + esc(path) + '" title="打开所在文件夹" aria-label="打开所在文件夹">' + ICONS.folder + "</button>" +
        '<button class="icon-btn act-copy" data-act-path="' + esc(path) + '" title="复制路径" aria-label="复制路径">' + ICONS.copy + "</button>" +
        "</span>"
    );
}

/* 复制路径：clipboard API → execCommand 兜底（临时 textarea）→ toast */
export async function copyPath(path) {
    let ok = false;
    try {
        await navigator.clipboard.writeText(path);
        ok = true;
    } catch (e) {
        try {
            const ta = document.createElement("textarea");
            ta.value = path;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ok = document.execCommand("copy");
            ta.remove();
        } catch (e2) { ok = false; }
    }
    toast(ok ? "已复制路径：" + path : "复制失败，请手动选择路径复制", ok ? "success" : "error");
}

/* 打开所在文件夹：POST /api/open-path（explorer /select），按 launched 分文案 */
export async function openInExplorer(path) {
    try {
        const data = await postJson("/api/open-path", { path: path });
        if (data.launched) {
            toast(data.message || "已请求资源管理器定位", "success");
        } else {
            toast(data.message || "无法调起资源管理器，路径已复制", "warn");
            copyPath(path); // 降级：至少把路径放进剪贴板
        }
    } catch (e) {
        toast(e.message, "error");
    }
}

function renderBrowseHistory() {
    const box = $("browse-history");
    if (!box || browseHistory.length < 2) { if (box) box.classList.add("hidden"); return; }
    box.innerHTML = '<span class="chips-label">浏览历史：</span>' + browseHistory.slice(-5).reverse().map((path) => '<button class="chip" data-history-path="' + esc(path) + '" title="返回 ' + esc(path) + '">' + esc(path) + '</button>').join("");
    box.classList.remove("hidden");
    box.querySelectorAll("[data-history-path]").forEach((el) => el.addEventListener("click", () => browsePath(el.dataset.historyPath)));
}
let browseParent = null;   // 当前目录的上级（null = 已在根）
let lastBrowse = { root: "D:\\", path: "D:\\" }; // 供「重试」按钮使用

function normalizeRoot(text) {
    return String(text || "").trim();
}

function renderBreadcrumb(path, parent) {
    browseParent = parent || null;
    const nav = $("breadcrumb");
    if (!nav) return;
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    if (!parts.length) {
        nav.innerHTML = '<span class="muted">当前路径：</span><span class="crumb-current">-</span>';
        return;
    }
    const isUnc = /^\\\\/.test(String(path)) || /^\/\//.test(String(path));
    let html = '<span class="muted">当前路径：</span>';
    let cum = "";
    parts.forEach((part, index) => {
        if (index === 0) {
            cum = isUnc ? "\\\\" + part + "\\" : part + "\\";
        } else {
            cum = cum.replace(/[\\/]+$/, "") + "\\" + part;
        }
        if (index < parts.length - 1) {
            html +=
                '<button class="crumb" data-path="' + esc(cum) + '" title="' + esc(cum) + '">' +
                esc(part) + "</button>" +
                '<span class="crumb-sep">\\</span>';
        } else {
            html += '<span class="crumb-current" title="' + esc(cum) + '">' + esc(part) + "</span>";
        }
    });
    nav.innerHTML = html;
    nav.querySelectorAll(".crumb").forEach((btn) => {
        btn.addEventListener("click", () => browsePath(btn.getAttribute("data-path")));
    });
    const backBtn = $("btn-back");
    if (backBtn) backBtn.disabled = !parent;
    renderStrip(); // U2.3：上级构成条带（父路径变化即刷新；无缓存/盘根自动隐藏）
}

function showBrowseError(message, err, onRetry) {
    const textEl = $("browse-error-text");
    if (!textEl) return; // U2.1：子页面时不渲染错误框
    // U2.3：下钻失败 → 取消 FLIP/收缩转场，恢复旧层终帧（不残留下钻预览态）
    const v = getTreemapView();
    if (v) v.cancelTransition();
    setStatus("browse-status", "err", message);
    const box = $("browse-error");
    if (err && err.code !== undefined && err.code !== null) {
        // P12·W1.3 新形态错误：统一渲染器（文案+码+detail+重试/帮助）
        renderApiError(textEl, err, onRetry);
    } else {
        textEl.textContent = message;
    }
    if (box) box.classList.remove("hidden");
}

function hideBrowseError() {
    const box = $("browse-error");
    if (box) box.classList.add("hidden");
}

function setBrowseLoading(loading, text) {
    const box = $("browse-loading");
    if (!box) return;
    box.classList.toggle("hidden", !loading);
    const label = $("browse-loading-text");
    if (label) label.textContent = text || "正在扫描目录，请稍候…";
    const btn = $("btn-browse");
    if (btn) btn.disabled = loading;
}

let browseView = "ranking";
let compactDensity = false;
let treemapView = null; // U2.2：treemap 渲染器实例（宿主随路由重建；失连自动重建）
let scanRunning = false; // U2.3：扫描进行中（pds:scan 事件记账；驱动 L3-2 实时生长/L3-3 扫掠）
let liveTimer = 0;       // L3-2 实时刷新定时器（500ms 主页矩形图 / 2s 子页面低频）
let liveSeq = 0;         // 实时刷新竞态令牌（用户导航后放弃迟到数据）
let fullscreenVeil = null; // L3-8 背景压暗层
let scanListenerBound = false; // window 级监听只绑一次（路由重挂不重复注册）

/* ================= U2.2/U2.3：treemap 数据接入与交互 ================= */

/* browse 响应 → tiles（children 无总量字段，占比按本次条目之和归一；
   mergeTop（state.view.mergeTop，默认 24）之外的项并入「其他」固定色块）。 */
function buildTiles(data) {
    const raw = (data.directories || []).concat(data.files || []);
    const mergeTop = Math.max(1, Number(APP_STATE.view.mergeTop) || 24);
    const sorted = raw.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    const total = sorted.reduce((s, e) => s + (Number(e.size) || 0), 0);
    const tiles = sorted.slice(0, mergeTop).map((e) => {
        const size = Number(e.size) || 0;
        return {
            key: e.path, path: e.path, name: e.name,
            size: size, pct: total ? size / total : 0,
            isDir: !!e.is_dir, isOther: false,
            color: colorFor(e.name), sizeHuman: e.size_human || humanBytes(size),
        };
    });
    const rest = sorted.slice(mergeTop);
    if (rest.length) {
        const size = rest.reduce((s, e) => s + (Number(e.size) || 0), 0);
        tiles.push({
            key: "…其他…", path: null, name: "其他",
            size: size, pct: total ? size / total : 0,
            isDir: false, isOther: true,
            color: OTHER_COLOR, sizeHuman: humanBytes(size),
        });
    }
    return tiles;
}

/* ---- L3-7 迷你条带数据源：上级 browse 响应缓存（path → tiles，LRU 16） ---- */
const BROWSES_CACHE_MAX = 16;
const browsesCache = new Map();
function cacheTiles(path, tiles) {
    if (!path || !tiles) return;
    if (browsesCache.has(path)) browsesCache.delete(path);
    browsesCache.set(path, tiles);
    while (browsesCache.size > BROWSES_CACHE_MAX) {
        browsesCache.delete(browsesCache.keys().next().value);
    }
}

function ensureTreemap() {
    if (treemapView && treemapView.host.isConnected) return treemapView;
    if (treemapView) {
        // 宿主已随路由卸载：销毁旧实例（解除 RO/主题观察器/窗口监听，防跨路由泄漏）
        try { treemapView.destroy(); } catch (e) { /* 销毁失败不阻断重建 */ }
        treemapView = null;
    }
    const host = $("treemap-wrap");
    if (!host) return null;
    treemapView = createTreemap(host, {
        // U2.3：单击下钻（300ms 双击窗口确认后）→ FLIP 预览 + browse；文件/合并块不钻
        onClick: (tile) => {
            if (tile && tile.isDir && !tile.isOther) {
                const view = getTreemapView();
                if (view && view.isTransitioning() === false) view.flipDrill(tile); // L3-1 FLIP 放大铺满
                browsePath(tile.path);
            }
        },
        // 双击=回本级根（300ms 窗口内二次点击，与单击互斥防误触）
        onDblClick: () => {
            if (currentPath !== currentRoot) browsePath(currentRoot);
        },
        // L2-5 双向联动（方向①：tile hover → 列表行高亮 + scrollIntoView；事件委托，行数受控 ≤200）
        onHover: (tile) => {
            APP_STATE.treemap.hoverKey = tile ? tile.key : null;
            const linked = tile ? tile.path : null;
            document.querySelectorAll("#dir-body .ranking-row").forEach((row) => {
                const on = linked && row.dataset.path === linked;
                if (row.classList.contains("row-linked") !== on) row.classList.toggle("row-linked", on);
                if (on) row.scrollIntoView({ block: "nearest" });
            });
        },
    });
    return treemapView;
}

function renderTreemap(data, mode) {
    const tiles = buildTiles(data);
    APP_STATE.treemap.tiles = tiles;
    cacheTiles(String(data.root || ""), tiles); // 条带/反向转场缓存
    const view = ensureTreemap();
    if (view) view.setTiles(tiles, { mode: mode || "entry" });
    setStatus(
        "browse-status",
        "ok",
        "矩形图视图 · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件"
    );
    renderStrip();
}

/* ---- L3-7 迷你条带（48px；仅矩形图视图 + 有上级 + 上级缓存命中；静态不动画） ---- */
function renderStrip() {
    const slot = $("strip-slot");
    if (!slot) return;
    if (browseView !== "treemap" || !browseParent) {
        slot.setAttribute("hidden", "");
        slot.innerHTML = "";
        return;
    }
    const parentTiles = browsesCache.get(String(browseParent));
    if (!parentTiles || !parentTiles.length) {
        slot.setAttribute("hidden", "");
        slot.innerHTML = "";
        return;
    }
    slot.removeAttribute("hidden");
    slot.innerHTML =
        '<div class="strip-bar" role="group" aria-label="上一级目录构成">' +
        parentTiles.map((t) => {
            const clickable = t.isDir && !t.isOther;
            const title = esc(t.name + " · " + humanBytes(t.size) + " · " + (t.pct * 100).toFixed(1) + "%");
            return (
                '<div class="strip-block' + (clickable ? "" : " strip-block-static") + '"' +
                ' data-strip-path="' + esc(t.path || "") + '" title="' + title + '"' +
                ' style="width:' + Math.max(1, (t.pct * 100).toFixed(2)) + '%;background:' + t.color + '">' +
                '<span class="strip-label">' + esc(t.name) + "</span></div>"
            );
        }).join("") +
        "</div>";
    slot.querySelectorAll(".strip-block[data-strip-path]:not(.strip-block-static)").forEach((b) => {
        b.addEventListener("click", () => {
            const p = b.getAttribute("data-strip-path");
            if (p) browsePath(p);
        });
    });
}

/* ---- 视图切换（排行/表格/矩形图三态；矩形图激活时表格隐藏、treemap 容器显示；
   L1-1 入场由 setTiles 播；从 treemap 切走时暂停 rAF 省电；合并阈值组仅矩形图显示） ---- */
function setBrowseView(mode) {
    browseView = mode;
    $("btn-view-treemap").classList.toggle("btn-primary", mode === "treemap");
    $("btn-view-ranking").classList.toggle("btn-primary", mode === "ranking");
    $("btn-view-table").classList.toggle("btn-primary", mode === "table");
    const wrap = $("treemap-wrap");
    if (wrap) {
        if (mode === "treemap") {
            wrap.removeAttribute("hidden");
            if (APP_STATE.lastBrowseData) renderTreemap(APP_STATE.lastBrowseData);
        } else {
            wrap.setAttribute("hidden", "");
            const v = getTreemapView();
            if (v) v.pause();
        }
    }
    const tableWrap = $("table-wrap");
    if (tableWrap) tableWrap.classList.toggle("hidden", mode === "treemap");
    const mergeGroup = $("merge-group");
    if (mergeGroup) mergeGroup.toggleAttribute("hidden", mode !== "treemap"); // 仅矩形图显示（template 属性与 class 双控以 [hidden] 为准）
    syncSweep(); // 扫掠仅矩形图+扫描中
    if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData);
    renderStrip();
}

/* ---- L3-8 全屏（view-area fixed 铺满 + 背景压暗 veil + FLIP 300ms；Esc/按钮退出） ---- */
function isFullscreen() {
    const area = $("view-area");
    return !!(area && area.classList.contains("view-fullscreen"));
}
function enterFullscreen() {
    const area = $("view-area");
    if (!area) return;
    const from = area.getBoundingClientRect();
    area.classList.add("view-fullscreen");
    document.body.classList.add("view-fs"); // 工具行钉顶（控制条形态）
    fullscreenVeil = document.createElement("div");
    fullscreenVeil.className = "fullscreen-veil";
    document.body.appendChild(fullscreenVeil);
    motionFlip(from, area, { dur: motionDur("--dur-fullscreen") || 0 }); // FLIP 300ms（token；缺失/0=直切）
    $("btn-view-fullscreen").setAttribute("aria-pressed", "true");
    $("btn-view-fullscreen").textContent = "退出全屏";
}
function exitFullscreen() {
    const area = $("view-area");
    if (!area) return;
    area.classList.remove("view-fullscreen");
    document.body.classList.remove("view-fs");
    if (fullscreenVeil) { fullscreenVeil.remove(); fullscreenVeil = null; }
    $("btn-view-fullscreen").setAttribute("aria-pressed", "false");
    $("btn-view-fullscreen").textContent = "全屏";
}
function toggleFullscreen() {
    if (isFullscreen()) exitFullscreen(); else enterFullscreen();
}

/* ---- 返回上级（treemap 视图：反向播放 zoomOut + browse；手动/Backspace/返回按钮共用） ---- */
function goUp() {
    if (!browseParent) return;
    if (browseView === "treemap") {
        const view = getTreemapView();
        if (view && !view.isTransitioning()) {
            const parentTiles = browsesCache.get(String(browseParent));
            const childRect = parentTiles && parentTiles.length
                ? view.computeLayout(parentTiles).find((r) => r.key === getCurrentPath())
                : null;
            if (childRect) view.zoomOutTo(childRect); // 反向播放（L3-1）；无缓存则入场直切（偏差①②）
        }
    }
    browsePath(browseParent);
}

/* ---- L3-2 扫描实时生长（pds:scan 事件驱动；500ms 主页矩形图 / 2s 子页面低频） ---- */
function liveDelay() {
    return APP_STATE.route === "/" && browseView === "treemap" ? 500 : 2000;
}
function kickLive() {
    if (!scanRunning) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
        liveTimer = 0;
        if (!scanRunning) return;
        await doLiveRefresh();
        if (scanRunning) kickLive();
    }, liveDelay());
}
async function doLiveRefresh() {
    const seq = ++liveSeq;
    try {
        const data = await postJson("/api/browse", { root: currentRoot, path: currentPath });
        if (seq !== liveSeq || !scanRunning) return;
        if (String(data.root || "") !== String(currentPath)) return; // 用户已导航：放弃
        if (data.scanning) {
            // 当前目录在扫描中无索引：保留现图，仅提示（不覆盖 tiles）
            if (browseView === "treemap" && $("treemap-wrap")) {
                setStatus("browse-status", "warn", data.message || "该盘正在扫描中，完成后即可即时浏览");
            }
            return;
        }
        APP_STATE.lastBrowseData = data;
        const tiles = buildTiles(data);
        cacheTiles(String(data.root || currentPath), tiles);
        APP_STATE.treemap.tiles = tiles;
        if (browseView === "treemap" && $("treemap-wrap") && !$("treemap-wrap").hasAttribute("hidden")) {
            ensureTreemap().setTiles(tiles, { mode: "reflow" }); // L3-2：lerp 300ms + 新块光晕
            setStatus("browse-status", "ok", "矩形图实时生长 · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件");
        }
    } catch (e) { /* 扫描期实时刷新失败静默（下次轮询再试） */ }
}
function syncSweep() {
    const view = getTreemapView();
    const active = scanRunning && browseView === "treemap" && APP_STATE.route === "/" &&
        !!$("treemap-wrap") && !$("treemap-wrap").hasAttribute("hidden");
    if (view) view.setSweep(active);
}

export function getTreemapView() { return treemapView; }
export function getTreemapTiles() { return APP_STATE.treemap.tiles; }

/* L3-9 合并阈值：步长 10（min 1 / max 200），reflow lerp 300ms 重排。 */
export function setMergeTop(n) {
    const v = Math.max(1, Math.min(200, Math.floor(Number(n) || 1)));
    APP_STATE.view.mergeTop = v;
    const label = $("merge-top-label");
    if (label) label.textContent = String(v);
    if (APP_STATE.lastBrowseData && browseView === "treemap") renderTreemap(APP_STATE.lastBrowseData, "reflow");
}

/* 附录B 基准桥：注入 state.treemap.tiles（1000 块 mock）后调本函数触发重绘。 */
export function renderTreemapFromState() {
    const view = ensureTreemap();
    if (view) view.setTiles(APP_STATE.treemap.tiles || [], { mode: "entry" });
}

function filteredEntries(data) {
    const query = ($("browse-filter") && $("browse-filter").value || "").trim().toLowerCase();
    const kind = ($("browse-kind") && $("browse-kind").value) || "all";
    const sort = ($("browse-sort") && $("browse-sort").value) || "size-desc";
    let entries = (data.directories || []).concat(data.files || []).filter((entry) => {
        return (kind === "all" || (kind === "dir" ? entry.is_dir : !entry.is_dir)) && (!query || String(entry.name).toLowerCase().includes(query));
    });
    entries.sort((a, b) => sort === "name-asc" ? String(a.name).localeCompare(String(b.name), "zh-CN") : sort === "size-asc" ? Number(a.size) - Number(b.size) : Number(b.size) - Number(a.size));
    return entries;
}

export function renderEntries(data) {
    const body = $("dir-body");
    if (!body) return; // U2.1：子页面时列表不在 DOM（防迟到响应/重置路径）
    APP_STATE.lastBrowseData = data; // 先记账（treemap 视图下钻时同样生效——切页不丢/视图回灌依赖）
    if (browseView === "treemap") {
        // U2.2：矩形图视图——数据 → tiles（mergeTop 合并）→ L1-1 入场；
        // 筛选/排序行属排行/表格视图（定稿 F10），矩形图按组成渲染全部子项。
        renderTreemap(data);
        return;
    }
    body.classList.toggle("compact-list", compactDensity);
    const entries = filteredEntries(data);
    // P12·W2.5-H：筛选空态——原始条目非空但被筛选清空时给出统一空态＋一键清除
    const rawCount = (data.directories || []).length + (data.files || []).length;
    const activeQuery = ($("browse-filter") && $("browse-filter").value || "").trim();
    const activeKind = ($("browse-kind") && $("browse-kind").value) || "all";
    if (!entries.length && rawCount > 0 && (activeQuery || activeKind !== "all")) {
        body.innerHTML =
            '<tr><td colspan="4"><div class="empty-state">' +
            "<b>无匹配”" + esc(activeQuery || "(类型筛选)") + "“的结果</b>" +
            '<p>试试更换关键词，或<button class="btn btn-sm" id="btn-clear-filter">清除筛选</button>后查看全部。</p>' +
            "</div></td></tr>";
        setStatus("browse-status", "warn", "没有匹配当前筛选的条目");
        const clearBtn = document.getElementById("btn-clear-filter");
        if (clearBtn) clearBtn.addEventListener("click", () => {
            if ($("browse-filter")) $("browse-filter").value = "";
            if ($("browse-kind")) $("browse-kind").value = "all";
            if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData);
        });
        return;
    }
    if (browseView === "ranking") {
        const max = Math.max(1, ...entries.map((entry) => Number(entry.size) || 0));
        // P12·W1.4 渲染层区分（FE 方案 B）：目录行保留 role/tabindex/data-path，
        // 文件行改用 .ranking-row-static（无 role/tabindex/data-path）——
        // 点击与键盘 Enter/Space 天然只作用于目录行，文件行 0 个额外请求。
        body.innerHTML = entries.map((entry) => {
            const label = 'aria-label="' + esc(entry.name) + "，" + esc(entry.size_human) + '"';
            const inner =
                '<span class="ranking-name">' + (entry.is_dir ? ICONS.folder : ICONS.file) + esc(entry.name) + '</span>' +
                '<span class="size-track"><span class="size-bar" style="width:' + Math.max(2, Number(entry.size) / max * 100) + '%"></span></span>' +
                "<strong>" + esc(entry.size_human) + "</strong>";
            if (entry.is_dir) {
                return '<tr><td colspan="4"><div tabindex="0" role="button" class="ranking-row" data-path="' + esc(entry.path) + '" ' + label + ">" + inner + rowActions(entry.path) + "</div></td></tr>";
            }
            return '<tr><td colspan="4"><div class="ranking-row-static" ' + label + ">" + inner + rowActions(entry.path) + "</div></td></tr>";
        }).join("") || '<tr><td colspan="4"><div class="empty-state"><b>暂无数据</b><p>扫描后显示目录排行。</p></div></td></tr>';
        body.querySelectorAll(".ranking-row[data-path]").forEach((row) => {
            row.addEventListener("click", () => browsePath(row.dataset.path));
            row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); browsePath(row.dataset.path); } });
        });
        setStatus("browse-status", "ok", "排行视图 · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件");
        return;
    }
    if (!entries.length) {
        body.innerHTML =
            '<tr><td colspan="4"><div class="empty-state">' +
            ICONS.empty +
            "<b>（空目录）</b>" +
            "<p>这里没有找到子目录或文件。可以「返回上级」，或换一个盘符 / 目录再浏览。</p>" +
            "</div></td></tr>";
        return;
    }
    let maxSize = 1;
    entries.forEach((e) => {
        if (Number(e.size) > maxSize) maxSize = Number(e.size);
    });
    const rows = entries.map((entry) => {
        const isDir = !!entry.is_dir;
        const nameCell = isDir
            ? '<a href="#" class="dir-link" data-path="' + esc(entry.path) + '" title="进入 ' + esc(entry.path) + '">' +
              ICONS.folder + '<span class="name">' + esc(entry.name) + "\\</span></a>"
            : '<span class="cell-name">' + ICONS.file + '<span class="name">' + esc(entry.name) + "</span></span>";
        const pct = Math.max(2, (Number(entry.size) / maxSize) * 100).toFixed(1);
        return (
            "<tr>" +
            '<td class="cell-name">' + nameCell + "</td>" +
            '<td class="col-size">' + esc(entry.size_human) + "</td>" +
            '<td class="col-share"><span class="size-track"><span class="size-bar" style="width:' + pct + '%"></span></span></td>' +
            '<td class="col-type"><span>' + (isDir ? "目录" : "文件") + "</span>" + rowActions(entry.path) + "</td>" +
            "</tr>"
        );
    });
    body.innerHTML = rows.join("");
    body.querySelectorAll(".dir-link").forEach((link) => {
        link.addEventListener("click", (ev) => {
            ev.preventDefault();
            browsePath(link.getAttribute("data-path"));
        });
    });
    body.querySelectorAll("tr").forEach((row) => {
        row.addEventListener("mouseenter", () => row.classList.add("row-highlight"));
        row.addEventListener("mouseleave", () => row.classList.remove("row-highlight"));
        row.setAttribute("tabindex", "0");
        row.setAttribute("role", "row");
        row.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            const link = row.querySelector(".dir-link");
            if (link) { ev.preventDefault(); link.click(); }
        });
    });

    const extra = [];
    if (Number(data.total_dirs) > 200) extra.push("目录仅显示最大的 200 个");
    if (Number(data.total_files) > 200) extra.push("文件仅显示最大的 200 个");
    const note = extra.length ? "（" + extra.join("；") + "）" : "";
    setStatus(
        "browse-status",
        "ok",
        "共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件" + note
    );
}

/* P12·W2.8（N-1）：浏览竞态防护——每次 browsePath 取自增令牌，迟到响应丢弃 */
let browseSeq = 0;

export async function browsePath(path, quiet) {
    const seq = ++browseSeq;
    const target = normalizeRoot(path) || currentRoot;
    if (!target) {
        setStatus("browse-status", "warn", "请输入盘符或目录路径（例如 D:\\）");
        return;
    }
    hideBrowseError();
    setBrowseLoading(true);
    setStatus("browse-status", "busy", "正在扫描目录，请稍候…");
    $("dir-body").innerHTML = "";
    try {
        const data = await postJson("/api/browse", { root: currentRoot, path: target });
        if (seq !== browseSeq) return; // 迟到的旧响应：不渲染、不改 currentPath/history
        document.title = (data.root || target) + " · Python 磁盘扫描";
        // API root 是当前目录；浏览会话根保持不变，避免进入子目录后越界。
        currentPath = data.root || target;
        if (!quiet && (!browseHistory.length || browseHistory[browseHistory.length - 1] !== currentPath)) {
            browseHistory.push(currentPath);
            if (browseHistory.length > 30) browseHistory.shift();
            renderBrowseHistory();
        }
        lastBrowse = { root: currentRoot, path: currentPath };
        $("browse-root").value = currentRoot;
        $("browse-cache-badge").classList.toggle("hidden", !!data.scanning);
        if (data.scanning) {
            setStatus("browse-status", "warn", data.message || "该盘正在扫描中，完成后即可即时浏览");
        }
        renderBreadcrumb(data.root, data.parent);
        renderEntries(data);
        // 只在会话根层级记录「最近浏览」（进入子目录不算新根）
        if (data.root && !data.parent) updateRecentRoots(data.root, quiet);
    } catch (e) {
        if (seq !== browseSeq) return; // 旧失败不打断新结果
        lastBrowse = { root: currentRoot, path: target };
        // P12·W2.5（E）：失败回写输入框并聚焦全选，便于直接修正路径
        $("browse-root").value = target;
        $("browse-root").focus();
        try { $("browse-root").select(); } catch (err) { /* 非文本态忽略 */ }
        showBrowseError(e.message, e, () => browsePath($("browse-root").value.trim() || target));
    } finally {
        if (seq === browseSeq) setBrowseLoading(false); // 仅最新请求有权解除 loading
    }
}

/* ---- 最近浏览（写入 config.json 的 last_roots） ---- */

let lastRoots = [];

export function getLastRoots() { return lastRoots; }

/* 模块化拆分导出的赋值器：lastRoots 更新 + 重渲染（原 openSettings/init/wipeData 三处的
   lastRoots = …; renderRecentChips(); 的行为等价合并）。 */
export function applyLastRoots(roots) {
    lastRoots = roots;
    renderRecentChips();
}

function renderRecentChips() {
    const box = $("recent-roots");
    if (!box) return; // U2.1：子页面时不在 DOM
    if (!lastRoots.length) {
        box.classList.add("hidden");
        return;
    }
    box.innerHTML =
        '<span class="chips-label">最近浏览：</span>' +
        lastRoots
            .map(
                (r) =>
                    '<button class="chip" data-root="' + esc(r) + '" title="浏览 ' + esc(r) + '">' +
                    ICONS.drive + esc(r) + "</button>"
            )
            .join("");
    box.classList.remove("hidden");
    box.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            currentRoot = chip.getAttribute("data-root");
            $("browse-root").value = currentRoot;
            browsePath(currentRoot);
        });
    });
    // 同步 datalist 建议
    const list = $("roots-suggest");
    list.querySelectorAll('option[data-recent="1"]').forEach((o) => o.remove());
    lastRoots.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r;
        opt.dataset.recent = "1";
        list.appendChild(opt);
    });
}

/* P12·W2.6（K5）：最近浏览 POST 防抖 300ms（trailing），连跳目录只落一次盘 */
let _recentRootsTimer = null;
let _recentRootsPending = null;

async function updateRecentRoots(root, quiet) {
    const value = normalizeRoot(root);
    if (!value) return;
    const upper = value.toUpperCase();
    lastRoots = [value].concat(lastRoots.filter((r) => String(r).toUpperCase() !== upper)).slice(0, 5);
    renderRecentChips();
    if (!quiet) {
        _recentRootsPending = lastRoots;
        clearTimeout(_recentRootsTimer);
        _recentRootsTimer = setTimeout(() => {
            postJson("/api/settings", { last_roots: _recentRootsPending }).catch(() => { /* 记录失败不影响浏览 */ });
        }, 300);
    }
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的视图工具栏/浏览/行内委托段） */
export function bindWorkspace() {
    // 视图切换与密度（N10 工具栏位；U2.2 接入矩形图三态；U2.3 合并阈值/全屏；U2.5 扩展多选等）。
    // 应用**当前**视图状态：首挂 = ranking；路由返回时保持用户选择（切页不丢）。
    setBrowseView(browseView);
    $("btn-view-treemap").addEventListener("click", () => setBrowseView("treemap"));
    $("btn-view-ranking").addEventListener("click", () => setBrowseView("ranking"));
    $("btn-view-table").addEventListener("click", () => setBrowseView("table"));
    $("btn-density").addEventListener("click", () => { compactDensity = !compactDensity; $("btn-density").setAttribute("aria-pressed", String(compactDensity)); $("btn-density").textContent = compactDensity ? "舒适列表" : "紧凑列表"; if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData); });
    // U2.3：合并阈值 −/+（L3-9，步长 10）与全屏（L3-8）
    $("btn-merge-minus").addEventListener("click", () => setMergeTop(APP_STATE.view.mergeTop - 10));
    $("btn-merge-plus").addEventListener("click", () => setMergeTop(APP_STATE.view.mergeTop + 10));
    $("btn-view-fullscreen").addEventListener("click", toggleFullscreen);
    // U2.3：Backspace 上级 / Esc 退全屏（键盘矩阵 §7.4 的 Backspace 部分；U4.1 收口其余；
    // 仅 window 级一次绑定——避免路由重挂重复注册）
    if (!scanListenerBound) {
        scanListenerBound = true;
        document.addEventListener("keydown", (ev) => {
            if (ev.key === "Backspace") {
                const t = ev.target;
                if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
                if (ev.isComposing) return; // 中文输入法组词中
                if (document.querySelector(".modal:not(.hidden)")) return;
                if (browseView === "treemap" && browseParent) { ev.preventDefault(); goUp(); }
            } else if (ev.key === "Escape") {
                if (document.querySelector(".modal:not(.hidden)")) return; // 弹窗栈优先（红线#9）
                if (isFullscreen()) exitFullscreen();
            }
        });
        // L3-2/L3-3 扫描事件（scan.js 派发，additive）与路由变化
        window.addEventListener("pds:scan", (ev) => {
            scanRunning = !!(ev.detail && ev.detail.running);
            if (scanRunning) kickLive();
            syncSweep();
        });
        window.addEventListener("pds:navigate", () => {
            if (scanRunning) kickLive(); // 子页面降 2s / 回主页恢复 500ms
            syncSweep();
        });
    }
    // L2-5 联动方向②（行 hover → tile 高亮；事件委托，避免千级行监听器）
    $("dir-body").addEventListener("mouseover", (ev) => {
        const row = ev.target.closest(".ranking-row[data-path]");
        if (!row) return;
        APP_STATE.treemap.hoverKey = row.dataset.path;
        const v = getTreemapView();
        if (v && !v.isAnimating()) v.highlightKey(row.dataset.path);
    });
    ["browse-filter", "browse-kind", "browse-sort"].forEach((id) => $(id).addEventListener("input", () => { if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData); }));

    // 目录浏览
    $("btn-browse").addEventListener("click", () => {
        currentRoot = normalizeRoot($("browse-root").value);
        if (!currentRoot) {
            setStatus("browse-status", "warn", "请输入盘符或目录路径（例如 D:\\）");
            return;
        }
        browsePath(currentRoot);
    });
    $("browse-root").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") $("btn-browse").click();
    });
    $("btn-back").addEventListener("click", goUp); // U2.3：treemap 视图反向播放 + browse
    $("btn-browse-retry").addEventListener("click", () => {
        // 重试以输入框当前内容为准（用户可能已修正路径）
        currentRoot = normalizeRoot($("browse-root").value) || lastBrowse.root;
        browsePath(currentRoot);
    });

    // P12·W1.4 行动闭环：行内操作按钮事件委托（绑定一次，随渲染内容更新生效）
    $("dir-body").addEventListener("click", (ev) => {
        const openBtn = ev.target.closest(".act-open");
        if (openBtn) { openInExplorer(openBtn.getAttribute("data-act-path")); return; }
        const copyBtn = ev.target.closest(".act-copy");
        if (copyBtn) { copyPath(copyBtn.getAttribute("data-act-path")); return; }
    });
}

/* ============================================================
   U2.1：工作台页面（路由契约 render/mount/unmount）
   - 模板 = U1.3 index.html 工作台区域（左列 + 右栏三卡 + 对比卡）机械搬移，
     结构/类/ID 逐字一致（视觉逐字节不变；browse-chart 已随 U2.0 删除）；
   - 绑定集合由 main.js 装配（bindOnboarding/bindOverview/bindWorkspace/
     bindScan/bindCompare/bindWorkspaceGuide），避免 workspace↔scan 互引成环；
   - unmount：本阶段无 rAF/轮询归本页（扫描轮询属全局 scan 模块，
     切页期间经空守卫维持轮询，U3.2 顶栏微型环接管展示）。
   ============================================================ */

const WORKSPACE_HTML =
    '<h1 class="sr-only" data-page-title>工作台</h1>' +
    '<main class="main-col">' +

    '<!-- 首启引导：原「卡片折叠条」原样保留（U3.1 升级为弹层） -->' +
    '<section id="onboarding" class="card hero hidden" aria-label="使用指引">' +
    '<div class="hero-head"><h2>👋 欢迎使用 Python 磁盘扫描</h2>' +
    '<button id="btn-onboarding-close" class="icon-btn" title="关闭引导">' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
    '</button></div>' +
    '<p class="hero-sub">先扫描一次，建立空间索引。</p>' +
    '<ol class="steps hidden">' +
    '<li class="step"><span class="step-num">1</span><div><b>检查环境</b><p>确认右上角状态为「Everything 已就绪」。若未就绪，请先打开 Everything 并等待索引加载完成。</p></div></li>' +
    '<li class="step"><span class="step-num">2</span><div><b>全量扫描</b><p>点击「开始全量扫描」，程序在后台依次扫描 C、D 等所有本地盘，进度条实时显示。</p></div></li>' +
    '<li class="step"><span class="step-num">3</span><div><b>保存快照</b><p>扫描完成会提示「是否保存本次快照」，保存后生成 C、D 各一份快照与清单；也可在设置中开启自动保存。</p></div></li>' +
    '<li class="step"><span class="step-num">4</span><div><b>对比与清空</b><p>保存快照后，历史列表中每个盘符旁可「一键对比」；跨盘快照会先切换盘符再自动发起对比（次日即可回看变化）。设置里可一键清空数据目录（需输入确认文字）。</p></div></li>' +
    '</ol></section>' +

    '<!-- ===== 面包屑 / 工具栏行（48px 预算：F06 路径行 + N10 视图工具栏位） ===== -->' +
    '<div class="tool-row">' +
    '<div class="path-row">' +
    '<input id="browse-root" list="roots-suggest" type="text" placeholder="输入盘符或路径，例如 D:\\" value="D:\\" aria-label="浏览根目录">' +
    '<datalist id="roots-suggest"><option value="C:\\"></option><option value="D:\\"></option><option value="E:\\"></option><option value="F:\\"></option></datalist>' +
    '<button id="btn-browse" class="btn btn-primary">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.4-4.4"/></svg>' +
    '浏览</button>' +
    '<button id="btn-back" class="btn" disabled>' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>' +
    '返回上级</button>' +
    '</div>' +
    '<!-- [N10] 视图工具栏位：三视图切换（U2.2 矩形图/排行/表格）+ 合并阈值 −/+（D11，仅矩形图）+ 全屏（L3-8） -->' +
    '<div class="view-toolbar" aria-label="视图切换与密度">' +
    '<button id="btn-view-treemap" class="btn btn-sm" title="矩形图视图（新）">矩形图</button>' +
    '<button id="btn-view-ranking" class="btn btn-sm btn-primary">排行</button>' +
    '<button id="btn-view-table" class="btn btn-sm">表格</button>' +
    '<span class="merge-group" id="merge-group" hidden title="合并阈值（矩形图视图）：小于阈值的条目并入「其他」">' +
    '<button id="btn-merge-minus" class="btn btn-sm" title="减少合并数量（更多独立块）">−</button>' +
    '<span id="merge-top-label" class="merge-label">24</span>' +
    '<button id="btn-merge-plus" class="btn btn-sm" title="增加合并数量（更少独立块）">+</button></span>' +
    '<button id="btn-density" class="btn btn-sm" aria-pressed="false">紧凑列表</button>' +
    '<button id="btn-view-fullscreen" class="btn btn-sm" aria-pressed="false" title="视图区全屏（Esc 退出）">全屏</button>' +
    '</div></div>' +

    '<!-- 最近访问 / 浏览历史 / 面包屑 / 状态（F07 历史收进下拉属 U2.x，此处保留原 chips 位） -->' +
    '<div id="recent-roots" class="chips-row hidden"></div>' +
    '<div id="browse-history" class="chips-row hidden" aria-label="浏览历史"></div>' +
    '<nav id="breadcrumb" class="breadcrumb" aria-label="路径导航"><span class="muted">当前路径：</span><span class="crumb-current">-</span></nav>' +
    '<div id="browse-status" class="status-line" role="status"><span class="dot"></span><span id="browse-status-text">输入路径后点击「浏览」开始</span></div>' +
    '<div id="browse-guide" class="notice notice-warn hidden" role="status">' +
    '<b id="guide-title">Everything 尚未就绪</b>' +
    '<p id="guide-msg">正在等待 Everything 就绪（最长约 20 秒），请勿重复点击。正在加载索引，最长约 20 秒。</p>' +
    '<div class="row"><button id="btn-guide-retry" class="btn btn-sm">重试环境检测</button>' +
    '<button id="btn-guide-help" class="btn btn-sm btn-ghost">查看指引</button></div></div>' +
    '<div id="browse-cache-badge" class="notice notice-info hidden" role="status" aria-live="polite">来自内存缓存（无需重新扫描）</div>' +
    '<div class="browse-filters" aria-label="目录筛选与排序">' +
    '<input id="browse-filter" type="search" placeholder="筛选名称" aria-label="筛选名称">' +
    '<select id="browse-kind" aria-label="内容类型"><option value="all">全部</option><option value="dir">仅目录</option><option value="file">仅文件</option></select>' +
    '<select id="browse-sort" aria-label="排序方式"><option value="size-desc">按大小</option><option value="name-asc">按名称</option><option value="size-asc">大小最小</option></select>' +
    '</div>' +
    '<div id="browse-error" class="notice notice-error hidden"><span id="browse-error-text"></span>' +
    '<span><button id="btn-browse-retry" class="btn btn-sm">重试</button></span></div>' +

    '<!-- 视图区（flex:1；面板内滚） -->' +
    '<div class="view-area" id="view-area">' +
    '<div class="table-wrap" id="table-wrap">' +
    '<div id="browse-loading" class="loading-overlay hidden">' +
    '<svg class="spinner spinner-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>' +
    '<span id="browse-loading-text">正在扫描目录，请稍候…</span></div>' +
    '<table class="dir-table" aria-label="当前目录内容"><thead><tr><th>名称</th><th class="col-size">大小</th><th class="col-share">占比</th><th class="col-type">类型</th></tr></thead>' +
    '<tbody id="dir-body"></tbody></table>' +
    '</div>' +
    '<!-- [N01] 矩形图视图（U2.2：viz/treemap.js 双层 canvas 渲染器 + tooltip） -->' +
    '<div class="treemap-wrap" id="treemap-wrap" hidden aria-label="目录空间矩形图"></div>' +
    '</div>' +

    '<!-- [N09] 迷你条带位（视图区底部 48px；U2.3 装配 L3-7 上级构成，DOM 静态不动画） -->' +
    '<div class="strip-slot" id="strip-slot" data-slot="minimap" hidden></div>' +
    '</main>' +

    '<!-- 右栏 300px（§3.2；面板内滚允许） -->' +
    '<aside class="side-rail" id="side-rail">' +

    '<!-- 空间概览（U2.4 升级为环形图卡，此处保留数据单元骨架） -->' +
    '<section id="overview-panel" class="overview-panel" aria-label="空间概览" aria-live="polite" role="region">' +
    '<div class="overview-head"><div><h2>空间概览</h2><p id="overview-meta">完成全量扫描后显示索引空间分布</p></div>' +
    '<div class="overview-actions"><button id="btn-overview-refresh" class="btn btn-sm">刷新概览</button></div></div>' +
    '<div id="overview-roots" class="overview-roots"><div class="overview-empty">暂无概览数据</div></div>' +
    '</section>' +

    '<!-- 扫描控制卡（U3.2 状态机扩展，此处保留结构与全部行为） -->' +
    '<section class="card" aria-label="全量扫描">' +
    '<div class="card-head"><h2>' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12H2"/><path d="M5.5 5.5 2 12l3.5 6.5"/><path d="M18.5 5.5 22 12l-3.5 6.5"/><rect x="4" y="3" width="8" height="18" rx="2"/><rect x="12" y="3" width="8" height="18" rx="2"/></svg>' +
    '全量扫描</h2><p class="card-sub">建立最新空间索引</p></div>' +
    '<div class="row">' +
    '<button id="btn-fullscan" class="btn btn-primary">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
    '开始全量扫描</button>' +
    '<button id="btn-save" class="btn btn-success" disabled title="全量扫描完成后可保存">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>' +
    '保存快照</button></div>' +
    '<div class="row"><button id="btn-export-csv" class="btn btn-sm" title="把最近一次全量结果导出为 CSV">导出 CSV</button>' +
    '<button id="btn-export-json" class="btn btn-sm" title="把最近一次全量结果导出为 JSON">导出 JSON</button></div>' +
    '<div class="progress-wrap"><div id="progress" class="progress"><div id="progress-fill" class="progress-fill"></div></div>' +
    '<span id="progress-pct" class="progress-pct muted">0%</span></div>' +
    '<div id="fullscan-status" class="status-line" role="status"><span class="dot"></span><span id="fullscan-status-text">尚未开始全量扫描</span></div>' +
    '<div id="scan-roots" class="chips-row hidden"></div>' +
    '<div id="scan-progress-hint" class="notice notice-info hidden"></div>' +
    '<div id="save-prompt" class="notice notice-warn hidden"><div><b>全量扫描已完成。</b>是否保存本次快照？保存后可在「历史对比」中与基线对比。</div>' +
    '<div class="row"><button id="btn-save-now" class="btn btn-success btn-sm">立即保存</button>' +
    '<button id="btn-save-later" class="btn btn-sm">暂不保存</button></div></div>' +
    '</section>' +

    '<!-- 快照卡（U2.4 升级迷你卡，此处保留历史列表结构与行为） -->' +
    '<section class="card" aria-label="历史快照">' +
    '<div class="card-head"><h2>' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>' +
    '历史快照</h2><p class="card-sub">保存的扫描结果</p></div>' +
    '<div class="row">' +
    '<button id="btn-refresh-snapshots" class="btn">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
    '刷新历史</button>' +
    '<button id="btn-undo-save" class="btn" disabled title="删除最近一次保存的快照文件与清单（无快照时不可用）">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2-9.3L3 7"/></svg>' +
    '撤销最近保存</button></div>' +
    '<div id="snapshot-status" class="status-line"><span class="dot"></span><span id="snapshot-status-text">正在加载历史快照…</span></div>' +
    '<ul id="snapshot-list" class="snapshot-list"></ul>' +
    '</section>' +

    '<!-- 历史对比（U3.4 迁 #/compare 子页面，主页仅留「最近对比」迷你入口） -->' +
    '<section class="card" aria-label="历史对比">' +
    '<div class="card-head"><h2>' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l4-6 4 3 5-7"/></svg>' +
    '历史对比</h2><p class="card-sub">查看空间变化</p></div>' +
    '<div class="row">' +
    '<input id="compare-baseline" list="baseline-suggest" type="text" placeholder="基线快照路径（留空自动选最近一份）" aria-label="基线快照路径">' +
    '<datalist id="baseline-suggest"></datalist>' +
    '<button id="btn-compare" class="btn btn-primary">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v18"/><path d="M16 3v18"/><path d="M3 8h5"/><path d="M16 16h5"/></svg>' +
    '开始对比</button></div>' +
    '<div id="compare-status" class="status-line"><span class="dot"></span><span id="compare-status-text">先保存过快照或指定基线文件，再点击「开始对比」</span></div>' +
    '<div id="compare-result" class="hidden">' +
    '<div id="compare-summary" class="compare-summary"></div>' +
    '<div id="compare-chart" class="compare-chart" aria-label="变化排行榜"></div>' +
    '<div class="table-wrap"><table class="dir-table compare-table">' +
    '<thead><tr><th style="width:110px">变化</th><th style="width:90px">增速</th><th>路径</th><th style="width:60px">操作</th></tr></thead>' +
    '<tbody id="compare-body"></tbody></table></div></div>' +
    '</section>' +
    '</aside>';

/* 页面契约：render(state) → Node（DocumentFragment 亦可，主列+右栏双兄弟节点） */
export function renderWorkspace() {
    const frag = document.createDocumentFragment();
    const holder = document.createElement("div");
    holder.innerHTML = WORKSPACE_HTML;
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    return frag;
}

/* 页面契约：unmount()——U2.2 起停 treemap rAF（离场不空转；
   扫描轮询属全局模块，见文件头注记；宿主随路由卸载，返回时重建）。 */
export function unmountWorkspace() {
    const v = getTreemapView();
    if (v) v.pause();
}

/* U2.1：路由返回时的视图恢复——模块级状态回灌新 DOM（切页不丢的完整语义：
   状态与显示均保持；browse 数据用缓存 (lastBrowseData)，不重复发请求）。
   U2.2：treemap 视图回灌不经入场动画（数据未重新到达，直绘终帧）。 */
export function restoreWorkspaceView() {
    if (!APP_STATE.lastBrowseData) return;
    const rootInput = $("browse-root");
    if (rootInput) rootInput.value = getCurrentRoot();
    renderBreadcrumb(getCurrentPath(), browseParent);
    if (browseView === "treemap") renderTreemap(APP_STATE.lastBrowseData, "none");
    else renderEntries(APP_STATE.lastBrowseData);
    renderStrip();
}
