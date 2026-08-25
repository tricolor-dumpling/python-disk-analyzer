"use strict";

/* ============================================================
   Python 磁盘扫描 · 前端交互（Phase 3：中文交互细化）
   - 原生 JS，无框架；
   - 图标全部为内联 SVG（自绘，见 web/static/assets/来源清单.md）；
   - 术语与 README 一致：全量扫描 / 快照 / 历史对比 / 基线快照 /
     数据目录 / 一键清空 / 自动保存 / 撤销。
   ============================================================ */

const $ = (id) => document.getElementById(id);

/* ================= 内联 SVG 图标 ================= */

const ICONS = {
    folder:
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    file:
        '<svg class="icon file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/></svg>',
    drive:
        '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="8" height="18" rx="2"/><rect x="12" y="3" width="8" height="18" rx="2"/><path d="M22 12H2"/></svg>',
    empty:
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" opacity="0.6"/><path d="M3 13h18"/></svg>',
    clock:
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
    success:
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5.5"/></svg>',
    warn:
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    error:
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/></svg>',
    info:
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    close:
        '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    copy:
        '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    spinner:
        '<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>',
};

/* ================= 基础工具 ================= */

function esc(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

async function api(url, options) {
    const resp = await fetch(url, options);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
        // P12·W1.3：新形态错误 {ok,error,code,detail} 把 code/detail 挂到 Error 上；
        // 旧形态 {ok,error} 无 code —— 渲染器据此降级（RT-N04 双向容忍）。
        const err = new Error(data.error || ("请求失败：" + resp.status));
        if (data && data.code !== undefined && data.code !== null) err.code = data.code;
        if (data && data.detail) err.detail = data.detail;
        throw err;
    }
    return data;
}

function postJson(url, payload) {
    return api(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
    });
}

/* 与后端 utils.human_size 一致的格式（两位小数 + 单位） */
function humanBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = Number(n);
    let i = 0;
    while (Math.abs(v) >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return v.toFixed(2) + " " + units[i];
}

/* 带符号的变化量（+12.34 MB / -8.10 MB） */
function signedBytes(n) {
    if (n === null || n === undefined) return "-";
    const v = Number(n);
    if (v === 0) return "0.00 B";
    return (v > 0 ? "+" : "") + humanBytes(v);
}

/* ================= Toast 提示 ================= */

function toast(message, type, timeoutMs) {
    const kind = ["success", "warn", "error", "info"].includes(type) ? type : "info";
    const icons = { success: ICONS.success, warn: ICONS.warn, error: ICONS.error, info: ICONS.info };
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    el.innerHTML =
        '<span class="toast-icon">' + icons[kind] + "</span>" +
        '<span class="toast-text"></span>' +
        '<button class="toast-close" title="关闭">' + ICONS.close + "</button>";
    el.querySelector(".toast-text").textContent = message;
    const remove = () => {
        if (!el.parentNode) return;
        el.classList.add("leaving");
        setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".toast-close").addEventListener("click", remove);
    $("toast-container").appendChild(el);
    const ttl = timeoutMs || (kind === "error" ? 6500 : 4000);
    setTimeout(remove, ttl);
}

/* ================= 状态行 ================= */

/* kind: "" | ok | warn | err | busy */
function setStatus(id, kind, text) {
    const el = $(id);
    el.className = "status-line" + (kind ? " " + kind : "");
    $(id + "-text").textContent = text;
}

/* ================= 首启引导 ================= */

const GUIDE_KEY = "pds_onboarding_dismissed_v1";

function showGuide() {
    $("onboarding").classList.remove("hidden");
}

function dismissGuide() {
    $("onboarding").classList.add("hidden");
    try {
        localStorage.setItem(GUIDE_KEY, "1");
    } catch (e) { /* localStorage 不可用时仅本次隐藏 */ }
}

function loadGuide() {
    let dismissed = false;
    try {
        dismissed = !!localStorage.getItem(GUIDE_KEY);
    } catch (e) { /* ignore */ }
    if (!dismissed) showGuide();
}

/* ================= 健康检查 ================= */

async function refreshHealth() {
    const badge = $("health-badge");
    try {
        const data = await api("/api/health");
        badge.className = data.ready ? "badge badge-ok" : "badge badge-warn";
        $("health-text").textContent = data.message || (data.ready ? "Everything 已就绪" : "Everything 未就绪");
        badge.title = data.dll ? "Everything DLL：" + data.dll : "";
        return data; // P12·W1.3：门控求值需要完整 health 载荷
    } catch (e) {
        badge.className = "badge badge-err";
        $("health-text").textContent = "健康检查失败";
        return null;
    }
}

