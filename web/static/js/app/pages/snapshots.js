/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/snapshots.js（U2.0 模块化迁入，U3.3 快照管理页）
   - 布局（§3.3/§3.5）：页头 64px（创建快照 F15 + 撤销最近保存 F16）→
     筛选/批量管理工具条 → 会话分组列表（F17，flex:1 面板内滚）；※ 趋势卡区 2026-09-13 起移除（与对比页重复，趋势归 #/compare）
   - [N07] 趋势卡（较昨日/较上周）：对比基准（历史快照）= 同盘符快照中时间 ≤24h（较昨日）/
     (24h,7d]（较上周）最近的一份（D7：前端就近选对比基准，复用 /api/compare，无新后端）；
     另一侧 = 当前磁盘状态（实时，由全量扫描结果/SDK 直扫得出，**不是**「该盘最新快照」）；
     无合适对比基准 → 「暂无可用的对比基准」；点击卡 → #/compare 并预填
     （APP_STATE.compare，§6.4 跨页传递）；
     P5（D5-5）：术语统一为「对比基准（历史快照）/ 当前磁盘状态（实时）」——
     原「基线=…；目标=该盘最新快照」的措辞把一个"当前磁盘状态"伪装成"目标快照"，
     与 /api/compare 实际口径（app.py 同步/异步两条路径的「当前」侧）自相矛盾；
   - ⚠️ 字段核对结论（执行记录）：/api/snapshots 会话数据（app.py api_snapshots /
     session.py save_session）无「逐次总量」字段（session 载荷仅
     session_id/auto/machine_guid/roots/ledger_backup/created_at，roots 条目仅
     snapshot 名/路径/skipped/skip_reason/notice）→ **sparkline（L3-5）降级为
     「两快照对比差值卡」**（无折线，保留 ▲/▼ 与百分比；不改后端，红线裁决）；
   - 列表区（F17）：会话分组渲染（renderSnapshotList 语义迁移，逐盘「对比此快照」
     = 预填 state.compare + 跳 #/compare——§6.4 跨页形态，U3.4 消费）、
     auto/manual/added/removed 标签、跳过原因 tooltip（红线 #7 SKIP_REASON_TEXT）；
   - 撤销最近保存（F16）= 复用 scan.js undoLastSave 确认弹窗流程（按 §3.6 红线 #9 栈语义）；
   - 「创建快照」（F15）= 复用保存流程（scan.js saveSnapshot）；无全量结果时置灰
     （N06：镜像扫描卡保存按钮派生，经 main.js 注入 canCreate——本模块零 scan.js 依赖
     防环：scan.js → snapshots.js 已有单向依赖）。
   ============================================================ */

