/* ============================================================
   UI 2.0（SpaceLens Pro）· components/list.js（U2.5 新建）
   - 排行/表格视图渲染（filteredEntries/renderEntries 列表部分自
     pages/workspace.js 迁出；workspace.js 保留接线：treemap 派发、
     视图切换/事件委托/浏览闭环）；
   - N08 多选：首列 checkbox（表头全选/半选态）+ Shift 范围选 +
     页脚固定行「共 N 项 · 已选 N 项 · [定位所选][导出所选 CSV]」；
     导出 = 前端 Blob（D9：文件名 所选-{目录名}-{日期}.csv；CSV 转义
     引号/逗号/换行；列：名称/路径/类型/大小(字节)/大小(可读)，复用
     humanBytes；BOM utf-8-sig 与后端 /api/export 口径一致）；
   - 虚拟滚动：>200 行启用（缓冲上下各 5 行；行高 cozy 36 / compact 26，
     实际值以渲染后测量为准——全部行同构，测量值即真值，无跳行）；
     滚动窗口重渲染（scroll/resize/密度变化）不重放 L1-2/L1-3；
   - L1-2 列表行 stagger（可视区前 12 行 fadeSlide8，间隔 24ms token
     --dur-stagger-row；虚拟滚动中不重放）；L1-3 占比条生长（width
     0→目标 600ms（--dur-4）ease-out，同屏同起点）；reduced 直显；
   - 状态对齐 §3.2：view.{mode,density} 由 workspace 维护（本模块只读）；
     selection 命名空间（{keys,anchor}；key=条目 path）本模块启用。
   ============================================================ */