/* ================= 环境引导态（P12·W1.3） ================= */

/* 统一 API 错误渲染器：主文案 + 错误码标记（仅新形态）+ detail 小字 +
   [重试][查看帮助]。err.code===undefined 即旧形态错误响应，仅显示主文案。 */
function renderApiError(box, err, onRetry) {
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

function showBrowseGuide(h) {
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

function hideBrowseGuide() {
    const box = $("browse-guide");
    if (box) box.classList.add("hidden");
}

/* 环境门控（RT-02 边界）：只在首次加载与「重试环境检测」两处求值；
   15s 轮询只刷徽章、绝不重评本门控。ready → 自动浏览首根；否则进引导态。 */
function evaluateEnvGate(h) {
    if (!h) {
        showBrowseGuide(null);
        return;
    }
    if (h.ready) {
        hideBrowseGuide();
        browsePath(currentRoot || "D:\\", true);
    } else {
        showBrowseGuide(h);
    }
}

/* ================= 空间概览 ================= */

async function refreshOverview() {
    const box = $("overview-roots");
    if (!box) return;
    try {
        const data = await api("/api/overview");
        if (data.scanning) {
            $("overview-meta").textContent = "扫描中 " + (data.progress_pct || 0) + "% · " + (data.current_root || "准备中");
            box.innerHTML = '<div class="overview-empty"><b>正在扫描磁盘</b><span>已完成 ' + (data.roots_done || 0) + ' / ' + (data.roots_total || 0) + ' 个盘</span></div>';
            return;
        }
        if (!data.ready || !data.roots.length) {
            $("overview-meta").textContent = "完成全量扫描后显示索引空间分布";
            box.innerHTML = '<div class="overview-empty"><b>' + (data.empty_reason === "no_scan" ? "尚未扫描" : "暂无概览数据") + '</b><span>开始一次全量扫描以建立空间索引</span></div>';
            return;
        }
        $("overview-meta").textContent = data.completed_at ? "最近扫描：" + String(data.completed_at).replace("T", " ") : "索引已就绪";
        box.innerHTML = data.roots.map((item) => {
            const statusLabel = item.index_valid ? "索引有效" : "索引失效";
            const statusClass = item.index_valid ? "tag-auto" : "tag-skip";
            const totalLabel = item.index_valid ? (item.total_human || "0 B") : "需重新扫描";
            const top = (item.directories || []).slice(0, 5);
            const max = Math.max(1, ...top.map((x) => Number(x.size) || 0));
            const bars = top.map((x) => '<button class="overview-bar" data-path="' + esc(x.path) + '" title="' + esc(x.path) + '" aria-label="查看 ' + esc(x.name) + '，' + esc(x.size_human) + '"><span class="overview-bar-label">' + esc(x.name) + '</span><span class="overview-track"><i style="width:' + Math.max(2, Number(x.size) / max * 100) + '%"></i></span><strong>' + esc(x.size_human) + '</strong></button>').join("");
            return '<article class="root-summary"><header><strong>' + esc(item.root) + '</strong><span class="tag ' + statusClass + '">' + statusLabel + '</span></header><div class="root-total">' + esc(totalLabel) + '</div><div class="root-meta">' + esc(item.directory_count) + ' 个目录 · ' + esc(item.file_count) + ' 个文件 · ' + esc(item.record_count) + ' 条记录 · ' + esc(item.completed_at || "时间未知") + '</div><div class="chart-title">目录占用排行</div><div class="overview-bars">' + (bars || '<span class="muted">暂无目录数据</span>') + '</div><button class="btn btn-primary btn-sm overview-open" data-root="' + esc(item.root) + '">打开浏览</button></article>';
        }).join("");
        box.querySelectorAll("[data-root]").forEach((el) => el.addEventListener("click", () => { currentRoot = el.dataset.root; $("browse-root").value = currentRoot; browsePath(currentRoot); }));
        box.querySelectorAll(".overview-bar").forEach((el) => {
            el.addEventListener("mouseenter", () => el.classList.add("row-highlight"));
            el.addEventListener("mouseleave", () => el.classList.remove("row-highlight"));
            el.addEventListener("click", () => browsePath(el.dataset.path));
            el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); browsePath(el.dataset.path); } });
        });
    } catch (e) { $("overview-meta").textContent = "概览暂不可用"; box.innerHTML = '<div class="overview-empty"><b>概览暂不可用</b><span>' + esc(e.message) + '</span></div>'; }
}

