/* ============================================================
   UI 2.0（SpaceLens Pro）· components/storage.js（U2.0 从 app.js 迁入）
   - 空间概览卡：refreshOverview 逐字保留；
   - U2.4 升级为环形图卡（viz/donut.js）时本模块为落点，数据源不变 /api/overview。
   ============================================================ */

import { $, api, esc } from "../api.js";
import { browsePath, setCurrentRoot, getCurrentRoot } from "../pages/workspace.js";

export async function refreshOverview() {
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
        box.querySelectorAll("[data-root]").forEach((el) => el.addEventListener("click", () => { setCurrentRoot(el.dataset.root); $("browse-root").value = getCurrentRoot(); browsePath(getCurrentRoot()); }));
        box.querySelectorAll(".overview-bar").forEach((el) => {
            el.addEventListener("mouseenter", () => el.classList.add("row-highlight"));
            el.addEventListener("mouseleave", () => el.classList.remove("row-highlight"));
            el.addEventListener("click", () => browsePath(el.dataset.path));
            el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); browsePath(el.dataset.path); } });
        });
    } catch (e) { $("overview-meta").textContent = "概览暂不可用"; box.innerHTML = '<div class="overview-empty"><b>概览暂不可用</b><span>' + esc(e.message) + '</span></div>'; }
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的概览刷新段） */
export function bindOverview() {
    $("btn-overview-refresh").addEventListener("click", refreshOverview);
}
