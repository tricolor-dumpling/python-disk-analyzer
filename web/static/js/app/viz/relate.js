/* ============================================================
   阶段C（R2）· viz/relate.js（C-7 关系目录 = 父子层级树，D3 裁定）
   - 语义：从当前浏览位置起的父子层级树。树根 = 最近一次 browse 数据
     （目录可展开、文件为叶子）；「展开子目录」= 单击目录行 →
     browsePath(子路径)（复用既有加载链，懒展开按需 1 次/节点，0 额外请求）；
     已展开路径记录于 expandStack（= 浏览历史栈的树语义：逐级下钻），
     供键盘 ←/Backspace 收起与树形态渲染。
   - 渲染：宿主 = #relate-tree（table-wrap 内独立容器，与 #dir-body 表格
     互斥显示——relate 激活时表格 hidden、树显示；切走时树 hidden）。
   - 虚拟化：展开后可见行 > 200 启用（缓冲上下各 5 行；行高 cozy 36 /
     compact 26，与 list.js ROW_HEIGHT 同口径——u24 断言面一致）。
   - 键盘可达（U4.1 矩阵）：容器 tabindex=0；↑/↓ 移动焦点行；
     → / Enter 展开（目录 → browsePath 下钻）；← 收起/返回上级；
     Home/End 跳首尾。行内按钮（下钻/定位/复制）Enter 交按钮。
   - 互斥终态（防 2-2 残留重演）：本模块只在 relate 激活时渲染宿主；
     workspace.setBrowseView 收口所有视图容器显隐（复用 viewSeq/
     finishViewSwap 模式）——本模块零动画、零全局状态残留。
   - 纪律：只读 DOM 渲染 + 事件委托；不触碰 list.js/treemap.js；
     动画红线 P7：仅 opacity/transform（本模块仅行 hover 用 opacity）。
   ============================================================ */

import { $, esc, humanBytes } from "../api.js";
import { ICONS } from "../icons.js";

/* ---- 虚拟滚动参数（与 list.js 同口径：>200 启用、缓冲 5、行高 cozy 36/compact 26） ---- */
const VIRTUAL_THRESHOLD = 200;
const VIRTUAL_BUFFER = 5;
const ROW_HEIGHT = { cozy: 36, compact: 26 };

/* 展开栈（模块级，路由切换不丢：path 数组 = 已展开的目录链，末位为当前层）。
   browsePath 下钻/返回上级后由 workspace 通知本模块重算（setPathStack）。 */
let pathStack = [];
let lastData = null;
let density = "cozy";
let focusPath = null; // 键盘焦点行（path）

/* 当前密度读取（workspace 维护 APP_STATE.view.density；本模块只读镜像，
   由 renderRelateTree 每次传入——避免反向 import workspace 成环） */
function rowHeight() {
    return density === "compact" ? ROW_HEIGHT.compact : ROW_HEIGHT.cozy;
}

/* 当前层条目（目录在前；与 list.js 排序同源：按大小降序） */
function currentEntries(data) {
    const entries = (data.directories || []).concat(data.files || []);
    entries.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    return entries;
}

/* 层级标题（当前层 = pathStack 尾） */
function levelLabel(data) {
    const parts = pathStack.slice();
    return parts.length ? parts[parts.length - 1] : String(data.root || "D:\\");
}

/* ================= 虚拟窗口 ================= */

let virtualState = { active: false, rowH: 0, start: -1, end: -1 };

function computeWindow(total, rowH, host) {
    const viewH = host.clientHeight || 1;
    const count = Math.ceil(viewH / rowH) + VIRTUAL_BUFFER * 2;
    const start = Math.max(0, Math.floor(host.scrollTop / rowH) - VIRTUAL_BUFFER);
    const end = Math.min(total, start + Math.max(count, VIRTUAL_BUFFER * 2));
    return { start: Math.min(start, total), end: Math.max(end, start) };
}

function spacerHtml(px) {
    return '<div class="relate-spacer" style="height:' + Math.max(0, Math.round(px)) + 'px"></div>';
}