/* ================= 目录浏览 ================= */

let currentRoot = "D:\\"; // 用户本次浏览会话的根（面包屑/返回不越过它）
let currentPath = "D:\\"; // 当前正在查看的目录
let browseHistory = [];

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
async function copyPath(path) {
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
async function openInExplorer(path) {
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
    $("btn-back").disabled = !parent;
}

function showBrowseError(message, err, onRetry) {
    setStatus("browse-status", "err", message);
    const box = $("browse-error");
    const textEl = $("browse-error-text");
    if (err && err.code !== undefined && err.code !== null) {
        // P12·W1.3 新形态错误：统一渲染器（文案+码+detail+重试/帮助）
        renderApiError(textEl, err, onRetry);
    } else {
        textEl.textContent = message;
    }
    $("browse-error").classList.remove("hidden");
}

function hideBrowseError() {
    $("browse-error").classList.add("hidden");
}

function setBrowseLoading(loading, text) {
    $("browse-loading").classList.toggle("hidden", !loading);
    $("browse-loading-text").textContent = text || "正在扫描目录，请稍候…";
    $("btn-browse").disabled = loading;
}

let browseView = "ranking";
let browseFilter = "all";
let compactDensity = false;

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

function renderComposition(data, entries) {
    const chart = $("browse-chart");
    const dirs = entries.filter((e) => e.is_dir).reduce((n, e) => n + Number(e.size || 0), 0);
    const files = entries.filter((e) => !e.is_dir).reduce((n, e) => n + Number(e.size || 0), 0);
    const total = dirs + files;
    if (!total) { chart.hidden = true; chart.innerHTML = ""; return; }
    const dirPct = Math.round(dirs / total * 100);
    chart.hidden = false;
    chart.innerHTML = '<div class="composition-title">当前目录构成</div><div class="composition-visual" role="img" aria-label="目录内容 ' + dirPct + '%，文件内容 ' + (100 - dirPct) + '%"><svg class="composition-donut" viewBox="0 0 42 42" aria-hidden="true"><circle class="donut-bg" cx="21" cy="21" r="15.9155"></circle><circle class="donut-value" cx="21" cy="21" r="15.9155" pathLength="100" stroke-dasharray="' + dirPct + ' ' + (100 - dirPct) + '"></circle></svg><div class="composition-total">' + esc(data.root || "当前目录") + '</div></div><div class="composition-legend"><span><i class="legend-dir"></i>目录 ' + dirPct + '%</span><span><i class="legend-file"></i>文件 ' + (100 - dirPct) + '%</span></div>';
}

function renderEntries(data) {
    const body = $("dir-body");
    body.classList.toggle("compact-list", compactDensity);
    window.__lastBrowseData = data;
    const entries = filteredEntries(data);
    renderComposition(data, entries);
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

async function browsePath(path, quiet) {
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
        showBrowseError(e.message, e, () => browsePath($("browse-root").value.trim() || target));
    } finally {
        if (seq === browseSeq) setBrowseLoading(false); // 仅最新请求有权解除 loading
    }
}

/* ---- 最近浏览（写入 config.json 的 last_roots） ---- */

let lastRoots = [];

function renderRecentChips() {
    const box = $("recent-roots");
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

async function updateRecentRoots(root, quiet) {
    const value = normalizeRoot(root);
    if (!value) return;
    const upper = value.toUpperCase();
    lastRoots = [value].concat(lastRoots.filter((r) => String(r).toUpperCase() !== upper)).slice(0, 5);
    renderRecentChips();
    if (!quiet) {
        try {
            await postJson("/api/settings", { last_roots: lastRoots });
        } catch (e) { /* 记录失败不影响浏览 */ }
    }
}

/* ================= 全量扫描 ================= */

let autoSaveSetting = false;
let handledScanVersion = 0; // 已处理过「是否保存」提示的扫描代次

function renderScanRootChips(roots, rootsDone, running) {
    const box = $("scan-roots");
    const hint = $("scan-progress-hint");
    if (!roots || !roots.length) {
        box.classList.add("hidden");
        hint.classList.add("hidden");
        return;
    }
    const done = Number(rootsDone) || 0;
    box.innerHTML =
        '<span class="chips-label">可浏览盘符：</span>' +
        roots
            .map((r, i) => {
                const complete = i < done || !running;
                return complete
                    ? '<button class="chip" data-root="' + esc(r) + '" title="浏览 ' + esc(r) + '">' + ICONS.drive + esc(r) + "</button>"
                    : '<span class="chip" aria-label="扫描中">' + ICONS.drive + esc(r) + " · 扫描中</span>";
            })
            .join("");
    box.classList.remove("hidden");
    if (running && done < roots.length) {
        hint.textContent = "正在扫描中：已完成盘可点击即时浏览，进行中盘完成后即可浏览。";
        hint.classList.remove("hidden");
    } else {
        hint.classList.add("hidden");
    }
    box.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            currentRoot = chip.getAttribute("data-root");
            $("browse-root").value = currentRoot;
            browsePath(currentRoot);
        });
    });
}

