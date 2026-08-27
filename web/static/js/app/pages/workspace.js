/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/workspace.js（U2.0 从 app.js 迁入）
   - 目录浏览卡片全套逻辑逐一迁入（§3.6 机制 #1 browseSeq 竞态、
     #11 文件行零请求、#12 筛选空态清除）；
   - ⚠️ 偏差注记：映射表既定「browse-chart 与 renderComposition 删除（D12）」
     本项落地——renderComposition 函数及其 2 处调用移除（U1.3 已用 CSS 隐藏过渡，
     视觉无变化；Treemap 由 U2.2 承接）；
   - 跨模块可变状态经导出访问器读写（模块化拆分导出 setter/getter，行为等价）。
   ============================================================ */

import { $, esc, postJson } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { toast } from "../components/toast.js";
import { setStatus } from "../components/statusbar.js";
import { renderApiError } from "../components/feedback.js";

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

export function renderEntries(data) {
    const body = $("dir-body");
    body.classList.toggle("compact-list", compactDensity);
    APP_STATE.lastBrowseData = data;
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
    // 视图切换与密度（N10 工具栏位沿用；U2.5 扩展多选等）
    $("btn-view-ranking").classList.add("btn-primary");
    $("btn-view-table").classList.remove("btn-primary");
    $("btn-view-ranking").addEventListener("click", () => { browseView = "ranking"; $("btn-view-ranking").classList.add("btn-primary"); $("btn-view-table").classList.remove("btn-primary"); if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData); });
    $("btn-view-table").addEventListener("click", () => { browseView = "table"; $("btn-view-table").classList.add("btn-primary"); $("btn-view-ranking").classList.remove("btn-primary"); if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData); });
    $("btn-density").addEventListener("click", () => { compactDensity = !compactDensity; $("btn-density").setAttribute("aria-pressed", String(compactDensity)); $("btn-density").textContent = compactDensity ? "舒适列表" : "紧凑列表"; if (APP_STATE.lastBrowseData) renderEntries(APP_STATE.lastBrowseData); });
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
    $("btn-back").addEventListener("click", () => {
        if (browseParent) browsePath(browseParent);
    });
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