import { $, api, postJson, esc, humanBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { setStatus } from "../components/statusbar.js";
import { skipReasonText } from "../labels.js";
import { confirmDialog } from "../components/modals.js"; // 阶段C（C-3）：删除确认弹窗（红线 #9 弹窗栈；批量删除复用）
import { toast } from "../components/toast.js"; // 阶段C（C-3）：删除结果反馈
import { renderSnapshotMini } from "../components/snapshot-mini.js"; // U2.4：N06 迷你条目
import {
    calendarHtml, dayKeyOf, defaultMonth, shiftMonth, todayKey,
    recentListHtml, sessionSavedBytes, splitSessions,
} from "../components/snapshot-view.js"; // 2026-09-13 新增：快照页纯函数（日历/最近快照/会话可见性）

let sessionsCache = [];

/* 模块化拆分导出的读写器（原 smoke 测试恢复点/settings wipeData 清空点的跨模块访问） */
export function getSessionsCache() { return sessionsCache; }
export function setSessionsCache(v) { sessionsCache = v; }

function formatCreatedAt(text) {
    return String(text || "").replace("T", " ");
}

/* P12·W2.4：root 归一化预检——trim + 大写 + 尾反斜杠（终审仍留后端 normcase；
   compare.js 同根直比判定沿用） */
export function normRoot(x) {
    let v = String(x || "").trim().toUpperCase();
    if (!v) return "";
    if (!v.endsWith("\\")) v += "\\";
    return v;
}

/* ================= U3.3：页头动作注入（main.js；防 scan↔snapshots 环：
   scan.js → snapshots.js 为既有单向依赖，本模块不得反向 import scan.js） ================= */

let snapActions = { create: null, undo: null, canCreate: null };

export function setSnapshotsActions(actions) {
    if (actions && typeof actions === "object") {
        snapActions = Object.assign({}, snapActions, actions);
    }
}

/* 「创建快照」可用性（镜像扫描卡保存按钮派生：完成+save_ready / 中止+部分根；
   N06「无全量数据时置灰+提示」） */
function syncCreateAvailability() {
    const btn = $("btn-create-snapshot");
    if (!btn) return;
    const enabled = snapActions.canCreate ? !!snapActions.canCreate() : false;
    btn.disabled = !enabled;
    btn.title = enabled
        ? "保存最近一次全量扫描结果为快照（创建快照）"
        : "暂无全量扫描结果，请先完成全量扫描并保存";
}

/* pds:scan 订阅（模块级一次；快照页挂载后「创建快照」可用性随扫描状态同步——
   与扫描卡保存按钮同派生，事件 detail=status 原样） */
let scanSubscribed = false;
function ensureScanListener() {
    if (scanSubscribed) return;
    scanSubscribed = true;
    window.addEventListener("pds:scan", () => {
        syncCreateAvailability();
    });
}

/* ================= 会话可见性（2026-09-13 第二轮/第三轮用户实测反馈） =================
   「跳过快照里到底有没有保存，没有保存不应该出现，如果保存没有内容也不应该出现」
   「C:\SDK5 这些是测试环境吗，如果是请和真实数据隔离」
   → 展示层只渲染「真的有内容且非夹具」的会话；空会话与夹具会话隐藏并可一键清理。
   ⚠️ 判定是纯函数（components/snapshot-view.js），后端契约不变（审计轨迹仍落盘）。 */

function visibleSessions() {
    return splitSessions(sessionsCache).meaningful;
}

function emptySessions() {
    return splitSessions(sessionsCache).empty;
}

function fixtureSessions() {
    return splitSessions(sessionsCache).fixture;
}

/* 列表头部的「已隐藏 N 个空会话 / M 个测试会话 + 清理」提示条（DOM 无该节点时空守卫） */
function syncHiddenNote() {
    const el = $("snap-hidden-note");
    if (!el) return;
    const emptyN = emptySessions().length;
    const fixtureN = fixtureSessions().length;
    if (!emptyN && !fixtureN) {
        el.setAttribute("hidden", "");
        el.innerHTML = "";
        return;
    }
    const bits = [];
    if (emptyN) bits.push(emptyN + " 个空会话（自动保存被跳过，未产生快照）");
    if (fixtureN) bits.push(fixtureN + " 个测试会话（夹具根 " + fixtureRootSample() + "）");
    el.removeAttribute("hidden");
    el.innerHTML = "已隐藏 " + bits.join(" · ") +
        '<button type="button" class="btn btn-sm btn-ghost" id="btn-clean-hidden" ' +
        'title="删除这些会话的清单与夹具快照文件（不影响真实会话）">清理</button>';
}

/* 夹具根样例（提示条里给一个可辨认的例子，如 C:\SDK1） */
function fixtureRootSample() {
    const s = fixtureSessions()[0];
    if (!s) return "";
    const r = Object.values(s.roots || {}).find((x) => x && x.snapshot_path && !x.skipped);
    return (r && String(r.root || "").replace(/\\+$/, "")) || "";
}

/* 清理空会话 + 测试会话：复用既有整会话删除 API
   （空会话没有快照文件 → 后端只删清单；夹具会话会连带删掉那几 KB 的夹具快照） */
async function cleanHiddenSessions() {
    const empties = emptySessions();
    const fixtures = fixtureSessions();
    const ids = empties.concat(fixtures).map((s) => s.session_id).filter(Boolean);
    if (!ids.length) return;
    const ok = await confirmDialog({
        title: "清理 " + ids.length + " 个非真实会话？",
        text: "包含 " + empties.length + " 个空会话（自动保存被跳过，仅有清单）与 " +
            fixtures.length + " 个测试会话（夹具根，如 C:\\SDK*）。将删除其会话清单与夹具快照文件，不影响真实会话。",
        okLabel: "清理",
        okClass: "btn-danger",
    });
    if (!ok) return;
    let okCount = 0;
    let failCount = 0;
    for (const sid of ids) {
        try {
            await deleteSnapshot(sid, "");
            okCount += 1;
        } catch (e) {
            failCount += 1;
        }
    }
    if (!failCount) toast("已清理 " + okCount + " 个会话", "success");
    else toast("清理完成：" + okCount + " 个成功，" + failCount + " 个失败", failCount === ids.length ? "error" : "warn");
    await refreshSnapshots();
}

/* ================= 刷新与回灌（切页不丢：mount 时从缓存回灌，不重发） ================= */

export async function refreshSnapshots() {
    setStatus("snapshot-status", "busy", "正在加载历史快照…");
    try {
        const data = await api("/api/snapshots");
        sessionsCache = data.sessions || [];
        APP_STATE.snapshots.sessions = sessionsCache; // U3.3：snapshots 命名空间启用
        // R1：广播会话更新——冷启动直达 #/compare 时对比页挂载早于本 fetch 完成，
        // 其基准选项为空且无人重建（既有竞态）；事件由 compare.js 监听并重建选项。
        try { window.dispatchEvent(new CustomEvent("pds:snapshots", { detail: { count: sessionsCache.length } })); } catch (e) { /* ignore */ }
        syncUndoState();
        renderSnapshotList(sessionsCache);
        renderCalendar(); // 2026-09-13：快照日历（月历热力图）
        renderSnapshotMini(visibleSessions()); // U2.4：迷你卡最近一份（只认有内容的会话）
        rebuildBaselineSuggest(sessionsCache);
        setStatus("snapshot-status", "", "共 " + visibleSessions().length + " 个快照会话");
        syncListCount();
    } catch (e) {
        setStatus("snapshot-status", "err", e.message);
    }
}

/* U2.1：路由返回时的视图恢复（快照列表/基线下拉/撤销灰置/状态行从缓存回灌） */
export function applySnapshotsView() {
    syncUndoState();
    renderSnapshotList(sessionsCache);
    renderCalendar(); // 2026-09-13：日历随会话缓存回灌（切页不丢展示月/选中日）
    renderSnapshotMini(visibleSessions()); // U2.4：回挂回灌迷你条目
    rebuildBaselineSuggest(sessionsCache);
    setStatus("snapshot-status", "", "共 " + visibleSessions().length + " 个快照会话");
    syncListCount();
    syncCreateAvailability(); // U3.3：页头「创建快照」可用性（扫描状态镜像）
}

function syncUndoState() {
    // P12·W2.5（D）：无会话时撤销入口灰置
    const undo = $("btn-undo-save");
    if (undo) undo.disabled = !sessionsCache.length;
}

/* ================= 筛选工具条 + 批量选择（趋势卡区移除后：页头直下接筛选条+列表） ================= */

const snapFilter = { root: "all", type: "all", kw: "", day: "" };
const selectedSessions = new Set(); // 批量删除勾选（按 session_id；含「跳过」型空会话）

/* 2026-09-13：日历当前展示月份（"" = 跟随数据最新月份；用户翻月后固定） */
let calMonth = "";

function isFiltering() {
    return snapFilter.root !== "all" || snapFilter.type !== "all" ||
        !!snapFilter.day || !!snapFilter.kw.trim();
}

/* 会话中出现的盘符（动态生成盘符筛选选项；跳过条目也计入） */
function sessionRootsList(sessions) {
    const seen = new Set();
    for (const s of sessions) {
        for (const r of Object.values(s.roots || {})) {
            const lbl = rootLabel(r && r.root);
            if (lbl) seen.add(lbl);
        }
    }
    return Array.from(seen).sort();
}

function sessionMatchesFilter(s) {
    if (snapFilter.type === "auto" && !s.auto) return false;
    if (snapFilter.type === "manual" && s.auto) return false;
    /* 2026-09-13：日历选日筛选（当天口径 = created_at 本地日期；缺失回退 session_id 前缀） */
    if (snapFilter.day) {
        const day = dayKeyOf(s.created_at) || dayKeyOf(s.session_id);
        if (day !== snapFilter.day) return false;
    }
    if (snapFilter.root !== "all") {
        const hit = Object.values(s.roots || {}).some((r) => rootLabel(r && r.root) === snapFilter.root);
        if (!hit) return false;
    }
    const kw = snapFilter.kw.trim().toLowerCase();
    if (kw) {
        const hay = (formatCreatedAt(s.created_at || "") + " " + (s.session_id || "")).toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
    }
    return true;
}

function filteredSessions() {
    // 2026-09-13：只在**有内容**的会话里筛选（空会话已被隐藏，不参与计数/全选/批量）
    return visibleSessions().filter(sessionMatchesFilter);
}

/* 盘符下拉选项随会话数据动态重建（保留当前选中项；选中盘已消失则回落「全部」） */
function rebuildRootFilterOptions() {
    const sel = $("snap-filter-root");
    if (!sel) return;
    const roots = sessionRootsList(visibleSessions());
    sel.innerHTML = '<option value="all">全部盘符</option>' +
        roots.map((r) => '<option value="' + esc(r) + '">' + esc(r) + "</option>").join("");
    if (snapFilter.root !== "all" && roots.indexOf(snapFilter.root) === -1) snapFilter.root = "all";
    sel.value = snapFilter.root;
}

/* 全选框 / 批量删除按钮可用态（未选时禁用） */
function syncBatchBar() {
    const btn = $("snap-btn-batch-del");
    const all = $("snap-check-all");
    const n = selectedSessions.size;
    if (btn) {
        btn.disabled = !n;
        btn.textContent = n ? "已选 " + n + " 项 · 批量删除" : "批量删除";
    }
    if (all) {
        const ids = filteredSessions().map((s) => s.session_id).filter(Boolean);
        all.checked = ids.length > 0 && ids.every((id) => selectedSessions.has(id));
    }
}

function syncListCount() {
    const el = $("snapshots-list-count");
    if (!el) return;
    const n = filteredSessions().length;
    el.textContent = isFiltering()
        ? "共 " + n + " 个会话（已筛选）"
        : "共 " + visibleSessions().length + " 个快照会话";
    syncHiddenNote(); // 2026-09-13：空会话隐藏提示（+ 清理入口）
}

/* ================= 快照日历（2026-09-13 用户实测反馈新增） =================
   可视化：月历热力图，一眼看出「某一天有没有快照 / 有几个」；点日期 = 筛选下方列表。
   渲染与模型全部在 components/snapshot-view.js（零依赖纯函数），
   本处只持有两个状态：calMonth（展示月，"" = 跟随数据最新月）与 snapFilter.day（选中日）。
   ⚠️ 日历只统计**有内容**的会话（空会话已隐藏，不该在日历上留下"有快照"的假象）。 */

function activeCalMonth() {
    return /^\d{4}-\d{2}$/.test(calMonth) ? calMonth : defaultMonth(visibleSessions());
}

function renderCalendar() {
    const host = $("snapshot-calendar");
    if (!host) return; // 子页面时不在 DOM（与其它渲染函数同守卫纪律）
    host.innerHTML = calendarHtml(visibleSessions(), {
        month: activeCalMonth(),
        picked: snapFilter.day,
        today: todayKey(),
    });
    renderRecent();
}

/* 左栏「最近快照」（2026-09-13 第三轮）：填掉日历卡下方的空白，兼作日期快捷入口 */
function renderRecent() {
    const host = $("snapshot-recent");
    if (!host) return;
    host.innerHTML = recentListHtml(visibleSessions(), { limit: 8, picked: snapFilter.day });
}

/* 筛选条件变更统一出口：日历（选中态/统计）+ 列表 + 计数一起重渲染 */
function applyFilterChange() {
    renderCalendar();
    renderSnapshotList(sessionsCache);
    syncListCount();
}
/* 日历/最近快照 事件（委托，DOM 重建后仍生效；两个宿主共用同一处理器）：
   选日（再点同日 = 取消）/ 翻月 / 回本月 / 清除日期筛选 */
function onCalendarClick(ev) {
    const host = ev.currentTarget || $("snapshot-calendar");
    if (!host || !host.contains(ev.target)) return;
    const dayBtn = ev.target.closest("[data-cal-day]");
    if (dayBtn) {
        const day = dayBtn.getAttribute("data-cal-day") || "";
        snapFilter.day = snapFilter.day === day ? "" : day;
        applyFilterChange();
        return;
    }
    const nav = ev.target.closest("[data-cal-nav]");
    if (nav) {
        calMonth = shiftMonth(activeCalMonth(), Number(nav.getAttribute("data-cal-nav")) || 0);
        renderCalendar();
        return;
    }
    if (ev.target.closest("[data-cal-today]")) {
        calMonth = todayKey().slice(0, 7);
        renderCalendar();
        return;
    }
    if (ev.target.closest("[data-cal-clear]")) {
        snapFilter.day = "";
        applyFilterChange();
    }
}

/* ================= 会话列表（F17；renderSnapshotList 语义迁移） ================= */

/* P6（D6-2/变更集3）：列表正文**不再外露原始文件名**。
   原实现直接渲染 `session_20260908_200846_598651_56fbc221_000001.json` 与
   `C_20260908_200846_auto_56fbc221.snap.gz`——用户实测「像 demo」的最大来源。
   新口径（每行只讲用户语言）：
     · 会话行 = 时间 · 自动/手动 · N 个盘 · 合计大小；
     · 盘行   = 盘符 · 该盘快照大小（/api/snapshots additive total_by_root）；
     · 原始文件名（快照名 / 会话 ID / 会话清单文件名）收进行尾「详情」展开区，
       并保留在按钮 title 悬停提示里（信息零丢失，但不再占据正文）。
   判据（p06 探针）：列表可见文本不得出现 `.snap.gz` / `session_` 形态串。 */

/* 快照大小展示（total_by_root 为 additive 字段：旧后端/桩态缺失 → 显示占位符，
   不编造数字、不隐藏该列） */
function fmtSnapSize(bytes) {
    const n = Number(bytes);
    return Number.isFinite(n) && n > 0 ? humanBytes(n) : "—";
}

/* 会话内逐盘合计（仅统计有 size 的盘；无一份可得 → ""）——口径与
   components/snapshot-view.js 的 sessionSavedBytes 同源（后者为纯函数，供日历复用） */
function sessionTotalText(s) {
    const totals = s.total_by_root || {};
    let seen = 0;
    Object.values(s.roots || {}).forEach((r) => {
        if (!r || r.skipped || !r.snapshot_path) return;
        const n = Number(totals[r.root]);
        if (Number.isFinite(n) && n > 0) seen += 1;
    });
    return seen ? humanBytes(sessionSavedBytes(s)) : "";
}

/* 「详情」展开区：会话 ID + 各盘快照文件名/全路径（原始名唯一可见处，可选中复制） */
function sessionDetailHtml(s, roots) {
    const rows = roots
        .map((r) => {
            const name = r.snapshot || (r.skipped ? "（跳过，无快照）" : "缺快照");
            const path = r.snapshot_path ? '<span class="session-detail-path">' + esc(r.snapshot_path) + "</span>" : "";
            return (
                '<li><span class="session-detail-label">' + esc(rootLabel(r.root)) + "</span>" +
                "<code>" + esc(name) + "</code>" + path + "</li>"
            );
        })
        .join("");
    const fileLine = s._file
        ? '<li><span class="session-detail-label">会话清单</span><code>' + esc(s._file) + "</code></li>"
        : "";
    return (
        '<details class="session-detail">' +
        "<summary>详情（会话 ID 与快照文件名）</summary>" +
        '<ul class="session-detail-list">' +
        '<li><span class="session-detail-label">会话 ID</span><code>' + esc(s.session_id || "?") + "</code></li>" +
        fileLine + rows +
        "</ul></details>"
    );
}

export function renderSnapshotList(sessions) {
    const list = $("snapshot-list");
    if (!list) return; // U2.1：子页面时快照卡不在 DOM；U3.3 起列表随快照页渲染
    rebuildRootFilterOptions(); // 盘符选项随会话数据动态更新
    /* 2026-09-13 第二轮反馈：只列表**真的有内容**的会话（空会话见 syncHiddenNote 提示条） */
    const visible = splitSessions(sessions).meaningful;
    if (!visible.length) {
        // 定稿 6.5：快照页无快照（三处空态之一）
        list.innerHTML =
            '<li><div class="empty-state">' +
            ICONS.empty +
            "<b>还没有快照</b>" +
            "<p>全量扫描后保存一份，之后可在这里筛选与批量管理。</p>" +
            "</div></li>";
        syncBatchBar();
        return;
    }
    const filtered = visible.filter(sessionMatchesFilter);
    if (!filtered.length) {
        list.innerHTML =
            '<li><div class="empty-state">' +
            ICONS.empty +
            "<b>没有匹配的会话</b>" +
            "<p>调整盘符 / 类型 / 关键词筛选条件后再试。</p>" +
            "</div></li>";
        syncBatchBar();
        return;
    }
    list.innerHTML = filtered
        .map((s) => {
            const roots = Object.values(s.roots || {});
            const okCount = roots.filter((r) => r && !r.skipped && r.snapshot_path).length;
            const totalText = sessionTotalText(s);
            const metaBits = [okCount + " 个盘"];
            if (totalText) metaBits.push("合计 " + totalText);
            const rootLines = roots.length
                ? '<ul class="session-roots">' +
                  roots
                      .map((r, rIdx) => {
                          if (r.skipped) {
                              const reason = esc(skipReasonText(r.skip_reason));
                              return (
                                  '<li class="session-root-row is-skipped">' +
                                  '<span class="root-ic">' + esc(rootLabel(r.root) || "?") + "</span>" +
                                  '<span class="session-root-name">' + esc(rootLabel(r.root) || "?") + "</span>" +
                                  // F17：跳过原因 tooltip（红线 #7 SKIP_REASON_TEXT；文案可见+悬停提示）
                                  '<span class="tag tag-skip" title="' + reason + '">跳过</span>' +
                                  '<span class="skip-reason" title="' + reason + '" aria-label="' + reason + '">' +
                                  reason + "</span></li>"
                              );
                          }
                          // P12·W2.4：每盘行尾「对比此快照」一键入口（U3.3 迁移到
                          // 快照页：点击=预填 state.compare + 跳 #/compare——§6.4 跨页形态）
                          // 阶段C（C-3）：追加「删除」按钮（单盘删除，D1 主入口）
                          // P6（D6-2）：正文只留「盘符 · 大小」，文件名移入「详情」
                          const cmpBtn = r.snapshot_path
                              ? '<button class="btn btn-sm act-cmp-snap" data-baseline="' + esc(r.snapshot_path) +
                                '" data-root="' + esc(r.root || "") + '" title="以该盘这份快照为对比基准，打开空间对比页">对比此快照</button>'
                              : "";
                          const delBtn = r.snapshot_path || r.root
                              ? '<button class="btn btn-sm btn-ghost btn-danger-ghost act-del-snap" data-session="' + esc(s.session_id || "") +
                                '" data-root="' + esc(r.root || "") + '" title="删除该盘快照（其他盘保留）">删除</button>'
                              : "";
                          return (
                              '<li class="session-root-row">' +
                              '<span class="root-ic' + (rIdx > 0 ? " alt" : "") + '">' + esc(rootLabel(r.root) || "?") + "</span>" +
                              '<span class="session-root-name">' + esc(rootLabel(r.root) || "?") + "</span>" +
                              '<span class="session-root-meta">' + esc(fmtSnapSize((s.total_by_root || {})[r.root])) + "</span>" +
                              cmpBtn + delBtn + "</li>"
                          );
                      })
                      .join("") +
                  "</ul>"
                : '<div class="session-sub">该会话没有快照记录</div>';
            const sid = s.session_id || "";
            const checked = sid && selectedSessions.has(sid);
            return (
                '<li class="session-item' + (checked ? " is-sel" : "") + '">' +
                '<div class="session-head">' +
                '<label class="snap-check" title="选择该会话（可批量删除；「跳过」型空会话也可勾选）">' +
                '<input type="checkbox" class="act-sel-session" data-session="' + esc(sid) + '"' +
                (checked ? " checked" : "") + ' aria-label="选择会话"></label>' +
                '<span class="session-title">' + ICONS.clock +
                esc(formatCreatedAt(s.created_at || s.session_id)) + "</span>" +
                '<span class="session-tags">' +
                (s.auto ? '<span class="tag tag-auto">自动</span>' : '<span class="tag tag-manual">手动</span>') +
                '<span class="session-meta">' + esc(metaBits.join(" · ")) + "</span></span>" +
                '<button class="btn btn-sm btn-ghost btn-danger-ghost act-del-session" data-session="' + esc(s.session_id || "") +
                '" title="删除整个会话（全部盘快照与清单）">删除整会话</button>' +
                "</div>" +
                rootLines +
                sessionDetailHtml(s, roots) +
                "</li>"
            );
        })
        .join("");
    syncBatchBar();
}

/* P5（D5-2）：原「基线 datalist 填充」——P5 起对比页的对比基准改为 <select>
   （#compare-baseline），选项由 compare.js 的 rebuildBaselineOptions 构建
   （在那里做 owner 根/自动手动/「最近一份」标注，单一实现）。
   本函数保留为**兼容空操作**：`#baseline-suggest` 已随 D5-2 从 DOM 移除，
   快照刷新时本函数自然返回 0，不再触碰任何 DOM（调用点保持零改动，
   避免 snapshots.js 反向依赖 compare.js 形成 import 环）。 */
export function rebuildBaselineSuggest(sessions) {
    const list = $("baseline-suggest");
    if (!list) return 0;
    list.innerHTML = "";
    let n = 0;
    sessions.forEach((s) => {
        Object.values(s.roots || {}).forEach((r) => {
            if (r.snapshot_path) {
                const opt = document.createElement("option");
                opt.value = r.snapshot_path;
                list.appendChild(opt);
                n += 1;
            }
        });
    });
    return n;
}

/* 阶段C（C-2/C-3）：调用删除 API（单盘/整会话）；返回 {ok, data} 或抛错。 */
async function deleteSnapshot(sessionId, root) {
    const payload = { session_id: sessionId };
    if (root) payload.root = root;
    const data = await postJson("/api/snapshot/delete", payload);
    return data;
}

function rootLabel(root) {
    return String(root || "").replace(/\\+$/, "");
}

/* ================= 页面接线（每次挂载新 DOM 重绑） ================= */

function prefillAndGoCompare(baseline, root, target) {
    APP_STATE.compare.baseline = baseline || "";
    // ⚠️ 注记：§3.2 compare 形状之外附加 root 键（U3.4 消费「目标=同盘符最新快照」需要根）
    APP_STATE.compare.root = root || "";
    APP_STATE.compare.target = target || findLatestForRoot(sessionsCache, root || "");
    // 2026-09-13：趋势卡及其缓存已随快照页改版移除——跳转后由对比页自行发起对比
    APP_STATE.compare.result = null;
    location.hash = "#/compare";
}

export function findLatestForRoot(sessions, root) {
    for (const s of sessions) { // 时间倒序：首个命中即该盘最新
        const entry = Object.values(s.roots || {}).find((r) => r && r.root === root && !r.skipped && r.snapshot_path);
        if (entry) return entry.snapshot_path;
    }
    return "";
}

/* 阶段C（C-3）：删除确认 → API → 刷新 + 清趋势缓存。root 空 = 整会话。 */
async function doDeleteSnapshot(sessionId, root) {
    if (!sessionId) return;
    const isWhole = !root;
    const ok = await confirmDialog({
        title: isWhole ? "删除整个会话？" : "删除该盘快照？",
        text: isWhole
            ? "将删除该会话全部盘的快照文件与清单。此操作不可撤销，确认继续？"
            : "将删除该盘快照文件并从会话清单移除（其他盘保留）。此操作不可撤销，确认继续？",
        okLabel: "删除",
        okClass: "btn-danger",
    });
    if (!ok) return;
    try {
        const data = await deleteSnapshot(sessionId, root);
        if (data && (data.deleted || []).length) {
            toast("已删除 " + data.deleted.length + " 份快照" + (data.already && data.already.length ? "（" + data.already.length + " 份已不存在）" : ""), "success");
        } else if (data && (data.already || []).length) {
            toast("快照已不存在（幂等），已清理清单", "warn");
        } else if (data && (data.failed || []).length) {
            toast("删除部分失败：" + data.failed.map((f) => f.error).join("；"), "error");
        }
        await refreshSnapshots(); // 删除成功后刷新列表（已删项不再出现）
    } catch (e) {
        toast((e && e.message) || "删除失败", "error");
    }
}

function bindSnapshotsPage() {
    const createBtn = $("btn-create-snapshot");
    if (createBtn) createBtn.addEventListener("click", () => { if (snapActions.create) snapActions.create(false); });
    const undoBtn = $("btn-undo-save");
    if (undoBtn) undoBtn.addEventListener("click", () => { if (snapActions.undo) snapActions.undo(); });
    // 逐盘「对比此快照」→ 预填 + 跳转（§6.4 跨页形态；U3.4 消费自动对比）
    const list = $("snapshot-list");
    if (list) list.addEventListener("click", (ev) => {
        const cmpBtn = ev.target.closest(".act-cmp-snap");
        if (cmpBtn) {
            prefillAndGoCompare(
                cmpBtn.getAttribute("data-baseline") || "",
                cmpBtn.getAttribute("data-root") || "",
                ""
            );
            return;
        }
        // 阶段C（C-3）：单盘删除（确认弹窗 → API → 刷新 + 清趋势缓存）
        const delBtn = ev.target.closest(".act-del-snap");
        if (delBtn) {
            doDeleteSnapshot(
                delBtn.getAttribute("data-session") || "",
                delBtn.getAttribute("data-root") || ""
            );
            return;
        }
        // 阶段C（C-3）：整会话删除
        const delSessionBtn = ev.target.closest(".act-del-session");
        if (delSessionBtn) {
            doDeleteSnapshot(delSessionBtn.getAttribute("data-session") || "", "");
        }
    });
    // 会话勾选（委托：复选框在列表重渲染后重建，故走 change 委托）
    if (list) list.addEventListener("change", (ev) => {
        const cb = ev.target.closest(".act-sel-session");
        if (!cb) return;
        const sid = cb.getAttribute("data-session") || "";
        if (!sid) return;
        if (cb.checked) selectedSessions.add(sid); else selectedSessions.delete(sid);
        cb.closest(".session-item")?.classList.toggle("is-sel", cb.checked);
        syncBatchBar();
    });
    // 筛选工具条：盘符 / 类型 / 关键词（即时重渲染）
    const onFilter = () => applyFilterChange();
    $("snap-filter-root")?.addEventListener("change", (ev) => { snapFilter.root = ev.target.value; onFilter(); });
    $("snap-filter-type")?.addEventListener("change", (ev) => { snapFilter.type = ev.target.value; onFilter(); });
    $("snap-filter-kw")?.addEventListener("input", (ev) => { snapFilter.kw = ev.target.value; onFilter(); });
    // 2026-09-13：快照日历（选日筛选 / 翻月 / 回本月 / 清除日期筛选）
    const cal = $("snapshot-calendar");
    if (cal) cal.addEventListener("click", onCalendarClick);
    /* 2026-09-13 第二轮：空会话隐藏提示里的「清理」按钮（提示条 HTML 每次渲染重建 →
       委托到列表容器上，挂载期只绑一次） */
    const listWrap = document.querySelector(".snapshots-list-wrap");
    if (listWrap) listWrap.addEventListener("click", (ev) => {
        if (ev.target.closest("#btn-clean-hidden")) cleanHiddenSessions();
    });
    /* 2026-09-13 第三轮：左栏「最近快照」条目 = 与日历格同语义（data-cal-day 走同一委托） */
    const recent = $("snapshot-recent");
    if (recent) recent.addEventListener("click", onCalendarClick);
    // 全选（当前筛选结果口径）
    $("snap-check-all")?.addEventListener("change", (ev) => {
        const on = !!ev.target.checked;
        filteredSessions().forEach((s) => { if (s.session_id) { if (on) selectedSessions.add(s.session_id); else selectedSessions.delete(s.session_id); } });
        renderSnapshotList(sessionsCache);
        syncBatchBar();
    });
    // 批量删除：确认 → 逐会话调既有删除 API → 汇总反馈
    $("snap-btn-batch-del")?.addEventListener("click", doBatchDelete);
}

/* 批量删除（2026-09-13 用户反馈新增）：复用 confirm-dialog 与单会话删除 API，
   逐会话删除并汇总成功/失败；清空选择并刷新列表。 */
async function doBatchDelete() {
    const ids = Array.from(selectedSessions);
    if (!ids.length) return;
    const ok = await confirmDialog({
        title: "批量删除 " + ids.length + " 个会话？",
        text: "将删除所选会话的全部盘快照文件与清单。此操作不可撤销，确认继续？",
        okLabel: "全部删除",
        okClass: "btn-danger",
    });
    if (!ok) return;
    let okCount = 0, failCount = 0;
    for (const sid of ids) {
        try {
            await deleteSnapshot(sid, "");
            okCount += 1;
        } catch (e) {
            failCount += 1;
        }
    }
    selectedSessions.clear();
    if (!failCount) toast("已删除 " + okCount + " 个会话", "success");
    else toast("删除完成：" + okCount + " 个成功，" + failCount + " 个失败", failCount === ids.length ? "error" : "warn");
    await refreshSnapshots();
}

/* ============================================================
   U2.1：页面契约（U3.3 填充；详见文件头注记）
   ============================================================ */

const SNAPSHOTS_PAGE_HTML =
    '<section class="page page-snapshots" data-page="snapshots">' +
    '<header class="page-head page-head-row">' +
    '<div class="page-head-titles">' +
    '<h1 class="page-title" data-page-title>快照管理</h1>' +
    '<p class="page-sub">创建快照 · 撤销最近保存 · 筛选与批量管理全部会话（对比与趋势请前往「对比」页）</p>' +
    "</div>" +
    '<div class="page-head-actions">' +
    '<button id="btn-create-snapshot" class="btn btn-success" disabled title="暂无全量扫描结果，请先完成全量扫描并保存">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>' +
    "创建快照</button>" +
    '<button id="btn-undo-save" class="btn btn-sm" disabled title="删除最近一次保存的快照文件与清单（无快照时不可用）">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2-9.3L3 7"/></svg>' +
    "撤销最近保存</button>" +
    "</div></header>" +
    /* 2026-09-13 用户实测反馈：趋势卡区（较昨日/较上周）与对比页重复，移除；
       原位置改为「筛选 + 批量管理」工具条（盘符/类型/关键词 + 全选/批量删除）。
       2026-09-13 新增：日历卡（月历热力图——某天有没有快照 / 几个，点日期筛选列表）。
       2026-09-13 第二轮排版优化（用户实测「显示会话的地方太小了」）：
       1366×768 实测日历独占 308px 高、列表内滚区只剩 153px（约 1 行）——
       现改为**左右两栏**：日历收成 336px 左侧日期栏（格子变方、更紧凑），
       列表占满其余宽度与全部剩余高度（实测列表高度 153px → 约 500px）。 */
    '<div class="snap-main">' +
    '<div class="snap-rail">' +
    '<div class="snap-calendar card" id="snapshot-calendar" aria-label="快照日历（每天有无快照与份数）"></div>' +
    /* 2026-09-13 第三轮：日历下方接「最近快照」快捷列表，填掉左栏空白 */
    '<div class="snap-recent card" id="snapshot-recent" aria-label="最近快照（点击按该天筛选）"></div>' +
    "</div>" +
    '<div class="snap-list-col">' +
    '<div class="snap-filter-bar" role="group" aria-label="会话筛选与批量管理">' +
    '<select id="snap-filter-root" aria-label="按盘符筛选" title="按会话包含的盘符筛选">' +
    '<option value="all">全部盘符</option></select>' +
    '<select id="snap-filter-type" aria-label="按类型筛选" title="按保存方式筛选">' +
    '<option value="all">全部类型</option><option value="auto">自动</option><option value="manual">手动</option></select>' +
    '<input id="snap-filter-kw" type="search" placeholder="筛选时间 / 会话 ID" aria-label="关键词筛选">' +
    '<label class="snap-check-all-wrap" title="选中当前筛选结果中的全部会话">' +
    '<input type="checkbox" id="snap-check-all" aria-label="全选当前筛选结果">全选</label>' +
    '<button id="snap-btn-batch-del" class="btn btn-sm btn-danger" disabled>批量删除</button>' +
    "</div>" +
    // P6（D6-1/变更集2）：会话列表区统一为卡片原语（.card：同一底色/边框/圆角/阴影），
    // 卡头常驻「数量 + 排序口径」，避免列表与卡片两种视觉语言并存
    '<div class="snapshots-list-wrap card">' +
    '<div class="snapshots-list-head"><span id="snapshots-list-count">共 0 个快照会话</span>' +
    // 2026-09-13 第二轮：空会话（全盘 skipped / 保存了但无内容）隐藏提示 + 清理入口
    '<span id="snap-hidden-note" class="snap-hidden-note" hidden></span>' +
    '<span class="snapshots-list-hint">按时间倒序 · 每份快照可对比或删除</span></div>' +
    '<div class="snapshots-list-scroll"><ul id="snapshot-list" class="snapshot-list" aria-label="快照会话列表"></ul></div>' +
    "</div>" +
    "</div>" +
    "</div>" +
    "</section>";

export function renderSnapshots() {
    const el = document.createElement("div");
    el.innerHTML = SNAPSHOTS_PAGE_HTML;
    return el.firstElementChild;
}

export function mountSnapshots() {
    applySnapshotsView();   // 回灌（列表/趋势卡/撤销灰置；缓存优先，不重发 compare）
    bindSnapshotsPage();    // 页头/列表/趋势卡接线（新 DOM 重绑）
    ensureScanListener();   // pds:scan → 创建快照可用性（模块级一次）
}

export function unmountSnapshots() {
    /* 无 rAF/轮询；pending 的 compare 回包由 DOM 空守卫自吞 */
}