async function startFullscan() {
    $("btn-fullscan").disabled = true;
    $("save-prompt").classList.add("hidden");
    setStatus("fullscan-status", "busy", "正在启动后台全量扫描…");
    try {
        const data = await postJson("/api/fullscan/start", {});
        toast(data.message || "全量扫描已启动", "info");
        pollFullscan();
    } catch (e) {
        toast(e.message, "error");
        pollFullscan(); // 同步真实状态（如“已在运行中”）
    }
}

async function pollFullscan() {
    let st;
    try {
        const data = await api("/api/fullscan/status");
        st = data.status;
    } catch (e) {
        setStatus("fullscan-status", "err", "无法获取扫描状态：" + e.message);
        return;
    }
    renderFullscanState(st);
    if (st.running) setTimeout(pollFullscan, 1000);
}

function renderFullscanState(st) {
    const pct = Number(st.progress_pct) || 0;
    $("progress-fill").style.width = pct + "%";
    $("progress-pct").textContent = pct + "%";
    $("progress").classList.toggle("running", !!st.running);
    $("btn-fullscan").disabled = !!st.running;
    renderScanRootChips(st.roots, st.roots_done, !!st.running);

    if (st.running) {
        $("btn-save").disabled = true;
        setStatus(
            "fullscan-status",
            "busy",
            "正在扫描 " + st.roots_done + "/" + st.roots_total + "：" + (st.current_root || "准备中…")
        );
        return;
    }

    if (st.error) {
        $("btn-save").disabled = true;
        setStatus("fullscan-status", "err", "全量扫描失败：" + st.error);
        return;
    }

    if (st.result_ready) {
        $("btn-save").disabled = !st.save_ready;
        setStatus("fullscan-status", "ok", "全量扫描已完成，结果就绪" + (st.save_ready ? "，可保存快照" : ""));
        maybePromptSave(st);
        return;
    }

    $("btn-save").disabled = true;
    if (!st.roots || !st.roots.length) {
        setStatus("fullscan-status", "", "尚未开始全量扫描");
    }
    // 其他未覆盖状态保留当前文案
}

function maybePromptSave(st) {
    if (!st.save_ready) return;
    const version = Number(st.scan_version) || 0;
    if (handledScanVersion >= version) return;
    handledScanVersion = version;
    if (autoSaveSetting) {
        saveSnapshot(true);
    } else {
        $("save-prompt").classList.remove("hidden");
    }
}

async function saveSnapshot(auto) {
    $("save-prompt").classList.add("hidden");
    $("btn-save").disabled = true;
    try {
        const data = await postJson("/api/save", { auto: !!auto });
        toast(data.message || "保存完成", "success");
        if (auto) toast("已自动保存快照；如需回退可点「撤销最近保存」", "info");
        refreshSnapshots();
    } catch (e) {
        toast(e.message, "error");
    } finally {
        pollFullscan();
    }
}

async function undoLastSave() {
    const ok = await confirmDialog({
        title: "撤销最近一次保存",
        text: "将删除最近一次保存生成的快照文件与保存清单。此操作不可恢复，确定继续吗？",
        okLabel: "撤销",
    });
    if (!ok) return;
    try {
        const data = await postJson("/api/save/undo", {});
        toast(data.message || "已撤销最近一次保存", "success");
        refreshSnapshots();
        pollFullscan();
    } catch (e) {
        toast(e.message, "error");
    }
}

/* ================= 历史快照 ================= */

let sessionsCache = [];

function formatCreatedAt(text) {
    return String(text || "").replace("T", " ");
}

async function refreshSnapshots() {
    setStatus("snapshot-status", "busy", "正在加载历史快照…");
    try {
        const data = await api("/api/snapshots");
        sessionsCache = data.sessions || [];
        renderSnapshotList(sessionsCache);
        rebuildBaselineSuggest(sessionsCache);
        setStatus("snapshot-status", "", "共 " + sessionsCache.length + " 个快照会话");
    } catch (e) {
        setStatus("snapshot-status", "err", e.message);
    }
}