import { $, esc, humanBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { staggerIn, motionDur, reducedMotion } from "../motion.js";
import { setStatus, renderStatusbarSelection } from "./statusbar.js";

/* ---- 虚拟滚动参数（手册 §U2.5：>200 行启用；缓冲 5 行；行高 cozy 36/compact 26） ---- */
const VIRTUAL_THRESHOLD = 200;
const VIRTUAL_BUFFER = 5;
const ROW_HEIGHT = { cozy: 36, compact: 26 };
/* 触屏长按呼出行操作（F19；交互参数非动画时长，故不入 motion token） */
const TOUCH_HOLD_MS = 500;

/* 当前渲染的筛选后条目（多选 range / CSV 导出 / 定位所选的数据源） */
let currentEntries = [];
/* 虚拟窗口渲染态（排序/筛选/密度变化后由 renderList 重置） */
let virtualState = { active: false, rowH: 0, start: -1, end: -1, density: null };

/* ================= 筛选/排序（沿用既有 id 与语义，红线 #12 空态在 renderList） ================= */

export function getFilteredEntries(data) {
    const query = ($("browse-filter") && $("browse-filter").value || "").trim().toLowerCase();
    const kind = ($("browse-kind") && $("browse-kind").value) || "all";
    const sort = ($("browse-sort") && $("browse-sort").value) || "size-desc";
    let entries = (data.directories || []).concat(data.files || []).filter((entry) => {
        return (kind === "all" || (kind === "dir" ? entry.is_dir : !entry.is_dir)) && (!query || String(entry.name).toLowerCase().includes(query));
    });
    entries.sort((a, b) => sort === "name-asc" ? String(a.name).localeCompare(String(b.name), "zh-CN") : sort === "size-asc" ? Number(a.size) - Number(b.size) : Number(b.size) - Number(a.size));
    return entries;
}

/* ================= 多选（APP_STATE.selection；路由切换不丢，导航到新目录时清除） ================= */

export function getSelectionKeys() { return (APP_STATE.selection.keys || []).slice(); }
export function getSelectionCount() { return (APP_STATE.selection.keys || []).length; }

export function clearSelection() {
    APP_STATE.selection.keys = [];
    APP_STATE.selection.anchor = null;
    refreshSelectionUI();
}

/* 页脚与表头状态（checkbox 就地更新——不重建窗口，避免打断点击/焦点） */
function refreshSelectionUI() {
    const sel = new Set(APP_STATE.selection.keys || []);
    document.querySelectorAll("#dir-body .row-check").forEach((c) => {
        const on = sel.has(c.dataset.path);
        if (c.checked !== on) c.checked = on;
    });
    const visibleSel = currentEntries.filter((e) => sel.has(e.path)).length;
    const head = $("check-all");
    if (head) {
        head.checked = currentEntries.length > 0 && visibleSel === currentEntries.length;
        head.indeterminate = visibleSel > 0 && visibleSel < currentEntries.length;
    }
    const totalEl = $("list-count");
    if (totalEl) totalEl.textContent = "共 " + currentEntries.length + " 项";
    const selEl = $("list-selected");
    if (selEl) selEl.textContent = "已选 " + visibleSel + " 项";
    const actions = $("list-selected-actions");
    if (actions) actions.toggleAttribute("hidden", visibleSel === 0);
    /* F22（G3 核销）：全局状态栏「已选 N 项」与本地页脚同源（APP_STATE.selection） */
    renderStatusbarSelection(APP_STATE.selection.keys.length);
}

/* row-check 点击（事件委托入口；ev.shiftKey = Shift 范围选）
   ⚠️ Chromium 语义：checkbox 的激活翻转先于 click 处理器执行（且 preventDefault 不
   撤销该翻转）——处理器里读到的 box.checked 即目标态（未选→点击后为 true）。 */
function onCheckClick(ev) {
    const box = ev.target.closest(".row-check");
    if (!box) return;
    const idx = Number(box.dataset.idx);
    const path = box.dataset.path;
    const next = !!box.checked; // 目标态（Chromium 已预翻转；合成/真实点击一致）
    if (ev.shiftKey && APP_STATE.selection.anchor) {
        const aIdx = currentEntries.findIndex((e) => e.path === APP_STATE.selection.anchor);
        if (aIdx >= 0) {
            const set = new Set(APP_STATE.selection.keys || []);
            const lo = Math.min(aIdx, idx);
            const hi = Math.max(aIdx, idx);
            for (let i = lo; i <= hi; i++) {
                if (next) set.add(currentEntries[i].path); else set.delete(currentEntries[i].path);
            }
            APP_STATE.selection.keys = Array.from(set);
            refreshSelectionUI();
            return;
        }
    }
    const set = new Set(APP_STATE.selection.keys || []);
    if (next) set.add(path); else set.delete(path);
    APP_STATE.selection.keys = Array.from(set);
    APP_STATE.selection.anchor = next ? path : (APP_STATE.selection.anchor === path ? null : APP_STATE.selection.anchor);
    refreshSelectionUI();
}

function onCheckAllClick() {
    const head = $("check-all");
    const next = !!head.checked; // 同上：Chromium 预翻转语义
    APP_STATE.selection.keys = next ? currentEntries.map((e) => e.path) : [];
    APP_STATE.selection.anchor = null;
    refreshSelectionUI();
}

/* ================= 定位所选（第一个已选条目滚入视窗） ================= */

export function locateSelected() {
    const sel = new Set(APP_STATE.selection.keys || []);
    const idx = currentEntries.findIndex((e) => sel.has(e.path));
    if (idx < 0) return;
    const wrap = $("table-wrap");
    if (!wrap) return;
    if (virtualState.active) {
        const rowH = virtualState.rowH || rowHeight();
        wrap.scrollTop = Math.max(0, idx * rowH - Math.floor(wrap.clientHeight / 2));
        recomputeWindow(true);
    } else {
        const box = document.querySelector('#dir-body [data-idx="' + idx + '"]');
        if (box) box.closest("tr").scrollIntoView({ block: "nearest" });
    }
}

/* ================= 导出所选 CSV（D9 前端 Blob；不动 /api/export） ================= */

/* CSV 字段转义：含 引号/逗号/换行 时整体加引号、内部引号翻倍（与 Python csv.writer 语义一致） */
export function csvEscape(value) {
    const s = String(value == null ? "" : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function sanitizeFileName(s) {
    const cleaned = String(s || "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60);
    return cleaned || "root";
}

function dateStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/* dirName：当前目录名（由 workspace 传入——避免 list↔workspace 循环依赖） */
export function exportSelectedCsv(dirName) {
    const sel = new Set(APP_STATE.selection.keys || []);
    const rows = currentEntries.filter((e) => sel.has(e.path));
    if (!rows.length) return;
    const lines = [["名称", "路径", "类型", "大小(字节)", "大小(可读)"]];
    rows.forEach((e) => {
        lines.push([
            e.name, e.path, e.is_dir ? "目录" : "文件",
            String(Number(e.size) || 0), e.size_human || humanBytes(e.size),
        ]);
    });
    // utf-8-sig BOM：Excel 直接打开不乱码（与后端 /api/export csv 口径一致）
    const csv = "\ufeff" + lines.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8-sig" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "所选-" + sanitizeFileName(dirName) + "-" + dateStamp() + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ================= 行内操作（F19 三图标：下钻/定位/复制路径；事件委托在 workspace） ================= */

export function rowActions(path, isDir) {
    return (
        '<span class="row-actions">' +
        (isDir ?
            '<button class="icon-btn act-drill" data-act-path="' + esc(path) + '" title="下钻" aria-label="下钻到 ' + esc(path) + '">' + ICONS.drill + "</button>" :
            "") +
        '<button class="icon-btn act-open" data-act-path="' + esc(path) + '" title="打开所在文件夹" aria-label="打开所在文件夹">' + ICONS.folder + "</button>" +
        '<button class="icon-btn act-copy" data-act-path="' + esc(path) + '" title="复制路径" aria-label="复制路径">' + ICONS.copy + "</button>" +
        "</span>"
    );
}

/* ================= 行渲染（排行/表格；checkbox 首列） ================= */

function checkCell(entry, idx) {
    return (
        '<td class="cell-check"><input type="checkbox" class="row-check" data-idx="' + idx + '"' +
        ' data-path="' + esc(entry.path) + '"' +
        ((APP_STATE.selection.keys || []).indexOf(entry.path) !== -1 ? " checked" : "") +
        ' aria-label="选择 ' + esc(entry.name) + '"></td>'
    );
}

function rankingRow(entry, idx, maxSize) {
    const label = 'aria-label="' + esc(entry.name) + "，" + esc(entry.size_human) + '"';
    const inner =
        '<span class="ranking-name">' + (entry.is_dir ? ICONS.folder : ICONS.file) + esc(entry.name) + '</span>' +
        '<span class="size-track"><span class="size-bar" data-w="' + Math.max(2, Number(entry.size) / maxSize * 100) + '" style="width:' + Math.max(2, Number(entry.size) / maxSize * 100) + '%"></span></span>' +
        "<strong>" + esc(entry.size_human) + "</strong>";
    const content = entry.is_dir
        ? '<div tabindex="0" role="button" class="ranking-row" data-path="' + esc(entry.path) + '" ' + label + ">" + inner + rowActions(entry.path, true) + "</div>"
        : '<div class="ranking-row-static" ' + label + ">" + inner + rowActions(entry.path, false) + "</div>";
    return '<tr' + (idx % 2 ? ' data-alt="1"' : "") + ">" + checkCell(entry, idx) + '<td colspan="4">' + content + "</td></tr>";
}

function tableRow(entry, idx, maxSize) {
    const isDir = !!entry.is_dir;
    const nameCell = isDir
        ? '<a href="#" class="dir-link" data-path="' + esc(entry.path) + '" title="进入 ' + esc(entry.path) + '">' +
          ICONS.folder + '<span class="name">' + esc(entry.name) + "\\</span></a>"
        : '<span class="cell-name">' + ICONS.file + '<span class="name">' + esc(entry.name) + "</span></span>";
    const pct = Math.max(2, (Number(entry.size) / maxSize) * 100).toFixed(1);
    return (
        '<tr' + (idx % 2 ? ' data-alt="1"' : "") + ">" +
        checkCell(entry, idx) +
        '<td class="cell-name">' + nameCell + "</td>" +
        '<td class="col-size">' + esc(entry.size_human) + "</td>" +
        '<td class="col-share"><span class="size-track"><span class="size-bar" data-w="' + pct + '" style="width:' + pct + '%"></span></span></td>' +
        '<td class="col-type"><span>' + (isDir ? "目录" : "文件") + "</span>" + rowActions(entry.path, isDir) + "</td>" +
        "</tr>"
    );
}

/* 空态（筛选空态 = 红线 #12 + 「清除筛选」按钮；空目录/暂无数据沿用既有文案） */
function emptyStateHtml(kind, activeQuery) {
    if (kind === "filter-empty") {
        return (
            '<tr><td colspan="5"><div class="empty-state">' +
            "<b>无匹配”" + esc(activeQuery || "(类型筛选)") + "“的结果</b>" +
            '<p>试试更换关键词，或<button class="btn btn-sm" id="btn-clear-filter">清除筛选</button>后查看全部。</p>' +
            "</div></td></tr>"
        );
    }
    if (kind === "ranking") {
        return '<tr><td colspan="5"><div class="empty-state"><b>暂无数据</b><p>扫描后显示目录排行。</p></div></td></tr>';
    }
    return (
        '<tr><td colspan="5"><div class="empty-state">' +
        ICONS.empty +
        "<b>（空目录）</b>" +
        "<p>这里没有找到子目录或文件。可以「返回上级」，或换一个盘符 / 目录再浏览。</p>" +
        "</div></td></tr>"
    );
}

/* ================= 虚拟滚动窗口 ================= */

function rowHeight() {
    return APP_STATE.view.density === "compact" ? ROW_HEIGHT.compact : ROW_HEIGHT.cozy;
}

function scrollBox() { return $("table-wrap"); }

function computeWindow(total, rowH) {
    const wrap = scrollBox();
    if (!wrap) return { start: 0, end: total };
    const viewH = wrap.clientHeight || 1;
    const count = Math.ceil(viewH / rowH) + VIRTUAL_BUFFER * 2;
    const start = Math.max(0, Math.floor(wrap.scrollTop / rowH) - VIRTUAL_BUFFER);
    const end = Math.min(total, start + Math.max(count, VIRTUAL_BUFFER * 2));
    return { start: Math.min(start, total), end: Math.max(end, start) };
}

/* 渲染窗口行（滚动/resize/定位后调用；不触发 L1-2/L1-3——虚拟滚动中不重放） */
function renderVirtualWindow(force) {
    const body = $("dir-body");
    const wrap = scrollBox();
    if (!body || !wrap || !virtualState.active) return;
    const total = currentEntries.length;
    if (!total) return;
    const rowH = virtualState.rowH || rowHeight();
    const win = computeWindow(total, rowH);
    if (!force && win.start === virtualState.start && win.end === virtualState.end) return;
    virtualState.start = win.start;
    virtualState.end = win.end;
    const mode = APP_STATE.view.mode === "table" ? "table" : "ranking";
    const max = maxSizeOf();
    body.innerHTML = (
        spacerHtml(win.start * rowH) +
        currentEntries.slice(win.start, win.end).map((e, i) => (mode === "ranking" ? rankingRow(e, win.start + i, max) : tableRow(e, win.start + i, max))).join("") +
        spacerHtml((total - win.end) * rowH)
    );
    bindRowBehaviors(body, mode);
    measureRowHeight();
}

/* 窗口行渲染需要的最大占比（数据不变，仅按需计算） */
function maxSizeOf() {
    return Math.max(1, ...currentEntries.map((e) => Number(e.size) || 0));
}

function spacerHtml(px) {
    return '<tr class="v-spacer"><td colspan="5" style="height:' + Math.max(0, Math.round(px)) + 'px"></td></tr>';
}

/* 行高以渲染后实测为准（所有行同构，测量值即真值——窗口/间距计算零漂移） */
function measureRowHeight() {
    const body = $("dir-body");
    const row = body && body.querySelector("tr:not(.v-spacer)");
    if (!row) return;
    const h = row.getBoundingClientRect().height;
    if (h > 4) virtualState.rowH = h;
}

/* 行行为绑定（每次 innerHTML 渲染后调用；虚拟窗口只绑窗口行）。
   mode=ranking：仅 .ranking-row[data-path]（既有行为：div 可点击/键盘）；
   mode=table：行级（.dir-link 点击 + row-highlight + 行 Enter/Space）。 */
function bindRowBehaviors(body, mode) {
    body.querySelectorAll(".ranking-row[data-path]").forEach((row) => {
        row.addEventListener("click", (ev) => {
            if (ev.target.closest(".row-actions")) return; // F19：行内操作不触发下钻（修复既有 act-open/act-copy 连带下钻）
            if (row.dataset.suppressClick) return;          // 触屏长按后的回落点击吞掉
            browsePathVia(row.dataset.path);
        });
        row.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            if (ev.target.closest(".row-actions")) return; // 行内操作按钮聚焦时 Enter 交给按钮
            ev.preventDefault();
            browsePathVia(row.dataset.path);
        });
    });
    if (mode !== "table") return;
    body.querySelectorAll(".dir-link").forEach((link) => {
        link.addEventListener("click", (ev) => {
            ev.preventDefault();
            browsePathVia(link.getAttribute("data-path"));
        });
    });
    body.querySelectorAll("tr:not(.v-spacer)").forEach((row) => {
        row.addEventListener("mouseenter", () => row.classList.add("row-highlight"));
        row.addEventListener("mouseleave", () => row.classList.remove("row-highlight"));
        row.setAttribute("tabindex", "0");
        row.setAttribute("role", "row");
        row.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            if (ev.target && ev.target.tagName === "INPUT") return; // checkbox/输入控件聚焦时交出默认行为（空间键不被劫持）
            const link = row.querySelector(".dir-link");
            if (link) { ev.preventDefault(); link.click(); }
        });
    });
}

/* 下钻回调注入（workspace 接线时注入，避免 list↔workspace 循环依赖） */
let drillHandler = null;
export function setDrillHandler(fn) { drillHandler = fn; }
function browsePathVia(path) { if (drillHandler) drillHandler(path); }

/* ================= L1-2 行 stagger / L1-3 占比条生长 ================= */

function playListAnimations() {
    if (reducedMotion()) return; // 全局降级：直显终值
    const body = $("dir-body");
    if (!body) return;
    // L1-2：可视区前 12 行 stagger（排行=行 div；表格=tr）
    const rankRows = body.querySelectorAll(".ranking-row, .ranking-row-static");
    const tableRows = body.querySelectorAll("tr:not(.v-spacer)");
    const rows = Array.from(rankRows.length ? rankRows : tableRows).slice(0, 12);
    if (rows.length) staggerIn(rows, { y: 8, delay: motionDur("--dur-stagger-row") });
    const bars = Array.from(body.querySelectorAll(".size-bar"));
    if (!bars.length) return;
    // L1-3：同屏同起点（先压 0，下一帧统一放开过渡）
    bars.forEach((b) => { b.style.transition = "none"; b.style.width = "0"; });
    requestAnimationFrame(() => requestAnimationFrame(() => {
        bars.forEach((b) => {
            b.style.transition = "";
            b.style.width = b.dataset.w + "%";
        });
    }));
}

/* ================= 主渲染（renderList：排行/表格视图的全量入口） ================= */

export function renderList(data, opts = {}) {
    const body = $("dir-body");
    if (!body) return; // U2.1：子页面时列表不在 DOM
    const animate = !!opts.animate;
    const mode = APP_STATE.view.mode === "table" ? "table" : "ranking";
    const compact = APP_STATE.view.density === "compact";
    body.classList.toggle("compact-list", compact);
    currentEntries = getFilteredEntries(data);

    /* P12·W2.5-H：筛选空态——原始条目非空但被筛选清空时给出统一空态＋一键清除（红线 #12） */
    const rawCount = (data.directories || []).length + (data.files || []).length;
    const activeQuery = ($("browse-filter") && $("browse-filter").value || "").trim();
    const activeKind = ($("browse-kind") && $("browse-kind").value) || "all";
    if (!currentEntries.length && rawCount > 0 && (activeQuery || activeKind !== "all")) {
        body.innerHTML = emptyStateHtml("filter-empty", activeQuery || "(类型筛选)");
        setStatus("browse-status", "warn", "没有匹配当前筛选的条目");
        const clearBtn = document.getElementById("btn-clear-filter");
        if (clearBtn) clearBtn.addEventListener("click", () => {
            if ($("browse-filter")) $("browse-filter").value = "";
            if ($("browse-kind")) $("browse-kind").value = "all";
            if (APP_STATE.lastBrowseData) renderList(APP_STATE.lastBrowseData);
        });
        refreshSelectionUI();
        return;
    }
    if (!currentEntries.length) {
        body.innerHTML = mode === "ranking" ? emptyStateHtml("ranking") : emptyStateHtml("empty");
        if (mode === "ranking") setStatus("browse-status", "ok", "排行视图 · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件");
        refreshSelectionUI();
        return;
    }

    const total = currentEntries.length;
    const maxSize = Math.max(1, ...currentEntries.map((e) => Number(e.size) || 0));
    const virtual = total > VIRTUAL_THRESHOLD;
    virtualState.active = virtual;
    const density = compact ? "compact" : "cozy";
    if (virtualState.density !== density) { virtualState.rowH = 0; virtualState.density = density; } // 密度切换：行高重新实测
    body.classList.toggle("v-virtual", virtual);
    const rowH = virtualState.rowH || rowHeight();

    if (virtual) {
        const win = computeWindow(total, rowH);
        virtualState.start = win.start;
        virtualState.end = win.end;
        body.innerHTML = (
            spacerHtml(win.start * rowH) +
            currentEntries.slice(win.start, win.end).map((e, i) => (mode === "ranking" ? rankingRow(e, win.start + i, maxSize) : tableRow(e, win.start + i, maxSize))).join("") +
            spacerHtml((total - win.end) * rowH)
        );
        measureRowHeight();
        virtualState.start = win.start;
        virtualState.end = win.end;
    } else {
        virtualState.start = 0;
        virtualState.end = total;
        body.innerHTML = currentEntries.map((e, i) => (mode === "ranking" ? rankingRow(e, i, maxSize) : tableRow(e, i, maxSize))).join("");
    }
    bindRowBehaviors(body, mode);

    const modeName = mode === "ranking" ? "排行视图" : "表格视图";
    const extra = [];
    if (Number(data.total_dirs) > 200) extra.push("目录仅显示最大的 200 个");
    if (Number(data.total_files) > 200) extra.push("文件仅显示最大的 200 个");
    const note = extra.length ? "（" + extra.join("；") + "）" : "";
    setStatus("browse-status", "ok", modeName + " · 共 " + data.total_dirs + " 个子目录 / " + data.total_files + " 个文件" + note);

    if (animate) playListAnimations();
    refreshSelectionUI();
}

/* 滚动窗口重算（scroll 事件 rAF 节流入口；排序/筛选/密度变化经 renderList 全量重置） */
function onScrollTick() {
    if (!virtualState.active) return;
    renderVirtualWindow(false);
}

/* 容器 size 变化（跨路由重建后每容器只绑一次；路径行/密度变化引发的高度变化） */
let scrollResizeObs = null;

/* ================= 接线（workspace bind 时调用；DOM 每次挂载都是新元素，直接绑） ================= */

export function bindList() {
    const wrap = scrollBox();
    if (wrap) {
        let raf = 0;
        wrap.addEventListener("scroll", () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; onScrollTick(); });
        }, { passive: true });
        if (scrollResizeObs) scrollResizeObs.disconnect();
        scrollResizeObs = new ResizeObserver(() => { if (virtualState.active) renderVirtualWindow(true); });
        scrollResizeObs.observe(wrap);
    }
    const body = $("dir-body");
    if (body) {
        // 多选：checkbox 点击（Shift 范围选）/ 表头全选（事件委托，行不单独绑）
        body.addEventListener("click", onCheckClick);
        const head = $("check-all");
        if (head) head.addEventListener("click", onCheckAllClick);
        bindTouch(body);
    }
    const locateBtn = $("btn-locate-selected");
    if (locateBtn) locateBtn.addEventListener("click", locateSelected);
    const exportBtn = $("btn-export-selected");
    if (exportBtn) exportBtn.addEventListener("click", () => {
        exportSelectedCsv(boardDirName());
    });
    refreshSelectionUI();
}

