/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/snapshots.js（U2.0 迁入，U3.3 快照管理页）
   - 布局（§3.3/§3.5）：页头 64px（创建快照 F15 + 撤销最近保存 F16）→
     趋势区 128px（趋势卡×2 N07）→ 会话分组列表（F17，flex:1 面板内滚）；
   - [N07] 趋势卡（较昨日/较上周）：基线=同盘符快照中时间 ≤24h（较昨日）/
     (24h,7d]（较上周）最近的一份（D7：前端就近选基线，复用 /api/compare，无新后端）；
     目标=该盘最新快照；无合适基线 → 「暂无对比基线」；点击卡 → #/compare 并预填
     （APP_STATE.compare，§6.4 跨页传递）；
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

import { $, api, postJson, esc, signedBytes } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { setStatus } from "../components/statusbar.js";
import { skipReasonText } from "../labels.js";
import { renderSnapshotMini } from "../components/snapshot-mini.js"; // U2.4：N06 迷你条目

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
    window.addEventListener("pds:scan", () => syncCreateAvailability());
}

/* ================= 刷新与回灌（切页不丢：mount 时从缓存回灌，不重发） ================= */

export async function refreshSnapshots() {
    setStatus("snapshot-status", "busy", "正在加载历史快照…");
    try {
        const data = await api("/api/snapshots");
        sessionsCache = data.sessions || [];
        APP_STATE.snapshots.sessions = sessionsCache; // U3.3：snapshots 命名空间启用
        syncUndoState();
        renderSnapshotList(sessionsCache);
        renderSnapshotMini(sessionsCache); // U2.4：迷你卡最近一份
        rebuildBaselineSuggest(sessionsCache);
        renderTrendCards(sessionsCache);
        setStatus("snapshot-status", "", "共 " + sessionsCache.length + " 个快照会话");
        syncListCount();
    } catch (e) {
        setStatus("snapshot-status", "err", e.message);
    }
}

/* U2.1：路由返回时的视图恢复（快照列表/基线下拉/撤销灰置/状态行/趋势卡从缓存回灌） */
export function applySnapshotsView() {
    syncUndoState();
    renderSnapshotList(sessionsCache);
    renderSnapshotMini(sessionsCache); // U2.4：回挂回灌迷你条目
    rebuildBaselineSuggest(sessionsCache);
    renderTrendCards(sessionsCache);
    setStatus("snapshot-status", "", "共 " + sessionsCache.length + " 个快照会话");
    syncListCount();
    syncCreateAvailability(); // U3.3：页头「创建快照」可用性（扫描状态镜像）
}

function syncUndoState() {
    // P12·W2.5（D）：无会话时撤销入口灰置
    const undo = $("btn-undo-save");
    if (undo) undo.disabled = !sessionsCache.length;
}

function syncListCount() {
    const el = $("snapshots-list-count");
    if (el) el.textContent = "共 " + sessionsCache.length + " 个快照会话";
}

/* ================= 会话列表（F17；renderSnapshotList 语义迁移） ================= */