function renderSnapshotList(sessions) {
    const list = $("snapshot-list");
    if (!sessions.length) {
        list.innerHTML =
            '<li><div class="empty-state">' +
            ICONS.empty +
            "<b>暂无快照会话</b>" +
            "<p>完成一次「全量扫描」并点击「保存快照」，这里就会按保存会话列出 C、D 两份快照。</p>" +
            "</div></li>";
        return;
    }
    list.innerHTML = sessions
        .map((s) => {
            const roots = Object.values(s.roots || {});
            const rootLines = roots.length
                ? '<ul class="session-roots">' +
                  roots
                      .map((r) => {
                          if (r.skipped) {
                              return (
                                  "<li>" + ICONS.drive +
                                  '<span>' + esc(r.root || "?") + '</span>' +
                                  '<span class="tag tag-skip">跳过</span>' +
                                  '<span>' + esc(r.skip_reason || "跳过") + "</span></li>"
                              );
                          }
                          return (
                              "<li>" + ICONS.drive +
                              "<span>" + esc(r.root || "?") + " →</span>" +
                              "<code>" + esc(r.snapshot || "缺快照") + "</code></li>"
                          );
                      })
                      .join("") +
                  "</ul>"
                : '<div class="session-sub">该会话没有快照记录</div>';
            return (
                '<li class="session-item">' +
                '<div class="session-head">' +
                '<span class="session-title">' + ICONS.clock +
                esc(formatCreatedAt(s.created_at || s.session_id)) + "</span>" +
                (s.auto ? '<span class="tag tag-auto">自动</span>' : '<span class="tag tag-manual">手动</span>') +
                "</div>" +
                '<div class="session-sub">' + esc(s.session_id) + "</div>" +
                rootLines +
                "</li>"
            );
        })
        .join("");
}

function rebuildBaselineSuggest(sessions) {
    const list = $("baseline-suggest");
    list.innerHTML = "";
    sessions.forEach((s) => {
        Object.values(s.roots || {}).forEach((r) => {
            if (r.snapshot_path) {
                const opt = document.createElement("option");
                opt.value = r.snapshot_path;
                list.appendChild(opt);
            }
        });
    });
}

/* ================= 历史对比 ================= */

function deltaClass(v) {
    if (v > 0) return "grow";
    if (v < 0) return "shrink";
    return "flat";
}

async function compareSnapshots() {
    let baseline = $("compare-baseline").value.trim();
    if (!baseline) {
        const latest = sessionsCache[0];
        if (!latest) {
            setStatus("compare-status", "warn", "没有可用的历史快照，请先完成全量扫描并保存");
            return;
        }
        const firstRoot = Object.values(latest.roots || {})[0];
        if (!firstRoot || firstRoot.skipped || !firstRoot.snapshot_path) {
            setStatus("compare-status", "warn", "最近会话没有可对比的快照文件，请先在下方指定基线路径");
            return;
        }
        baseline = firstRoot.snapshot_path;
        $("compare-baseline").value = baseline;
    }

    const btn = $("btn-compare");
    btn.disabled = true;
    setStatus("compare-status", "busy", "正在对比，请稍候…");
    try {
        const data = await postJson("/api/compare", {
            root: currentRoot || currentPath,
            baseline: baseline,
        });
        renderCompareResult(data.report);
    } catch (e) {
        $("compare-result").classList.add("hidden");
        setStatus("compare-status", "err", e.message);
    } finally {
        btn.disabled = false;
    }
}

