/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/workspace.js（U2.0 模块化迁入）
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
   - U2.4：右栏三处装配——存储概览卡改环形图卡（viz/donut.js + 盘符 chips D15 +
     图例 + 浏览此盘；渲染逻辑在 components/storage.js，本模板只留骨架）；
     历史快照卡升级 N06 迷你卡形态（最近一份 + 管理快照入口 + 空态 + 全部会话
     折叠区，渲染在 components/snapshot-mini.js，ids 全保留）；新增「最近对比」
     迷你卡（state.compare.lastSummary，compare.js 对比成功后写入）。
      U3.4：旧「历史对比」卡迁 #/compare 对比工作台整页（F18）并从本模板移除——
      主页仅留「最近对比」迷你卡（ids #compare-baseline/#btn-compare/#compare-result
      等随迁移入 pages/compare.js，工作台装配侧 bindCompare 一并摘除）。
   - U2.5：列表视图升级——排行/表格渲染迁 components/list.js（filteredEntries/
     renderList + N08 多选 + 虚拟滚动 + 页脚 + CSV 导出 + F19 行内操作三图标 +
     L1-2/L1-3），本文件保留接线（treemap 派发/视图切换交叉淡化/事件委托/浏览闭环）；
     · view 状态对齐 §3.2：browseView/compactDensity 模块状态迁入
       APP_STATE.view.{mode,density}（默认 treemap——定稿 N01 接管，
       旧「默认排行」裁决于本项核销）；
     · 三视图切换 120ms 交叉淡化（--dur-1；reduced 直切）；
     · 骨架屏 L1-5 替代 spinner（模板内 skel-*，shimmer 1.4s token）；
     · 缓存徽标 L2-9（translateX(-8px)+fade 200ms token --dur-2）；
     · F19 行内操作新增「下钻」图标（仅目录行；修复既有 act-open/act-copy
       点击连带触发下钻的隐患——行点击对 .row-actions 设守卫）。
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
import { flip as motionFlip, motionDur, motionEase, reducedMotion } from "../motion.js";
import { isTypingEvent } from "../keys.js"; // U4.1：单键守卫共享（Backspace 同口径）
import {
    renderList, bindList, clearSelection, setDrillHandler,
} from "../components/list.js";
/* 阶段C（C-7）：关系目录父子层级树（D3 裁定；懒展开单击复用 browse 加载；
   与 treemap/排行/表格互斥终态——防 2-2 残留重演） */
import {
    renderRelateTree, renderRelateEmpty, showRelate, hideRelate,
    pushPath, popPath, resetPathStack, getPathStack, handleRelateKey,
} from "../viz/relate.js";

/* ================= 目录浏览 ================= */

let currentRoot = "D:\\"; // 用户本次浏览会话的根（面包屑/返回不越过它）
let currentPath = "D:\\"; // 当前正在查看的目录
let browseHistory = [];

export function getCurrentRoot() { return currentRoot; }
export function setCurrentRoot(v) { currentRoot = v; }
export function getCurrentPath() { return currentPath; }
export function resetBrowseHistory() { browseHistory = []; }
/* U3.1：命令面板「浏览历史」数据源（跨模块可变状态经访问器；副本防外部篡改） */
export function getBrowseHistory() { return browseHistory.slice(); }

/* P12·W1.4 行动闭环：行内 hover 操作区（U2.5 起由 components/list.js 统一构建——
   F19 三图标 下钻/定位/复制路径；事件委托见 bindWorkspace 底部） */

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

/* U2.5：view 状态对齐 §3.2（browseView/compactDensity → APP_STATE.view.{mode,density}；
   默认 = treemap（state.js 预置），定稿 N01「默认矩形图」由本项接管） */
let treemapView = null; // U2.2：treemap 渲染器实例（宿主随路由重建；失连自动重建）
let scanRunning = false; // U2.3：扫描进行中（pds:scan 事件记账；驱动 L3-2 实时生长/L3-3 扫掠）
let liveTimer = 0;       // L3-2 实时刷新定时器（500ms 主页矩形图 / 2s 子页面低频）
let liveSeq = 0;         // 实时刷新竞态令牌（用户导航后放弃迟到数据）
let fullscreenVeil = null; // L3-8 背景压暗层
let scanListenerBound = false; // window 级监听只绑一次（路由重挂不重复注册）
let viewSeq = 0;         // 视图切换交叉淡化防抖令牌（快速连点取最新终态）

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

/* ---- L3-7 迷你条带数据源：上级 browse 响应缓存（path → {tiles, source, source_at}，LRU 16） ----
   阶段B（B-13/B-20）：缓存条目一并落地 source 与时间戳——任何浏览数据
   （含缓存命中回灌）都携带来源，禁止靠字段缺失猜测来源（修订清单 #4）。 */