/* 当前目录名（CSV 文件名用；从面包屑 current 取，避免 import workspace） */
function boardDirName() {
    const crumb = document.querySelector("#breadcrumb .crumb-current");
    const text = crumb ? crumb.getAttribute("title") || crumb.textContent : "";
    const parts = String(text).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "root";
}

/* 触屏长按呼出行操作（F19；<900px 触屏场景；长按后按住处回落点击吞一次防误下钻）。
   document 级清理监听只绑一次（跨路由重挂不重复注册，同 workspace scanListenerBound 模式） */
let docTouchBound = false;
function bindTouch(body) {
    let timer = 0;
    body.addEventListener("touchstart", (ev) => {
        const row = ev.target.closest("tr");
        if (!row) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            document.querySelectorAll("#dir-body .row-actions-pin").forEach((el) => el.classList.remove("row-actions-pin"));
            row.classList.add("row-actions-pin");
            row.dataset.suppressClick = "1";
            setTimeout(() => { delete row.dataset.suppressClick; }, TOUCH_HOLD_MS * 2);
        }, TOUCH_HOLD_MS);
    }, { passive: true });
    body.addEventListener("touchend", () => clearTimeout(timer), { passive: true });
    body.addEventListener("touchcancel", () => clearTimeout(timer), { passive: true });
    if (docTouchBound) return;
    docTouchBound = true;
    document.addEventListener("touchstart", () => {
        document.querySelectorAll("#dir-body .row-actions-pin").forEach((el) => el.classList.remove("row-actions-pin"));
    }, { passive: true });
}
