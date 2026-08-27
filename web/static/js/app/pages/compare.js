/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/compare.js（U2.0 从 app.js 迁入）
   - 历史对比（基线/摘要/图表/表格 + W2.4 扫描中 409 + W2.13 异机确认）
     随映射表落户本页模块；U3.4 升级为 #/compare 工作台时本模块为落点。
   ============================================================ */

import { $, postJson, humanBytes, signedBytes, esc } from "../api.js";
import { ICONS } from "../icons.js";
import { setStatus } from "../components/statusbar.js";
import { toast } from "../components/toast.js";
import { confirmDialog } from "../components/modals.js";
import { browsePath, copyPath, getCurrentRoot, getCurrentPath, setCurrentRoot } from "./workspace.js";
import { getSessionsCache, normRoot } from "./snapshots.js";
import { pollFullscan } from "../components/scan.js";

function deltaClass(v) {
    if (v > 0) return "grow";
    if (v < 0) return "shrink";
    return "flat";
}

export async function compareSnapshots(allowOtherMachine) {
    let baseline = $("compare-baseline").value.trim();
    if (!baseline) {
        const latest = getSessionsCache()[0];
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
    let scanPending = false; // W2.4：409 时保持按钮禁用直到扫描完成
    try {
        const data = await postJson("/api/compare", {
            root: getCurrentRoot() || getCurrentPath(),
            baseline: baseline,
            allow_other_machine: !!allowOtherMachine, // P12·W2.13 二次提交放行
        });
        renderCompareResult(data.report);
    } catch (e) {
        // P12·W2.13：异机基线 → 红字确认后二次提交携带 allow 字段
        if (e && e.code === "machine_mismatch") {
            const ok = await confirmDialog({
                title: "跨机器基线确认",
                text: "该基线来自其他机器，对比数字可能误导，仍要继续吗？",
                okLabel: "仍要对比",
                okClass: "btn-danger",
            });
            if (ok) return compareSnapshots(true);
            setStatus("compare-status", "warn", "已取消跨机器对比");
            btn.disabled = false;
            return;
        }
        $("compare-result").classList.add("hidden");
        // P12·W2.4：扫描中 409 → 中性提示＋按钮禁用，pollFullscan 完成分支恢复
        if ((e.message || "").indexOf("全量扫描进行中") !== -1) {
            toast("扫描完成后可对比", "warn");
            btn.disabled = true;
            scanPending = true;
            pollFullscan();
        } else {
            setStatus("compare-status", "err", e.message);
        }
    } finally {
        if (!scanPending) btn.disabled = false;
    }
}

function renderCompareResult(r) {
    const summary = $("compare-summary");
    if (!summary) return; // U2.1：切页至子页面后迟到的对比结果不渲染（数据仍在）
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

    // P12·W3.3：truncated 如实化——真实语义是 compare 行数超 50 万上限截断；
    // 「100 条」只是 top_growth 的固定切片，两回事，不再混为一谈。
    const extra = r.truncated
        ? "（注意：数据集超过快照 50 万行上限已截断，结果可能不完整；下表展示变化最大的 " + rows.length + " 条）"
        : "（展示变化最大的 " + rows.length + " 条差异）";
    // P12·W2.11（B-3）：状态行透出当前数据时间，过期缓存不再伪装实时
    const dataTime = r.current_completed_at
        ? "；当前数据时间 " + String(r.current_completed_at).replace("T", " ")
        : "";
    setStatus(
        "compare-status",
        "ok",
        "对比完成：" + humanBytes(r.total_baseline) + " → " + humanBytes(r.total_current) +
        "，变化 " + signedBytes(delta) + extra + dataTime
    );
    $("compare-result").classList.remove("hidden");
}

/* 本组件在 init 期的绑定（顺序等价：原 bind() 的对比段 + 对比页行内委托段） */
export function bindCompare() {
    // 对比
    $("btn-compare").addEventListener("click", compareSnapshots);
    $("compare-baseline").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") compareSnapshots();
    });
    // P12·W2.4：快照列表一键对比（同根直比；跨盘先切换再自动对比）
    $("snapshot-list").addEventListener("click", (ev) => {
        const btn = ev.target.closest(".act-cmp-snap");
        if (!btn) return;
        const baseline = btn.getAttribute("data-baseline");
        const root = btn.getAttribute("data-root");
        if (normRoot(root) === normRoot(getCurrentRoot())) {
            $("compare-baseline").value = baseline;
            compareSnapshots();
        } else {
            setCurrentRoot(root);
            $("browse-root").value = root;
            $("compare-baseline").value = baseline;
            browsePath(root).then(() => compareSnapshots());
        }
    });
    // P12·W1.4：对比明细行尾「复制路径」
    $("compare-body").addEventListener("click", (ev) => {
        const copyBtn = ev.target.closest(".act-copy-cmp");
        if (copyBtn) copyPath(copyBtn.getAttribute("data-act-path"));
    });
}

/* ============================================================
   U2.1：#/compare 页面（路由契约；占位头 + 空态，U3.4 填充真功能）
   - 布局骨架（§3.3）：页头 64px（标题/基线 datalist/目标只读/开始对比）→
     摘要 3 卡 96px → 发散图 240px → 表格 flex:1 内滚；U3.4 逐块落位；
   - 主页右栏「历史对比」卡在当前阶段仍是可用入口（U3.4 迁移后改为
     最近对比迷你卡）。
   ============================================================ */

const COMPARE_PAGE_HTML =
    '<section class="page page-compare" data-page="compare">' +
    '<header class="page-head">' +
    '<h1 class="page-title" data-page-title>历史对比</h1>' +
    '<p class="page-sub">基线 datalist · 目标只读 · 开始对比（U3.4 接线，见页面空态说明）</p>' +
    '</header>' +
    '<div class="page-body page-body-empty">' +
    '<div class="empty-state">' +
    '<b>选择一份基线快照</b>' +
    '<p>开始对比两个时间点的空间变化。</p>' +
    '<p class="muted">对比工作台将在 U3.4 接入；当前请使用主工作台右栏「历史对比」卡片（该功能已可用）。</p>' +
    '</div></div>' +
    '</section>';

export function renderCompare() {
    const el = document.createElement("div");
    el.innerHTML = COMPARE_PAGE_HTML;
    return el.firstElementChild;
}

export function mountCompare() {
    /* 占位页无交互；U3.4 接入基线/目标/开始对比 */
}

export function unmountCompare() {
    /* 预留 */
}