function renderCompareResult(r) {
    const summary = $("compare-summary");
    const delta = Number(r.delta_total);
    const rows = r.rows || [];
    const added = rows.filter((row) => row.added || Number(row.baseline_size || 0) === 0 && Number(row.current_size || 0) > 0).length;
    const removed = rows.filter((row) => row.removed || Number(row.current_size || 0) === 0 && Number(row.baseline_size || 0) > 0).length;
    const largest = rows.slice().sort((a, b) => Math.abs(Number(b.delta)) - Math.abs(Number(a.delta)))[0];
    // P12·W1.2：基线含「已知异常大小」行时前置 warn 提示（additive 字段 legacy_count）
    const legacyNotice = Number(r.legacy_count) > 0
        ? '<div class="notice notice-warn compare-legacy" style="grid-column:1/-1">基线含 ' +
          esc(Number(r.legacy_count)) +
          " 条已知异常大小数据，对比数字可能失真，建议重扫重建基线。</div>"
        : "";
    summary.innerHTML =
        legacyNotice +
        '<div class="stat"><span class="stat-label">基线总大小</span><span class="stat-value">' + humanBytes(r.total_baseline) + "</span></div>" +
        '<div class="stat"><span class="stat-label">当前总大小</span><span class="stat-value">' + humanBytes(r.total_current) + "</span></div>" +
        '<div class="stat"><span class="stat-label">总变化量</span><span class="stat-value ' + deltaClass(delta) + '">' + signedBytes(delta) + "</span></div>" +
        '<div class="stat"><span class="stat-label">新增 / 删除</span><span class="stat-value">' + added + ' / ' + removed + "</span></div>" +
        '<div class="stat"><span class="stat-label">变化最大目录</span><span class="stat-value stat-path">' + esc(largest ? largest.path : "无") + "</span></div>";

    const chart = $("compare-chart");
    chart.innerHTML = rows.slice().sort((a, b) => Math.abs(Number(b.delta)) - Math.abs(Number(a.delta))).slice(0, 8).map((row) => '<button class="change-row" data-path="' + esc(row.path || "") + '" title="查看 ' + esc(row.path || "") + '" aria-label="' + esc(row.path || "") + ' ' + esc(signedBytes(Number(row.delta))) + '"><span>' + esc(row.path) + '</span><i class="change-bar ' + deltaClass(Number(row.delta)) + '" style="width:' + Math.min(100, Math.max(3, Math.abs(Number(row.delta)) / Math.max(1, Math.abs(Number(delta))) * 100)) + '%"></i><strong>' + esc(signedBytes(Number(row.delta))) + '</strong></button>').join("");
    chart.querySelectorAll(".change-row[data-path]").forEach((el) => {
        el.addEventListener("mouseenter", () => el.classList.add("row-highlight"));
        el.addEventListener("focus", () => el.classList.add("row-highlight"));
        el.addEventListener("blur", () => el.classList.remove("row-highlight"));
        el.addEventListener("mouseleave", () => el.classList.remove("row-highlight"));
        el.addEventListener("click", () => browsePath(el.dataset.path));
        el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); browsePath(el.dataset.path); } });
    });
    const body = $("compare-body");
    if (!rows.length) {
        body.innerHTML =
            '<tr><td colspan="4"><div class="empty-state">' +
            ICONS.success +
            "<b>无差异</b><p>当前结果与基线快照一致，没有找到大小变化的目录。</p></div></td></tr>";
    } else {
        body.innerHTML = rows
            .map((row) => {
                const d = Number(row.delta);
                const growth = row.growth_pct == null ? "-" : (row.growth_pct >= 0 ? "+" : "") + row.growth_pct.toFixed(2) + "%";
                const tags = [];
                if (row.added) tags.push('<span class="tag tag-added">新增</span>');
                if (row.removed) tags.push('<span class="tag tag-removed">已删除</span>');
                return (
                    "<tr>" +
                    '<td class="delta-cell ' + deltaClass(d) + '">' + signedBytes(d) + "</td>" +
                    "<td>" + esc(growth) + "</td>" +
                    '<td><span class="cell-name"><span class="name" title="' + esc(row.path) + '">' + esc(row.path) + "</span>" +
                    tags.join("") + "</span></td>" +
                    // P12·W1.4：对比明细行尾「复制路径」操作列
                    '<td><button class="icon-btn act-copy-cmp" data-act-path="' + esc(row.path) + '" title="复制路径" aria-label="复制路径">' + ICONS.copy + "</button></td>" +
                    "</tr>"
                );
            })
            .join("");
    }

    const extra = r.truncated ? "（仅显示变化最大的 100 条）" : "（共 " + rows.length + " 条差异）";
    setStatus(
        "compare-status",
        "ok",
        "对比完成：" + humanBytes(r.total_baseline) + " → " + humanBytes(r.total_current) +
        "，变化 " + signedBytes(delta) + extra
    );
    $("compare-result").classList.remove("hidden");
}

/* ================= 设置 ================= */

let dataDir = "";

async function openSettings() {
    $("settings-modal").classList.remove("hidden");
    setStatusForSettingsHealth();
    try {
        const data = await api("/api/settings");
        autoSaveSetting = !!data.settings.auto_save;
        $("setting-auto-save").checked = autoSaveSetting;
        dataDir = data.data_dir || "";
        if (dataDir) $("setting-data-dir").value = dataDir;
        const roots = data.settings.last_roots;
        if (Array.isArray(roots) && roots.length) {
            lastRoots = roots.slice(0, 5);
            renderRecentChips();
        }
    } catch (e) {
        toast("读取设置失败：" + e.message, "error");
    }
}