const BROWSES_CACHE_MAX = 16;
const browsesCache = new Map();
function cacheTiles(path, tiles, meta) {
    if (!path || !tiles) return;
    const entry = { tiles: tiles };
    if (meta && meta.source) {
        entry.source = meta.source;
        entry.source_at = meta.source_at || "";
    }
    if (browsesCache.has(path)) browsesCache.delete(path);
    browsesCache.set(path, entry);
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
    cacheTiles(String(data.root || ""), tiles, { source: data.source, source_at: data.source_at }); // 条带/反向转场缓存（B-13：带 source 落地）
    const view = ensureTreemap();
    if (view) view.setTiles(tiles, { mode: mode || "entry" });
    updateTreemapA11y(data); // U4.1：aria-label 摘要（「当前目录 X，共 N 项，最大子项 …」）
    setStatus(
        "browse-status",
        "ok",
        "矩形图视图 · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件"
    );
    renderStrip();
}

/* U4.1：treemap 容器 aria-label 摘要（定稿第八节可访问性：treemap 容器有
   aria-label 摘要「当前目录 X，共 N 项，最大子项 …」——数据自本模块
   browse 载荷经 renderTreemap 就地传入（非跨模块直读）） */
function updateTreemapA11y(data) {
    const host = $("treemap-wrap");
    if (!host) return;
    const root = String(data.root || getCurrentPath() || "");
    const total = (Number(data.total_dirs) || 0) + (Number(data.total_files) || 0);
    let biggest = null;
    for (const it of (data.directories || []).concat(data.files || [])) {
        const sz = Number(it.size) || 0;
        if (!biggest || sz > (Number(biggest.size) || 0)) biggest = it;
    }
    let label = "当前目录 " + root + "，共 " + total + " 项";
    if (biggest) {
        label += "，最大子项 " + String(biggest.name || "") + "（" +
            (biggest.size_human || humanBytes(Number(biggest.size) || 0)) + "）";
    }
    host.setAttribute("aria-label", label);
}

/* ---- L3-7 迷你条带（48px；仅矩形图视图 + 有上级 + 上级缓存命中；静态不动画） ---- */
function renderStrip() {
    const slot = $("strip-slot");
    if (!slot) return;
    if (APP_STATE.view.mode !== "treemap" || !browseParent) {
        slot.setAttribute("hidden", "");
        slot.innerHTML = "";
        return;
    }
    const parentEntry = browsesCache.get(String(browseParent));
    const parentTiles = parentEntry ? parentEntry.tiles : null;
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
                (clickable ? ' tabindex="0" role="button" aria-label="跳回 ' + esc(t.path || t.name) + '"' : "") +
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
        // U4.1：条带块键盘可达（tabindex=0 + Enter/Space 同点击语义）
        b.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            ev.preventDefault();
            const p = b.getAttribute("data-strip-path");
            if (p) browsePath(p);
        });
    });
}

/* ---- U2.5 三视图切换（共用视口容器 + 120ms 交叉淡化；矩形图激活时表格隐藏、
   treemap 容器显示；L1-1 入场由 setTiles 播；从 treemap 切走时暂停 rAF 省电；
   合并阈值组仅矩形图显示；reduced 直切。两个容器为 view-area 的 absolute
   子元素——交叉淡化期间同时可见（叠加），结束后旧容器 display:none） ---- */
function setBrowseView(mode) {
    const prev = APP_STATE.view.mode;
    APP_STATE.view.mode = mode; // U2.5：§3.2 对齐（切页不丢；跨路由保持）
    const seq = ++viewSeq;
    $("btn-view-treemap").classList.toggle("btn-primary", mode === "treemap");
    $("btn-view-ranking").classList.toggle("btn-primary", mode === "ranking");
    $("btn-view-table").classList.toggle("btn-primary", mode === "table");
    /* 阶段C（C-7）：关系按钮高亮（与三视图同语义） */
    const relateBtn = $("btn-view-relate");
    if (relateBtn) relateBtn.classList.toggle("btn-primary", mode === "relate");
    const wrap = $("treemap-wrap");
    const tableWrap = $("table-wrap");
    const showTreemap = mode === "treemap";
    const showRelateMode = mode === "relate";
    if (wrap && tableWrap) {
        if (prev !== mode) {
            crossfadeView(seq, showTreemap);
        } else {
            // 幂等：直接定态（bindWorkspace 首挂/重复点击当前视图）
            finishViewSwap(tableWrap, wrap, showTreemap);
            if (prev === "treemap" && APP_STATE.lastBrowseData) renderTreemap(APP_STATE.lastBrowseData);
        }
    } else if (wrap && showTreemap && APP_STATE.lastBrowseData) {
        renderTreemap(APP_STATE.lastBrowseData);
    }
    if (wrap && showTreemap && prev !== mode) {
        if (APP_STATE.lastBrowseData) renderTreemap(APP_STATE.lastBrowseData);
    } else if (wrap && !showTreemap) {
        const v = getTreemapView();
        if (v) v.pause();
    }
    /* 阶段C（C-7）：relate 视图互斥收口——树显示则表格隐藏、反之亦然
       （防 2-2 残留：两容器终态互斥由 showRelate/hideRelate 内联保证） */
    if (showRelateMode) {
        showRelate();
    } else {
        hideRelate();
    }
    const mergeGroup = $("merge-group");
    if (mergeGroup) mergeGroup.toggleAttribute("hidden", !showTreemap); // 仅矩形图显示（template 属性与 class 双控以 [hidden] 为准）
    syncSweep(); // 扫掠仅矩形图+扫描中
    if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData, { animate: true }); // 视图切换播列表入场
    renderStrip();
}