export function renderSnapshotList(sessions) {
    const list = $("snapshot-list");
    if (!list) return; // U2.1：子页面时快照卡不在 DOM；U3.3 起列表随快照页渲染
    if (!sessions.length) {
        // 定稿 6.5：快照页无快照（三处空态之一）
        list.innerHTML =
            '<li><div class="empty-state">' +
            ICONS.empty +
            "<b>还没有快照</b>" +
            "<p>全量扫描后保存一份，变化趋势从这里开始记录。</p>" +
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
                              const reason = esc(skipReasonText(r.skip_reason));
                              return (
                                  "<li>" + ICONS.drive +
                                  '<span>' + esc(r.root || "?") + '</span>' +
                                  // F17：跳过原因 tooltip（红线 #7 SKIP_REASON_TEXT；文案可见+悬停提示）
                                  '<span class="tag tag-skip" title="' + reason + '">跳过</span>' +
                                  '<span class="skip-reason" title="' + reason + '" aria-label="' + reason + '">' +
                                  reason + "</span></li>"
                              );
                          }
                          // P12·W2.4：每盘子行尾「对比此快照」一键入口（U3.3 迁移到
                          // 快照页：点击=预填 state.compare + 跳 #/compare——§6.4 跨页形态）
                          const cmpBtn = r.snapshot_path
                              ? '<button class="btn btn-sm act-cmp-snap" data-baseline="' + esc(r.snapshot_path) +
                                '" data-root="' + esc(r.root || "") + '">对比此快照</button>'
                              : "";
                          return (
                              "<li>" + ICONS.drive +
                              "<span>" + esc(r.root || "?") + " →</span>" +
                              "<code>" + esc(r.snapshot || "缺快照") + "</code>" +
                              cmpBtn + "</li>"
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

export function rebuildBaselineSuggest(sessions) {
    const list = $("baseline-suggest");
    if (!list) return;
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

/* ================= U3.3：趋势卡×2（N07；sparkline 降级为差值卡） =================
   ⚠️ 字段核对结论：/api/snapshots 会话数据无逐次总量 → 无 sparkline 数据源，
   按手册 U3.3 预案降级为「两快照对比差值卡」（无折线，保留 ▲/▼ 与百分比），
   L3-5（sparkline 800ms/终点脉冲 2s）留待后端补总量字段后启用（记偏差注记）。

   基线口径（D7/N07 展开）：
   - 较昨日（day）：同盘符快照 0 < Δt ≤ 24h 最近一份；
   - 较上周（week）：同盘符快照 24h < Δt ≤ 7d 最近一份（排除 ≤24h——否则与
     「较昨日」同基线、两卡信息重复；按「周变化」语义取窗口内最近一份）；
   - 目标＝该盘最新快照；多盘时取「最新目标且窗口内有基线」的第一个盘
     （会话时间倒序确定性扫描）；无合适基线 → 「暂无对比基线」。

   Δ 计算：/api/compare（{root, baseline}）；结果入模块级缓存（键=槽:根:基线），
   路由往返/列表刷新不回源（applySnapshotsView 只渲染缓存，不重发）。 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const TREND_SLOTS = [
    { key: "day", label: "较昨日", minMs: 0, windowMs: DAY_MS },
    { key: "week", label: "较上周", minMs: DAY_MS, windowMs: WEEK_MS },
];

const trendCache = new Map(); // key "slotKey:root:baseline" → {status:"ok",...}|{status:"err",error}
const trendInflight = new Set(); // 防止并发渲染双发 /api/compare（缓存未落前重复渲染）

function trendCacheKey(slot, trend) {
    return slot.key + ":" + trend.root + ":" + trend.baseline;
}

function rootLabel(root) {
    return String(root || "").replace(/\\+$/, "");
}

function slotTimeText(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return (
        d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
        p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
    ); // 本地 YYYY-MM-DD HH:MM:SS（确定性格式，不依赖 locale）
}

/* 收集所有可对比条目（root+snapshot_path+时间），时间降序 */
function collectDriveEntries(sessions) {
    const out = [];
    for (const s of sessions) {
        const t = Date.parse(String(s.created_at || ""));
        if (!t) continue;
        for (const r of Object.values(s.roots || {})) {
            if (!r || r.skipped || !r.root || !r.snapshot_path) continue;
            out.push({ root: r.root, snapPath: r.snapshot_path, createdMs: t });
        }
    }
    out.sort((a, b) => b.createdMs - a.createdMs || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    return out;
}

/* 按槽窗口选（根, 基线, 目标）；无合适基线返回 null */
export function pickTrendForSlot(sessions, slot) {
    const entries = collectDriveEntries(sessions);
    if (!entries.length) return null;
    const byRoot = new Map();
    for (const e of entries) {
        if (!byRoot.has(e.root)) byRoot.set(e.root, []);
        byRoot.get(e.root).push(e);
    }
    for (const e of entries) { // 时间倒序：每盘首次出现即该盘最新目标（确定性取首个合格盘）
        const list = byRoot.get(e.root);
        const target = list[0];
        for (let i = 1; i < list.length; i++) {
            const diff = target.createdMs - list[i].createdMs;
            if (diff > slot.minMs && diff <= slot.windowMs) {
                return {
                    root: target.root,
                    baseline: list[i].snapPath,
                    target: target.snapPath,
                    baselineAtText: slotTimeText(list[i].createdMs),
                    targetAtText: slotTimeText(target.createdMs),
                };
            }
            if (diff > slot.windowMs) break; // 更早的只会更远
        }
    }
    return null;
}

function trendCardEmpty(slot) {
    return (
        '<div class="trend-card is-empty" data-slot="' + slot.key + '">' +
        '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span></span>" +
        '<span class="trend-empty">暂无对比基线</span>' +
        "</div>"
    );
}

function trendCardPending(slot, trend) {
    return (
        '<button class="trend-card" type="button" data-slot="' + slot.key + '"' +
        ' data-root="' + esc(trend.root) + '" data-baseline="' + esc(trend.baseline) + '"' +
        ' data-target="' + esc(trend.target) + '" title="点击跳转对比页（基线已预填）">' +
        '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span>" +
        '<span class="trend-root">' + esc(rootLabel(trend.root)) + "</span></span>" +
        '<span class="trend-pending">正在计算对比…</span>' +
        '<span class="trend-sub">基线 ' + esc(trend.baselineAtText) + " → 最新 " + esc(trend.targetAtText) + "</span>" +
        "</button>"
    );
}

function trendCardBody(slot, trend, cached) {
    if (cached.status === "err") {
        return (
            '<button class="trend-card" type="button" data-slot="' + slot.key + '"' +
            ' data-root="' + esc(trend.root) + '" data-baseline="' + esc(trend.baseline) + '"' +
            ' data-target="' + esc(trend.target) + '" title="点击跳转对比页（基线已预填）">' +
            '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span>" +
            '<span class="trend-root">' + esc(rootLabel(trend.root)) + "</span></span>" +
            '<span class="trend-err" title="' + esc(cached.error || "对比失败") + '">对比失败：' +
            esc(cached.error || "") + "</span></button>"
        );
    }
    const d = Number(cached.delta) || 0;
    const cls = d > 0 ? "grow" : d < 0 ? "shrink" : "flat";
    const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "±"; // §3.4：不得仅靠颜色（色盲冗余）
    const pctText = (Number(cached.pct) > 0 ? "+" : "") + Number(cached.pct).toFixed(2) + "%";
    return (
        '<button class="trend-card" type="button" data-slot="' + slot.key + '"' +
        ' data-root="' + esc(trend.root) + '" data-baseline="' + esc(trend.baseline) + '"' +
        ' data-target="' + esc(trend.target) + '" title="点击跳转对比页（基线已预填）">' +
        '<span class="trend-label-line"><span class="trend-label">' + esc(slot.label) + "</span>" +
        '<span class="trend-root">' + esc(rootLabel(trend.root)) + "</span></span>" +
        '<span class="trend-main">' +
        '<span class="trend-delta ' + cls + '">' + arrow + " " + esc(signedBytes(d)) + "</span>" +
        '<span class="trend-pct">' + esc(pctText) + "</span></span>" +
        '<span class="trend-sub">基线 ' + esc(trend.baselineAtText) + " → 最新 " + esc(trend.targetAtText) + "</span>" +
        "</button>"
    );
}

async function fetchTrendCompare(slot, trend, key) {
    try {
        const data = await postJson("/api/compare", { root: trend.root, baseline: trend.baseline });
        const r = (data && data.report) || {};
        const totalBaseline = Number(r.total_baseline) || 0;
        const delta = Number(r.delta_total) || 0;
        trendCache.set(key, {
            status: "ok",
            root: trend.root,
            baseline: trend.baseline,
            target: trend.target,
            totalBaseline: totalBaseline,
            totalCurrent: Number(r.total_current) || 0,
            delta: delta,
            pct: totalBaseline ? (delta / totalBaseline) * 100 : 0,
        });
    } catch (e) {
        trendCache.set(key, { status: "err", error: (e && e.message) || "对比失败" });
    } finally {
        trendInflight.delete(key);
    }
    applySnapshotsView(); // 结果到达后重渲染（列表/趋势卡均从缓存回灌，不重发）
}

function renderTrendCards(sessions) {
    const row = $("trend-row");
    if (!row) return; // 快照页未挂载
    const slots = TREND_SLOTS.map((slot) => ({ slot, trend: pickTrendForSlot(sessions, slot) }));
    row.innerHTML = slots
        .map(({ slot, trend }) => {
            if (!trend) return trendCardEmpty(slot);
            const cached = trendCache.get(trendCacheKey(slot, trend));
            if (cached) return trendCardBody(slot, trend, cached);
            return trendCardPending(slot, trend);
        })
        .join("");
    slots.forEach(({ slot, trend }) => {
        if (!trend) return;
        const key = trendCacheKey(slot, trend);
        if (trendCache.has(key) || trendInflight.has(key)) return;
        trendInflight.add(key);
        fetchTrendCompare(slot, trend, key); // 未缓存且在途无 → 各卡恰一次
    });
}

/* ================= 页面接线（每次挂载新 DOM 重绑） ================= */

function prefillAndGoCompare(baseline, root, target) {
    APP_STATE.compare.baseline = baseline || "";
    // ⚠️ 注记：§3.2 compare 形状之外附加 root 键（U3.4 消费「目标=同盘符最新快照」需要根）
    APP_STATE.compare.root = root || "";
    APP_STATE.compare.target = target || findLatestForRoot(sessionsCache, root || "");
    location.hash = "#/compare";
}

function findLatestForRoot(sessions, root) {
    for (const s of sessions) { // 时间倒序：首个命中即该盘最新
        const entry = Object.values(s.roots || {}).find((r) => r && r.root === root && !r.skipped && r.snapshot_path);
        if (entry) return entry.snapshot_path;
    }
    return "";
}

function bindSnapshotsPage() {
    const createBtn = $("btn-create-snapshot");
    if (createBtn) createBtn.addEventListener("click", () => { if (snapActions.create) snapActions.create(false); });
    const undoBtn = $("btn-undo-save");
    if (undoBtn) undoBtn.addEventListener("click", () => { if (snapActions.undo) snapActions.undo(); });
    // 逐盘「对比此快照」→ 预填 + 跳转（§6.4 跨页形态；U3.4 消费自动对比）
    const list = $("snapshot-list");
    if (list) list.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".act-cmp-snap");
        if (!btn) return;
        prefillAndGoCompare(
            btn.getAttribute("data-baseline") || "",
            btn.getAttribute("data-root") || "",
            ""
        );
    });
    // 趋势卡点击 → 预填 + 跳转（N07：点击卡片跳 #/compare 并自动填基线）
    const row = $("trend-row");
    if (row) row.addEventListener("click", (ev) => {
        const card = ev.target.closest(".trend-card[data-baseline]");
        if (!card) return;
        prefillAndGoCompare(
            card.getAttribute("data-baseline") || "",
            card.getAttribute("data-root") || "",
            card.getAttribute("data-target") || ""
        );
    });
}

/* ============================================================
   U2.1：页面契约（U3.3 填充；详见文件头注记）
   ============================================================ */

const SNAPSHOTS_PAGE_HTML =
    '<section class="page page-snapshots" data-page="snapshots">' +
    '<header class="page-head page-head-row">' +
    '<div class="page-head-titles">' +
    '<h1 class="page-title" data-page-title>快照管理</h1>' +
    '<p class="page-sub">创建快照 · 撤销最近保存 · 较昨日/较上周变化趋势与全部会话</p>' +
    "</div>" +
    '<div class="page-head-actions">' +
    '<button id="btn-create-snapshot" class="btn btn-success" disabled title="暂无全量扫描结果，请先完成全量扫描并保存">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>' +
    "创建快照</button>" +
    '<button id="btn-undo-save" class="btn btn-sm" disabled title="删除最近一次保存的快照文件与清单（无快照时不可用）">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2-9.3L3 7"/></svg>' +
    "撤销最近保存</button>" +
    "</div></header>" +
    '<div class="trend-row" id="trend-row" role="group" aria-label="变化趋势（较昨日/较上周）"></div>' +
    '<div class="snapshots-list-wrap">' +
    '<div class="snapshots-list-head"><span id="snapshots-list-count">共 0 个快照会话</span></div>' +
    '<div class="snapshots-list-scroll"><ul id="snapshot-list" class="snapshot-list" aria-label="快照会话列表"></ul></div>' +
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