async function setStatusForSettingsHealth() {
    $("setting-health").value = "正在检查…";
    try {
        const data = await api("/api/health");
        $("setting-health").value = (data.message || "") + (data.dll ? "（" + data.dll + "）" : "");
    } catch (e) {
        $("setting-health").value = "健康检查失败：" + e.message;
    }
}

async function saveSettings() {
    try {
        await postJson("/api/settings", {
            auto_save: $("setting-auto-save").checked,
            theme: "light",
        });
        autoSaveSetting = $("setting-auto-save").checked;
        toast("设置已保存", "success");
        closeModal("settings-modal");
    } catch (e) {
        toast(e.message, "error");
    }
}

function openWipeModal() {
    $("wipe-confirm").value = "";
    $("btn-wipe").disabled = true;
    $("wipe-data-dir").textContent = dataDir || "数据目录";
    $("wipe-modal").classList.remove("hidden");
}

async function wipeData() {
    $("btn-wipe").disabled = true;
    try {
        const data = await postJson("/api/admin/wipe", { confirm: $("wipe-confirm").value.trim() });
        toast(data.message || "数据目录已清空", "success");
        closeModal("wipe-modal");
        closeModal("settings-modal");
        sessionsCache = [];
        renderSnapshotList([]);
        setStatus("snapshot-status", "", "数据目录已清空，历史快照为空");
        $("compare-result").classList.add("hidden");
        pollFullscan();
    } catch (e) {
        toast(e.message, "error");
        $("btn-wipe").disabled = $("wipe-confirm").value.trim() !== "确认清空";
    }
}

/* ================= 通用确认弹窗 ================= */

let confirmResolver = null;

function confirmDialog(options) {
    const opts = options || {};
    $("confirm-title").textContent = opts.title || "确认操作";
    $("confirm-text").textContent = opts.text || "确定继续吗？";
    const okBtn = $("btn-confirm-ok");
    okBtn.textContent = opts.okLabel || "确定";
    okBtn.className = "btn " + (opts.okClass || "btn-danger");
    $("confirm-modal").classList.remove("hidden");
    return new Promise((resolve) => {
        confirmResolver = resolve;
    });
}

function resolveConfirm(value) {
    if (confirmResolver) {
        const resolve = confirmResolver;
        confirmResolver = null;
        closeModal("confirm-modal");
        resolve(value);
    }
}

/* ================= 弹窗管理 ================= */

function closeModal(id) {
    const el = $(id);
    if (el) el.classList.add("hidden");
    if (id === "confirm-modal" && confirmResolver) {
        const resolve = confirmResolver;
        confirmResolver = null;
        resolve(false);
    }
}

function bindModalClose() {
    document.querySelectorAll("[data-close]").forEach((btn) => {
        btn.addEventListener("click", () => closeModal(btn.getAttribute("data-close")));
    });
    // 点击遮罩关闭
    document.querySelectorAll(".modal").forEach((modal) => {
        modal.addEventListener("mousedown", (ev) => {
            if (ev.target === modal) closeModal(modal.id);
        });
    });
    // Esc 关闭最上层弹窗
    document.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
            ev.preventDefault();
            $("browse-root").focus();
            $("browse-root").select();
            return;
        }
        if (ev.key.toLowerCase() === "r" && !/input|textarea|select/i.test(document.activeElement.tagName)) {
            ev.preventDefault();
            browsePath(currentPath);
            return;
        }
        if (ev.key !== "Escape") return;
        const open = ["wipe-modal", "confirm-modal", "settings-modal"].find(
            (id) => !$(id).classList.contains("hidden")
        );
        if (open) closeModal(open);
    });
}

/* ================= 事件绑定 ================= */