/* 单行 HTML：缩进按层级深度；目录可展开（含子项提示）；文件为叶子 */
function rowHtml(entry, depth, total, isFocused) {
    const isDir = !!entry.is_dir;
    const indent = Math.min(depth, 12); // 缩进上限（防深路径撑爆窄屏）
    const size = humanBytes(Number(entry.size) || 0);
    const caret = isDir
        ? '<span class="relate-caret" aria-hidden="true">▸</span>'
        : '<span class="relate-caret relate-caret-leaf" aria-hidden="true"></span>';
    const cls = isDir ? "relate-row relate-dir" : "relate-row relate-file";
    const focusCls = isFocused ? " is-focus" : "";
    const label = 'aria-label="' + esc(entry.name) + "，" + (isDir ? "目录" : "文件") + "，" + size + '"';
    return (
        '<div class="' + cls + focusCls + '" data-path="' + esc(entry.path) + '" ' + label +
        ' style="padding-left:' + (8 + indent * 16) + 'px" tabindex="0" role="treeitem" aria-expanded="' + (isDir ? "false" : "undefined") + '">' +
        caret +
        '<span class="relate-icon">' + (isDir ? ICONS.folder : ICONS.file) + "</span>" +
        '<span class="relate-name">' + esc(entry.name) + (isDir ? "\\" : "") + "</span>" +
        '<span class="relate-size">' + esc(size) + "</span>" +
        '<span class="relate-actions">' +
        (isDir
            ? '<button class="icon-btn act-drill" data-act-path="' + esc(entry.path) + '" title="进入 ' + esc(entry.path) + '" aria-label="进入 ' + esc(entry.name) + '">' + ICONS.drill + "</button>"
            : "") +
        '<button class="icon-btn act-open" data-act-path="' + esc(entry.path) + '" title="打开所在文件夹" aria-label="打开所在文件夹">' +
        '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></button>' +
        '<button class="icon-btn act-copy" data-act-path="' + esc(entry.path) + '" title="复制路径" aria-label="复制路径">' + ICONS.copy + "</button>" +
        "</span></div>"
    );
}

/* 渲染虚拟窗口（scroll/resize 时重算；不重建 data 引用） */
function renderWindow() {
    const host = $("relate-tree");
    if (!host || !lastData) return;
    const entries = currentEntries(lastData);
    const total = entries.length;
    if (!total) return;
    const rowH = virtualState.rowH || rowHeight();
    const win = computeWindow(total, rowH, host);
    if (win.start === virtualState.start && win.end === virtualState.end) return;
    virtualState.start = win.start;
    virtualState.end = win.end;
    const depth = pathStack.length;
    host.innerHTML =
        spacerHtml(win.start * rowH) +
        entries.slice(win.start, win.end).map((e, i) => rowHtml(e, depth, total, e.path === focusPath)).join("") +
        spacerHtml((total - win.end) * rowH);
    measureRowHeight(host);
}

/* 行高实测（与 list.js measureRowHeight 同口径：首行真值驱动窗口计算） */
function measureRowHeight(host) {
    const row = host.querySelector(".relate-row");
    if (!row) return;
    const h = row.getBoundingClientRect().height;
    if (h > 4) virtualState.rowH = h;
}

/* ================= 渲染入口（workspace.renderEntries relate 分支调用） ================= */

export function renderRelateTree(data, opts) {
    const host = $("relate-tree");
    if (!host) return; // 工作台未挂载
    lastData = data;
    density = (opts && opts.density) || "cozy";
    const entries = currentEntries(data);
    const total = entries.length;
    const virtual = total > VIRTUAL_THRESHOLD;
    virtualState.active = virtual;
    virtualState.rowH = 0;
    virtualState.start = -1;
    virtualState.end = -1;
    host.classList.toggle("v-virtual", virtual);
    host.classList.toggle("compact-list", density === "compact");
    const depth = pathStack.length;
    if (virtual) {
        const rowH = rowHeight();
        const win = computeWindow(total, rowH, host);
        virtualState.start = win.start;
        virtualState.end = win.end;
        host.innerHTML =
            spacerHtml(win.start * rowH) +
            entries.slice(win.start, win.end).map((e, i) => rowHtml(e, depth, total, e.path === focusPath)).join("") +
            spacerHtml((total - win.end) * rowH);
        measureRowHeight(host);
    } else {
        virtualState.start = 0;
        virtualState.end = total;
        host.innerHTML = entries.map((e, i) => rowHtml(e, depth, total, e.path === focusPath)).join("");
    }
    host.removeAttribute("hidden");
    host.setAttribute("aria-label",
        "关系目录树：当前层 " + esc(levelLabel(data)) + "，共 " + total + " 项（" +
        (data.directories || []).length + " 个目录 / " + (data.files || []).length + " 个文件）");
}