/* 120ms 交叉淡化（--dur-1；仅 opacity，WAAPI；reduced/token 缺失 → 直切） */
function crossfadeView(seq, showTreemap) {
    const wrap = $("treemap-wrap");
    const tableWrap = $("table-wrap");
    if (!wrap || !tableWrap) return;
    const outEl = showTreemap ? tableWrap : wrap;
    const inEl = showTreemap ? wrap : tableWrap;
    // 双容器同时可见（绝对定位叠加）→ 交叉淡化
    tableWrap.classList.remove("hidden");
    wrap.removeAttribute("hidden");
    tableWrap.classList.add("v-crossfade");
    wrap.classList.add("v-crossfade");
    const dur = motionDur("--dur-1") || 0; // 120ms（--dur-1）；reduced 直切
    if (!dur || reducedMotion()) {
        finishViewSwap(tableWrap, wrap, showTreemap);
        return;
    }
    outEl.getAnimations().forEach((a) => a.cancel());
    inEl.getAnimations().forEach((a) => a.cancel());
    const ease = motionEase("--ease-out") || "linear";
    outEl.style.opacity = "1";
    inEl.style.opacity = "0";
    const oa = outEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: ease, fill: "forwards" });
    const ia = inEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing: ease, fill: "forwards" });
    Promise.all([oa.finished.catch(() => {}), ia.finished.catch(() => {})]).then(() => {
        if (seq !== viewSeq) return; // 已被更新的切换打断：终态由最新调用负责
        finishViewSwap(tableWrap, wrap, showTreemap);
    });
}