function bind() {
    // 引导
    $("btn-onboarding-close").addEventListener("click", dismissGuide);
    $("btn-overview-refresh").addEventListener("click", refreshOverview);
    $("btn-view-ranking").classList.add("btn-primary");
    $("btn-view-table").classList.remove("btn-primary");
    $("btn-view-ranking").addEventListener("click", () => { browseView = "ranking"; $("btn-view-ranking").classList.add("btn-primary"); $("btn-view-table").classList.remove("btn-primary"); if (window.__lastBrowseData) renderEntries(window.__lastBrowseData); });
    $("btn-view-table").addEventListener("click", () => { browseView = "table"; $("btn-view-table").classList.add("btn-primary"); $("btn-view-ranking").classList.remove("btn-primary"); if (window.__lastBrowseData) renderEntries(window.__lastBrowseData); });
    $("btn-density").addEventListener("click", () => { compactDensity = !compactDensity; $("btn-density").setAttribute("aria-pressed", String(compactDensity)); $("btn-density").textContent = compactDensity ? "舒适列表" : "紧凑列表"; if (window.__lastBrowseData) renderEntries(window.__lastBrowseData); });
    ["browse-filter", "browse-kind", "browse-sort"].forEach((id) => $(id).addEventListener("input", () => { if (window.__lastBrowseData) renderEntries(window.__lastBrowseData); }));
    $("btn-guide").addEventListener("click", showGuide);

    // 健康徽章 → 设置（含 Everything 详情）
    $("health-badge").addEventListener("click", openSettings);

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
    $("btn-back").addEventListener("click", () => {
        if (browseParent) browsePath(browseParent);
    });
    $("btn-browse-retry").addEventListener("click", () => {
        // 重试以输入框当前内容为准（用户可能已修正路径）
        currentRoot = normalizeRoot($("browse-root").value) || lastBrowse.root;
        browsePath(currentRoot);
    });

    // P12·W1.3 引导态：重试环境检测（门控第二求值点）与查看指引
    const guideRetry = $("btn-guide-retry");
    if (guideRetry) guideRetry.addEventListener("click", async () => {
        setStatus("browse-status", "busy", "正在重试环境检测…");
        const h = await refreshHealth();
        evaluateEnvGate(h);
    });
    const guideHelp = $("btn-guide-help");
    if (guideHelp) guideHelp.addEventListener("click", showGuide);

    // 全量扫描
    $("btn-fullscan").addEventListener("click", startFullscan);
    $("btn-save").addEventListener("click", () => saveSnapshot(false));
    $("btn-save-now").addEventListener("click", () => saveSnapshot(false));
    $("btn-save-later").addEventListener("click", () => $("save-prompt").classList.add("hidden"));

    // 历史
    $("btn-refresh-snapshots").addEventListener("click", refreshSnapshots);
    $("btn-undo-save").addEventListener("click", undoLastSave);

    // 对比
    $("btn-compare").addEventListener("click", compareSnapshots);
    $("compare-baseline").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") compareSnapshots();
    });

    // 设置
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-settings-save").addEventListener("click", saveSettings);
    $("btn-wipe-open").addEventListener("click", openWipeModal);
    $("wipe-confirm").addEventListener("input", () => {
        $("btn-wipe").disabled = $("wipe-confirm").value.trim() !== "确认清空";
    });
    $("btn-wipe").addEventListener("click", wipeData);

    // 确认弹窗
    $("btn-confirm-ok").addEventListener("click", () => resolveConfirm(true));
    $("btn-confirm-cancel").addEventListener("click", () => resolveConfirm(false));

    // P12·W1.4 行动闭环：行内操作按钮事件委托（绑定一次，随渲染内容更新生效）
    $("dir-body").addEventListener("click", (ev) => {
        const openBtn = ev.target.closest(".act-open");
        if (openBtn) { openInExplorer(openBtn.getAttribute("data-act-path")); return; }
        const copyBtn = ev.target.closest(".act-copy");
        if (copyBtn) { copyPath(copyBtn.getAttribute("data-act-path")); return; }
    });
    $("compare-body").addEventListener("click", (ev) => {
        const copyBtn = ev.target.closest(".act-copy-cmp");
        if (copyBtn) copyPath(copyBtn.getAttribute("data-act-path"));
    });

    bindModalClose();
}

/* ================= 启动 ================= */

(async function init() {
    bind();
    loadGuide();

    // 读取偏好（自动保存开关 + 最近浏览）
    try {
        const data = await api("/api/settings");
        autoSaveSetting = !!data.settings.auto_save;
        dataDir = data.data_dir || "";
        const roots = data.settings.last_roots;
        if (Array.isArray(roots) && roots.length) {
            lastRoots = roots.slice(0, 5);
            renderRecentChips();
        }
    } catch (e) { /* 设置读取失败不影响使用 */ }

    refreshSnapshots();
    pollFullscan(); // 页面刷新后也能恢复「扫描中」状态
    refreshOverview();

    const firstRoot = lastRoots[0] || "D:\\";
    currentRoot = firstRoot;
    $("browse-root").value = firstRoot;

    // P12·W1.3 init 门控（RT-02 边界：仅首拍求值；替换旧的无条件浏览）：
    // ready → 自动浏览首根；未就绪 → 引导态。15s 轮询只刷徽章不重评门控。
    const h = await refreshHealth();
    evaluateEnvGate(h);

    setInterval(refreshHealth, 15000);
})();