/* 树形态空态（浏览数据为空目录） */
export function renderRelateEmpty(data) {
    const host = $("relate-tree");
    if (!host) return;
    lastData = data;
    host.innerHTML =
        '<div class="relate-empty"><b>（空目录）</b>' +
        "<p>这里没有找到子目录或文件。可以「返回上级」，或换一个盘符 / 目录再浏览。</p></div>";
    host.removeAttribute("hidden");
}

/* ================= 展开栈维护（workspace browsePath 完成后调用） ================= */

/* 下钻完成：新当前路径入栈（= 已展开层） */
export function pushPath(path) {
    if (path) pathStack.push(String(path).replace(/[\\/]+$/, ""));
}

/* 返回上级完成：弹出栈尾 */
export function popPath() {
    if (pathStack.length) pathStack.pop();
}

/* 外部重置（根切换/回灌时同步） */
export function resetPathStack(paths) {
    pathStack = (paths || []).map((p) => String(p).replace(/[\\/]+$/, ""));
}

export function getPathStack() {
    return pathStack.slice();
}

/* ================= 键盘导航（U4.1 矩阵：↑↓ → ← Enter Home End） ================= */

function entriesForNav() {
    return currentEntries(lastData || {});
}

function moveFocus(delta) {
    const entries = entriesForNav();
    if (!entries.length) return;
    const idx = entries.findIndex((e) => e.path === focusPath);
    const next = idx < 0 ? (delta >= 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, idx + delta));
    focusPath = entries[next].path;
    rerenderKeepScroll(entries[next].path);
    const host = $("relate-tree");
    if (host) {
        const row = host.querySelector('.relate-row[data-path="' + CSS.escape(focusPath) + '"]');
        if (row) {
            row.focus();
            if (virtualState.active) row.scrollIntoView({ block: "nearest" });
        }
    }
}

function rerenderKeepScroll(focus) {
    const host = $("relate-tree");
    if (!host || !lastData) return;
    const entries = currentEntries(lastData);
    const total = entries.length;
    const rowH = virtualState.rowH || rowHeight();
    const win = computeWindow(total, rowH, host);
    host.innerHTML =
        spacerHtml(win.start * rowH) +
        entries.slice(win.start, win.end).map((e, i) => rowHtml(e, pathStack.length, total, e.path === focus)).join("") +
        spacerHtml((total - win.end) * rowH);
    measureRowHeight(host);
}

/* 键盘处理（由 workspace 委托：relate 激活时容器 keydown） */
export function handleRelateKey(ev, onDrill, onUp) {
    if (!lastData) return false;
    const entries = entriesForNav();
    if (!entries.length) return false;
    let handled = true;
    switch (ev.key) {
        case "ArrowDown": ev.preventDefault(); moveFocus(1); break;
        case "ArrowUp": ev.preventDefault(); moveFocus(-1); break;
        case "ArrowRight":
        case "Enter": {
            ev.preventDefault();
            const target = ev.target && ev.target.closest ? ev.target.closest(".relate-row") : null;
            const p = target ? target.getAttribute("data-path") : focusPath;
            const entry = entries.find((e) => e.path === p);
            if (entry && entry.is_dir && onDrill) onDrill(p);
            break;
        }
        case "ArrowLeft": {
            ev.preventDefault();
            if (onUp) onUp();
            break;
        }
        case "Home": ev.preventDefault(); focusPath = entries[0].path; rerenderKeepScroll(entries[0].path); break;
        case "End": ev.preventDefault(); focusPath = entries[entries.length - 1].path; rerenderKeepScroll(entries[entries.length - 1].path); break;
        default: handled = false;
    }
    return handled;
}

/* ================= 互斥收口（workspace.setBrowseView 调用） ================= */

/* relate 激活：树显示、表格 + 页脚隐藏（防 2-2 残留：容器级互斥终态） */
export function showRelate() {
    const tree = $("relate-tree");
    const table = document.querySelector("#table-wrap > table.dir-table");
    const footer = $("list-footer");
    if (tree) tree.removeAttribute("hidden");
    if (table) table.setAttribute("hidden", "");
    if (footer) footer.setAttribute("hidden", "");
    if (tree) try { tree.focus({ preventScroll: true }); } catch (e) { /* 聚焦失败不阻断 */ }
}

/* relate 离开：树隐藏、表格与页脚恢复（由 workspace.setBrowseView 收口） */
export function hideRelate() {
    const tree = $("relate-tree");
    const table = document.querySelector("#table-wrap > table.dir-table");
    const footer = $("list-footer");
    if (tree) tree.setAttribute("hidden", "");
    if (table) table.removeAttribute("hidden");
    if (footer) footer.removeAttribute("hidden");
}