/* 交叉淡化终态：旧容器 display:none + 内联透明度清理 */
function finishViewSwap(tableWrap, wrap, showTreemap) {
    tableWrap.classList.toggle("hidden", showTreemap);
    wrap.toggleAttribute("hidden", !showTreemap);
    tableWrap.classList.remove("v-crossfade");
    wrap.classList.remove("v-crossfade");
    tableWrap.style.opacity = "";
    wrap.style.opacity = "";
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
    if (APP_STATE.view.mode === "treemap") {
        const view = getTreemapView();
        if (view && !view.isTransitioning()) {
            const parentEntry = browsesCache.get(String(browseParent));
            const parentTiles = parentEntry ? parentEntry.tiles : null;
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
    return APP_STATE.route === "/" && APP_STATE.view.mode === "treemap" ? 500 : 2000;
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
    /* 阶段D（D-1）冷启动竞态修复：自动扫描路径的启动浏览已延后（扫描完成后走索引）。
       此时 lastBrowseData 为空（无已渲染数据可生长）→ 跳过实时刷新——避免在扫描
       queued/首盘扫描期反复 POST /api/browse 撞后端 409（SDK 锁被 fullscan 持有）
       → 消除 409 控制台噪声（阶段D console 0 验收）；
       重新扫描（已有数据）路径不受影响：lastBrowseData 存在 → 继续 L3-2 实时生长。 */
    if (!APP_STATE.lastBrowseData) return;
    try {
        const data = await postJson("/api/browse", { root: currentRoot, path: currentPath });
        if (seq !== liveSeq || !scanRunning) return;
        if (String(data.root || "") !== String(currentPath)) return; // 用户已导航：放弃
        if (data.scanning) {
            // 当前目录在扫描中无索引：保留现图，仅提示（不覆盖 tiles）
            if (APP_STATE.view.mode === "treemap" && $("treemap-wrap")) {
                setStatus("browse-status", "warn", data.message || "该盘正在扫描中，完成后即可即时浏览");
            }
            return;
        }
        APP_STATE.lastBrowseData = data;
        const tiles = buildTiles(data);
        cacheTiles(String(data.root || currentPath), tiles, { source: data.source, source_at: data.source_at });
        APP_STATE.treemap.tiles = tiles;
        if (APP_STATE.view.mode === "treemap" && $("treemap-wrap") && !$("treemap-wrap").hasAttribute("hidden")) {
            ensureTreemap().setTiles(tiles, { mode: "reflow" }); // L3-2：lerp 300ms + 新块光晕
            updateTreemapA11y(data); // U4.1：实时生长同样保持 aria-label 摘要新鲜
            setStatus("browse-status", "ok", "矩形图实时生长 · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件");
        }
    } catch (e) { /* 扫描期实时刷新失败静默（下次轮询再试） */ }
}
function syncSweep() {
    const view = getTreemapView();
    const active = scanRunning && APP_STATE.view.mode === "treemap" && APP_STATE.route === "/" &&
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
    if (APP_STATE.lastBrowseData && APP_STATE.view.mode === "treemap") renderTreemap(APP_STATE.lastBrowseData, "reflow");
}

/* 附录B 基准桥：注入 state.treemap.tiles（1000 块 mock）后调本函数触发重绘。 */
export function renderTreemapFromState() {
    const view = ensureTreemap();
    if (view) view.setTiles(APP_STATE.treemap.tiles || [], { mode: "entry" });
}

/* U2.5：列表渲染已迁 components/list.js（renderList：排行/表格 + 多选 + 虚拟滚动 +
   页脚 + CSV 导出 + L1-2/L1-3）；本文件保留视图派发与浏览数据接线。
   opts.animate=true 时播 L1-2/L1-3（数据到达/视图切换/筛选重渲染）；
   回灌（restoreWorkspaceView）与虚拟窗口滚动重渲染不播（L1-2「虚拟滚动中不重放」）。 */
export function renderEntries(data, opts) {
    const body = $("dir-body");
    if (!body) return; // U2.1：子页面时列表不在 DOM（防迟到响应/重置路径）
    APP_STATE.lastBrowseData = data; // 先记账（treemap 视图下钻时同样生效——切页不丢/视图回灌依赖）
    if (APP_STATE.view.mode === "treemap") {
        // U2.2：矩形图视图——数据 → tiles（mergeTop 合并）→ L1-1 入场；
        // 筛选/排序行属排行/表格视图（定稿 F10），矩形图按组成渲染全部子项。
        renderTreemap(data);
        return;
    }
    /* 阶段C（C-7）：关系目录树（D3 父子层级树；懒展开单击复用 browse 加载；
       >200 子项虚拟化在 relate.js；与排行/表格互斥终态由 setBrowseView 收口） */
    if (APP_STATE.view.mode === "relate") {
        const entries = (data.directories || []).concat(data.files || []);
        if (!entries.length) {
            renderRelateEmpty(data);
        } else {
            renderRelateTree(data, { animate: !!opts && !!opts.animate, density: APP_STATE.view.density });
        }
        setStatus("browse-status", "ok", "关系目录 · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件");
        return;
    }
    renderList(data, opts);
}

/* P12·W2.8（N-1）：浏览竞态防护——每次 browsePath 取自增令牌，迟到响应丢弃 */
let browseSeq = 0;

/* 阶段B（B-13/B-14）：缓存徽章按后端明确 source 显示——禁止靠字段缺失猜测。
   - index   →「来自全量扫描索引（完成于 …）」
   - sdk     → 不显示缓存徽章（真实 SDK 直扫，无缓存语义；隐藏徽章）
   - scanning→「扫描中」
   - 旧响应无 source（后端旧版兼容）：回退既有 scanning 缺失逻辑（双向容忍） */
function renderCacheBadge(data) {
    const badge = $("browse-cache-badge");
    if (!badge) return;
    const src = data && data.source ? String(data.source) : "";
    if (src === "sdk") {
        badge.classList.add("hidden");
        return;
    }
    let text = "";
    if (src === "index") {
        const at = data.source_at
            ? "（完成于 " + String(data.source_at).replace("T", " ").replace(/:\d+$/, "") + "）"
            : "";
        text = "来自全量扫描索引" + at;
        badge.classList.toggle("notice-info", true);
    } else if (src === "scanning") {
        text = "扫描中";
        badge.classList.toggle("notice-warn", true);
        badge.classList.toggle("notice-info", false);
    } else {
        // 旧响应兼容：仅 data.scanning 存在时隐藏（原逻辑）；否则视为 index
        if (data && data.scanning) {
            badge.classList.add("hidden");
            return;
        }
        text = "来自内存缓存（无需重新扫描）";
        badge.classList.toggle("notice-info", true);
    }
    badge.classList.remove("hidden");
    badge.textContent = text;
    badge.classList.remove("cache-badge-in");
    void badge.offsetWidth; // 强制重排，重播入场动画
    badge.classList.add("cache-badge-in");
}

/* L2-9 缓存徽标：显示时 translateX(-8px)+fade 200ms（--dur-2；重触发 = 重播动画）
   阶段B：改为按 data.source 显隐/文案（B-14），回灌（restoreWorkspaceView）复用它 */
export function applyBrowseBadgeFromCache(data) {
    renderCacheBadge(data); // 回灌（restoreWorkspaceView/applyScanView 数据）复用同一渲染器
}

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
    const prevPath = currentPath; // 浏览前位置（relate 栈增删判定用）
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
        /* F06（U4.2 G1 核销）：启动恢复上次浏览位置——成功浏览即写（失败分支不写，保持旧值） */
        try {
            localStorage.setItem("pds_last_browse_v1", JSON.stringify({ root: currentRoot, path: currentPath }));
        } catch (e) { /* 存储不可用：静默（不影响浏览） */ }
        $("browse-root").value = currentRoot;
        /* 阶段B（B-13/B-14）：缓存徽章按后端明确 source 显示（renderCacheBadge） */
        renderCacheBadge(data);
        if (data.scanning) {
            setStatus("browse-status", "warn", data.message || "该盘正在扫描中，完成后即可即时浏览");
        }
        renderBreadcrumb(data.root, data.parent);
        clearSelection(); // N08：导航到新目录后清空多选（路径集合已失效）
        /* 阶段C（C-7）：关系树路径栈同步——树层级 = 从会话根到当前层的目录链。
           下钻（新位置是前位置的子目录）→ push 新层；
           返回上级/跳转（新位置不是子目录）→ 弹出栈尾直至与新位置对齐；
           回会话根（无上级）→ 重置为 [根]。 */
        if (data.parent) {
            if (String(prevPath || "") !== String(data.root) &&
                String(prevPath || "").replace(/[\\/]+$/, "").toUpperCase() ===
                String(data.parent || "").replace(/[\\/]+$/, "").toUpperCase()) {
                pushPath(data.root); // 下钻：prevPath 即新位置的 parent
            } else {
                const stack = getPathStack();
                while (stack.length && String(stack[stack.length - 1]).replace(/[\\/]+$/, "").toUpperCase() !==
                    String(data.root).replace(/[\\/]+$/, "").toUpperCase()) {
                    popPath();
                }
            }
        } else {
            resetPathStack([data.root]); // 会话根：树从根开始
        }
        renderEntries(data, { animate: true }); // L1-2/L1-3：数据到达播行 stagger + 占比条生长
        /* 阶段C（C-7）：relate 键盘连续性——drill 后树内 HTML 重建会丢焦点到 body，
           键盘导航（←/↑↓）即失效；relate 激活且树可见时把焦点放回树容器。
           防抖避免与点击目标抢焦点（点击时事件已完成，此后再聚焦不干扰） */
        if (APP_STATE.view.mode === "relate") {
            const rt = $("relate-tree");
            if (rt && !rt.hasAttribute("hidden")) {
                setTimeout(() => { try { rt.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } }, 0);
            }
        }
        // 只在会话根层级记录「最近浏览」（进入子目录不算新根）
        if (data.root && !data.parent) updateRecentRoots(data.root, quiet);
    } catch (e) {
        if (seq !== browseSeq) return; // 旧失败不打断新结果
        lastBrowse = { root: currentRoot, path: target };
        // U3.4 补漏：子页面（#/compare）期间 browse 失败（如与对比 SDK 扫描锁竞争 409）
        // 时输入框不在 DOM——仅记状态，显示侧由 showBrowseError 自守卫（空守卫纪律）
        const rootInput = $("browse-root");
        if (rootInput) {
            // P12·W2.5（E）：失败回写输入框并聚焦全选，便于直接修正路径
            rootInput.value = target;
            rootInput.focus();
            try { rootInput.select(); } catch (err) { /* 非文本态忽略 */ }
            showBrowseError(e.message, e, () => browsePath(rootInput.value.trim() || target));
        } else {
            showBrowseError(e.message, e, null);
        }
    } finally {
        if (seq === browseSeq) setBrowseLoading(false); // 仅最新请求有权解除 loading
    }
}

/* ---- 最近浏览（写入 config.json 的 last_roots） ---- */

let lastRoots = [];

export function getLastRoots() { return lastRoots; }

/* F06（U4.2 G1 核销）：启动恢复目标读取——pds_last_browse_v1（§3.2 键表 {root,path}）。
   非法/缺失 → null（调用方回落首根 D:\）；root 缺失/非法时仅 path 生效（root 由首根兜底）。 */
export function getStartupBrowsePath() {
    try {
        const raw = localStorage.getItem("pds_last_browse_v1");
        if (!raw) return null;
        const v = JSON.parse(raw);
        if (!v || typeof v.path !== "string" || !/^[A-Za-z]:\\/.test(v.path)) return null;
        const root = (typeof v.root === "string" && /^[A-Za-z]:\\/.test(v.root)) ? v.root : null;
        return { root: root, path: v.path };
    } catch (e) {
        return null;
    }
}

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
    // 应用**当前**视图状态：首挂 = APP_STATE.view.mode（U2.5 默认矩形图，N01 接管）；
    // 路由返回时保持用户选择（切页不丢，view 状态存 APP_STATE）。
    setDrillHandler((path) => browsePath(path)); // list.js 行点击/下钻图标回调（防循环依赖）
    bindList(); // U2.5：列表多选/页脚/虚拟滚动/触屏长按接线（每挂载容器新绑）
    setBrowseView(APP_STATE.view.mode);
    $("btn-view-treemap").addEventListener("click", () => setBrowseView("treemap"));
    $("btn-view-ranking").addEventListener("click", () => setBrowseView("ranking"));
    $("btn-view-table").addEventListener("click", () => setBrowseView("table"));
    /* 阶段C（C-7）：关系目录按钮（父子层级树视图） */
    const relateBtn = $("btn-view-relate");
    if (relateBtn) relateBtn.addEventListener("click", () => setBrowseView("relate"));
    /* 阶段C（C-7）：关系树容器键盘（↑↓ 移动、→/Enter 下钻展开、← 上级、
       Home/End 首尾；U4.1 矩阵）——与 treemap 键盘互斥（各视图容器独立） */
    const relateTree = $("relate-tree");
    if (relateTree) {
        relateTree.addEventListener("keydown", (ev) => {
            if (APP_STATE.view.mode !== "relate") return;
            if (isTypingEvent(ev)) return; // U4.1：输入框/可编辑守卫同口径
            const handled = handleRelateKey(ev, (p) => browsePath(p), () => { if (browseParent) goUp(); });
            if (handled) ev.stopPropagation();
        });
        /* 关系树行点击委托：目录行单击 = 展开下钻（复用 browse 加载）；
           行内按钮（下钻/定位/复制）不触发行级下钻（F19 语义） */
        relateTree.addEventListener("click", (ev) => {
            if (APP_STATE.view.mode !== "relate") return;
            const btn = ev.target.closest(".act-drill, .act-open, .act-copy");
            if (btn) {
                const p = btn.getAttribute("data-act-path");
                if (btn.classList.contains("act-drill")) { if (p) browsePath(p); return; }
                if (btn.classList.contains("act-open")) { openInExplorer(p); return; }
                if (btn.classList.contains("act-copy")) { copyPath(p); return; }
            }
            const row = ev.target.closest(".relate-row[data-path]");
            if (row) {
                const p = row.getAttribute("data-path");
                if (p && row.classList.contains("relate-dir")) browsePath(p);
            }
        });
    }
    $("btn-density").addEventListener("click", () => {
        // U2.5：密度状态存 APP_STATE.view.density（§3.2；紧凑 26px / 舒适 36px 行高）
        APP_STATE.view.density = APP_STATE.view.density === "compact" ? "cozy" : "compact";
        const compact = APP_STATE.view.density === "compact";
        $("btn-density").setAttribute("aria-pressed", String(compact));
        $("btn-density").textContent = compact ? "舒适列表" : "紧凑列表";
        if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData);
    });
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
                if (isTypingEvent(ev)) return; // U4.1：keys.js 共享守卫（输入框/可编辑/isComposing）同口径
                if (document.querySelector(".modal:not(.hidden)")) return;
                if (APP_STATE.view.mode === "treemap" && browseParent) { ev.preventDefault(); goUp(); }
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
    // U2.5（F19）：新增「下钻」图标（仅目录行渲染）——三图标 下钻/定位/复制路径
    $("dir-body").addEventListener("click", (ev) => {
        const drillBtn = ev.target.closest(".act-drill");
        if (drillBtn) { browsePath(drillBtn.getAttribute("data-act-path")); return; }
        const openBtn = ev.target.closest(".act-open");
        if (openBtn) { openInExplorer(openBtn.getAttribute("data-act-path")); return; }
        const copyBtn = ev.target.closest(".act-copy");
        if (copyBtn) { copyPath(copyBtn.getAttribute("data-act-path")); return; }
    });
}

/* ============================================================
   U2.1：工作台页面（路由契约 render/mount/unmount）
   - 模板 = U1.3 index.html 工作台区域（左列 + 右栏卡）机械搬移，
     结构/类/ID 逐字一致（视觉逐字节不变；browse-chart 已随 U2.0 删除；
     U3.4 旧「历史对比」卡迁 #/compare 并移除）；
   - 绑定集合由 main.js 装配（bindOnboarding/bindOverview/bindWorkspace/
     bindScan/bindWorkspaceGuide；U3.4 起 bindCompare 随对比卡摘除——
     对比接线在 pages/compare.js mountCompare），避免 workspace↔scan 互引成环；
   - unmount：本阶段无 rAF/轮询归本页（扫描轮询属全局 scan 模块，
     切页期间经空守卫维持轮询，U3.2 顶栏微型环接管展示）。
   ============================================================ */

const WORKSPACE_HTML =
    '<h1 class="sr-only" data-page-title>工作台</h1>' +
    '<main class="main-col">' +

    '<!-- U3.1：首启引导 hero 卡迁出为壳级弹层（#onboarding，F02 弹层化——见 index.html 与 onboarding.js） -->' +

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
    '<button id="btn-view-treemap" class="btn btn-sm btn-primary" title="矩形图视图（默认，定稿 N01）">矩形图</button>' +
    '<button id="btn-view-ranking" class="btn btn-sm">排行</button>' +
    '<button id="btn-view-table" class="btn btn-sm">表格</button>' +
    '<!-- 阶段C（C-7）：关系目录（父子层级树，D3 裁定；懒展开单击复用 browse 加载） -->' +
    '<button id="btn-view-relate" class="btn btn-sm" title="关系目录（父子层级树，单击展开子目录）">关系</button>' +
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

    '<!-- 视图区（flex:1；面板内滚；U2.5：treemap/table 两容器 absolute 叠加——120ms 交叉淡化共用视口） -->' +
    '<div class="view-area" id="view-area">' +
    '<div class="table-wrap" id="table-wrap">' +
    '<!-- 阶段C（C-7）：关系目录树容器（与 #dir-body 表格互斥显示；懒展开父子层级树） -->' +
    '<div id="relate-tree" class="relate-tree" hidden tabindex="0" aria-label="关系目录树（父子层级；↑↓ 移动，→/Enter 展开子目录，← 收起）"></div>' +
    '<!-- 加载态 L1-5 骨架屏（shimmer 1.4s；替代原 spinner——spinner 仅存于按钮） -->' +
    '<div id="browse-loading" class="loading-overlay hidden">' +
    '<div class="skel-list" aria-hidden="true">' +
    '<div class="skel-row"><span class="skel-check"></span><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-check"></span><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-check"></span><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-check"></span><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-check"></span><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-check"></span><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '</div>' +
    '<span id="browse-loading-text">正在扫描目录，请稍候…</span></div>' +
    '<table class="dir-table" aria-label="当前目录内容"><thead><tr>' +
    '<th class="cell-check"><input type="checkbox" id="check-all" aria-label="全选当前列表"></th>' +
    '<th>名称</th><th class="col-size">大小</th><th class="col-share">占比</th><th class="col-type">类型</th>' +
    '</tr></thead>' +
    '<tbody id="dir-body"></tbody></table>' +
    '<!-- N08 页脚固定行（sticky bottom；「定位所选/导出所选 CSV」选中后出现；导出=D9 前端 Blob） -->' +
    '<div class="list-footer" id="list-footer">' +
    '<span id="list-count" class="list-stats">共 0 项</span>' +
    '<span id="list-selected" class="list-stats">已选 0 项</span>' +
    '<span class="list-footer-actions" id="list-selected-actions" hidden>' +
    '<button id="btn-locate-selected" class="btn btn-sm" title="滚动到第一个已选条目">定位所选</button>' +
    '<button id="btn-export-selected" class="btn btn-sm" title="把已选条目导出为 CSV（前端生成，Excel 可直接打开）">导出所选 CSV</button>' +
    '</span>' +
    '</div>' +
    '</div>' +
    '<!-- [N01] 矩形图视图（U2.2：viz/treemap.js 双层 canvas 渲染器 + tooltip；U4.1：tabindex=0 键盘可达——聚焦后 ↑↓←→ 最近邻 + Enter 下钻；aria-label 摘要由 renderTreemap 更新） -->' +
    '<div class="treemap-wrap" id="treemap-wrap" hidden tabindex="0" aria-label="目录空间矩形图（当前目录数据加载后更新摘要）"></div>' +
    '</div>' +

    '<!-- [N09] 迷你条带位（视图区底部 48px；U2.3 装配 L3-7 上级构成，DOM 静态不动画） -->' +
    '<div class="strip-slot" id="strip-slot" data-slot="minimap" hidden></div>' +
    '</main>' +

    '<!-- 右栏 300px（§3.2；面板内滚允许） -->' +
    '<aside class="side-rail" id="side-rail">' +

    '<!-- [N04] 存储概览卡（U2.4 环形图卡：viz/donut.js + 盘符 chips（D15 只切环形数据不切目录）+ 图例 + 「浏览此盘」唯一跳转入口；数据源不变 /api/overview；无总容量字段 → 环形=已使用之环比降级，见 components/storage.js 注记） -->' +
    '<!-- 阶段B（B-12）：导出按钮移入概览卡头部（结果区）；id 不变（smoke 断言面），扫描卡内移除 -->' +
    '<section id="overview-panel" class="overview-panel" aria-label="存储概览" aria-live="polite" role="region">' +
    '<div class="overview-head"><div><h2>存储概览</h2><p id="overview-meta">完成全量扫描后显示索引空间分布</p></div>' +
    '<div class="overview-actions">' +
    '<button id="btn-export-csv" class="btn btn-sm" title="把最近一次全量结果导出为 CSV" disabled>导出 CSV</button>' +
    '<button id="btn-export-json" class="btn btn-sm" title="把最近一次全量结果导出为 JSON" disabled>导出 JSON</button>' +
    '<button id="btn-overview-refresh" class="btn btn-sm">刷新</button></div></div>' +
    '<div id="overview-roots" class="overview-roots overview-roots-donut"><div class="overview-empty">暂无概览数据</div></div>' +
    '</section>' +

    '<!-- 扫描控制卡（U3.2 状态机四态：空闲/扫描中[#btn-stop-scan 红描边 L2-2+计时]/完成[L2-3 绿光+对勾]/中止；结构保留全部既有 id） -->' +
    '<section class="card" aria-label="全量扫描">' +
    '<div class="card-head"><h2>' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12H2"/><path d="M5.5 5.5 2 12l3.5 6.5"/><path d="M18.5 5.5 22 12l-3.5 6.5"/><rect x="4" y="3" width="8" height="18" rx="2"/><rect x="12" y="3" width="8" height="18" rx="2"/></svg>' +
    '全量扫描</h2><p class="card-sub">建立最新空间索引</p></div>' +
    '<div class="row">' +
    '<button id="btn-fullscan" class="btn btn-primary">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
    '<span id="btn-fullscan-label">开始全量扫描</span></button>' +
    '<button id="btn-stop-scan" class="btn btn-stop" hidden title="停止扫描（已完成部分可浏览）" aria-label="停止扫描">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>' +
    '停止</button>' +
    '<button id="btn-save" class="btn btn-success" disabled title="全量扫描完成后可保存">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>' +
    '保存快照</button>' +
    // 阶段B（B-12）：引导提示块折叠为可关闭的「？」气泡（点击展开/收起 #scan-progress-hint）
    '<button id="btn-scan-help" class="btn btn-sm btn-ghost scan-help-btn" type="button" title="扫描提示（可关闭）" aria-label="扫描提示" aria-expanded="false">？</button>' +
    '</div>' +
    // 阶段B（B-12）：进度行整合——总进度 % · 已完成 x/y 盘 · 当前 C:\ · 已用 t · 预计剩余 ~T（估算）
    '<div class="progress-wrap"><div id="progress" class="progress"><div id="progress-fill" class="progress-fill"></div></div>' +
    '<span id="progress-pct" class="progress-pct muted">0%</span>' +
    '<span id="scan-check" class="scan-check hidden" hidden aria-label="已完成"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span></div>' +
    '<div id="fullscan-status" class="status-line" role="status"><span class="dot"></span><span id="fullscan-status-text">尚未开始全量扫描</span><span id="scan-elapsed" class="scan-elapsed muted" hidden></span><span id="scan-eta" class="scan-eta muted" hidden></span></div>' +
    '<div id="scan-roots" class="chips-row hidden"></div>' +
    '<div id="scan-progress-hint" class="notice notice-info hidden"></div>' +
    '<div id="save-prompt" class="notice notice-warn hidden"><div><b>全量扫描已完成。</b>是否保存本次快照？保存后可在「历史对比」中与基线对比。</div>' +
    '<div class="row"><button id="btn-save-now" class="btn btn-success btn-sm">立即保存</button>' +
    '<button id="btn-save-later" class="btn btn-sm">暂不保存</button></div></div>' +
    '</section>' +

    '<!-- [N06] 快照迷你卡（U2.4：最近一份 +「管理快照」入口 + 空态；U3.3：撤销/刷新/全部会话折叠区随子页面接线迁至 #/snapshots 页头与列表——F16 撤销最近保存 + F17 完整会话分组列表；条目点击=与上一份对比） -->' +
    '<section class="card snapshot-mini-card" aria-label="快照">' +
    '<div class="card-head"><h2>' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>' +
    '快照</h2><button id="btn-manage-snapshots" class="btn btn-sm">管理快照</button></div>' +
    '<div id="snapshot-mini-entry" class="snapshot-mini-entry"><div class="snapshot-mini-empty"><b>正在加载快照…</b></div></div>' +
    '<div id="snapshot-status" class="status-line"><span class="dot"></span><span id="snapshot-status-text">正在加载历史快照…</span></div>' +
    '</section>' +

    '<!-- [U3.4] 历史对比卡已随 #/compare 对比工作台迁整页（F18）；主页仅留「最近对比」迷你入口（本卡已移除，ids 迁 #/compare） -->' +
    '<!-- [U2.4] 最近对比迷你卡（state.compare.lastSummary + 空态引导；点击跳 #/compare——U3.4 起为主页唯一对比入口） -->' +
    '<section class="card compare-mini-card" aria-label="最近对比">' +
    '<div class="card-head"><h2>' +
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l4-6 4 3 5-7"/></svg>' +
    '最近对比</h2><button id="btn-compare-mini-go" class="btn btn-sm">去对比</button></div>' +
    '<div id="compare-mini-body" class="compare-mini-body"></div>' +
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
   U2.2：treemap 视图回灌不经入场动画（数据未重新到达，直绘终帧）。
   U2.5：列表回灌 animate:false（不作 L1-2/L1-3——「重进不重放」与虚拟滚动纪律一致）。 */
export function restoreWorkspaceView() {
    if (!APP_STATE.lastBrowseData) return;
    const rootInput = $("browse-root");
    if (rootInput) rootInput.value = getCurrentRoot();
    renderBreadcrumb(getCurrentPath(), browseParent);
    // 阶段B（B-13/B-14）：回灌同样按 source 恢复缓存徽章（不重发请求）
    renderCacheBadge(APP_STATE.lastBrowseData);
    if (APP_STATE.view.mode === "treemap") renderTreemap(APP_STATE.lastBrowseData, "none");
    else if (APP_STATE.view.mode === "relate") {
        // 阶段C（C-7）：关系树回灌——显示树容器 + 隐藏表格（互斥终态）
        showRelate();
        const entries = (APP_STATE.lastBrowseData.directories || []).concat(APP_STATE.lastBrowseData.files || []);
        if (entries.length) renderRelateTree(APP_STATE.lastBrowseData, { animate: false, density: APP_STATE.view.density });
        else renderRelateEmpty(APP_STATE.lastBrowseData);
    }
    else renderEntries(APP_STATE.lastBrowseData, { animate: false });
    renderStrip();
}
