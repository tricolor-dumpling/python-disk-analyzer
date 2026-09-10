/* ============================================================
   UI 2.0（SpaceLens Pro）· pages/compare.js = #/compare 对比工作台（U3.4 全量填充）
   - 布局（§3.3/§3.5）：页头 64px（标题 + 基线 datalist + 目标只读 + 深度选择器 +
     隐藏零变化开关 + 开始对比）→ 面包屑（下钻时才显示）→ 摘要 3 卡 96px
     （总变化/最大增长/可释放，count-up L1-4）→ 红绿发散图 240px
     （L3-6：中轴基线、增长条向左红 --up、缩减条向右绿 --down、中轴生长 500ms
     --dur-diverge、徽标 pop-in scale .8→1 ease-spring、▲/▼ 冗余）→ 表格 flex:1
     面板内滚（变化/增速/路径/操作 F19 定位+复制路径；行 stagger L1-2）；
   - 流程（定稿 6.4）：趋势卡/迷你卡/直达三入口 → APP_STATE.compare 预填
     （§6.4 跨页形态；root 为 §3.2 之外附加键 U3.3 已记）→ 自动填基线
     （默认=最近一份）→ 目标=同盘符最新快照（只读展示）→ 骨架屏 → 摘要/图表/表格；
   - ⚠️ 数据源口径核对（app.py api_compare 执行核对）：/api/compare 的「当前」侧
     数据 = fullscan.result(root) 缓存 or SDK 直扫（非快照文件）——「目标=同盘符
     最新快照」为展示口径（标识性文案），对比目标实为当前磁盘状态；零后端改动，
     见执行记录偏差注记；
   - P4（问题 5：深度选择 + 聚合 + 下钻）：页头新增 #compare-depth
     （叶子（默认，= 修复前口径，不发 depth）/ 1..5 层）——depth 由**后端**在
     排序/截断之前聚合（D4-1，前端不做聚合：那只能处理已被 top-100 截断的叶子行，
     上层目录增量会被严重低估）；结果行点击 = 页内下钻（以该目录为新根重新对比，
     不发「跳工作台浏览」），面包屑 #compare-crumb 逐级返回（D4-6）；
   - P4（问题 6：零增量）：页头新增 #compare-hide-zero（默认开）→ 请求带
     drop_zero=true + order_by="abs"——**后端在切片前过滤**零行并按 |delta| 排序，
     使负增量（可释放空间）不再被零行/正增量挤出榜单；空态判据改用过滤后的行集合，
     文案区分「确实无变化」与「已隐藏 N 条零变化」（D4-4）；
   - 摘要口径（D4-5）：三卡取后端 additive 字段（delta_total / max_growth /
     max_release，全量聚合行口径，未按 100 条切片），旧后端/桩态无该字段时回退
     为按 rows 现算（u34 桩态断言保持）；
   - 结果缓存：APP_STATE.compare.result（{root,baseline,depth,hideZero,report,at}）
     ——路由往返从缓存回灌不重发（缓存键含 depth + 隐藏零变化开关：口径不同必须重发）；
     快照页趋势卡已完成同基线计算时结果共享（snapshots.js prefillAndGoCompare 写入），
     落地即渲染不回源；
   - 旧工作台「历史对比」卡本项迁整页并移除（主页仅留「最近对比」迷你卡）；
     compareSnapshots 保持 DOM 无关（页面未挂载时仅记账/圆点，供 u31 等
     跨页触发路径）；
   - 既有保留：W2.13 异机确认（machine_mismatch → confirmDialog → 二次提交带
     allow_other_machine）、W2.4 扫描中 409（toast + 按钮禁用 + pollFullscan 完成
     恢复）、act-copy-cmp 复制路径、红线 #5 esc 全量转义、#11 对比行零请求。
   ============================================================ */

import { $, api, postJson, humanBytes, signedBytes, esc } from "../api.js";
import { ICONS } from "../icons.js";
import { APP_STATE } from "../state.js";
import { setStatus } from "../components/statusbar.js";
import { toast } from "../components/toast.js";
import { confirmDialog } from "../components/modals.js";
import { copyPath, openInExplorer, getCurrentRoot } from "./workspace.js";
import { getSessionsCache, rebuildBaselineSuggest } from "./snapshots.js";
import { pollFullscan } from "../components/scan.js";
import { renderCompareMini } from "../components/snapshot-mini.js"; // U2.4：最近对比迷你卡
import { markNavDot } from "../components/nav-dots.js"; // U3.1：N13 圆点提醒（对比完成）
import { countUp, staggerIn, motionDur, motionEase, reducedMotion } from "../motion.js";

/* ================= 通用 ================= */

function deltaClass(v) {
    if (v > 0) return "grow";
    if (v < 0) return "shrink";
    return "flat";
}

function arrowOf(v) {
    return v > 0 ? "▲" : v < 0 ? "▼" : "±";
}

function sessionsOf() {
    return Array.isArray(getSessionsCache()) ? getSessionsCache() : [];
}

/* ================= P4：深度 / 零增量 / 下钻 状态（D4-2…D4-6） ================= */

/* 深度选择器取值："" = 叶子（默认，现状口径，不发 depth）；"1".."5" = 聚合到第 N 层 */
function depthValue() {
    const sel = $("compare-depth");
    if (sel) return String(sel.value || "");
    return String(APP_STATE.compare.depth || "");
}

/* 隐藏零变化开关（默认开）：开 = 请求带 drop_zero=true（后端切片前过滤） */
function hideZeroOn() {
    const box = $("compare-hide-zero");
    if (box) return !!box.checked;
    return APP_STATE.compare.hideZero !== false;
}

/* 当前下钻根（"" = 未下钻，对比根 = 基线所属盘） */
function drillRootOf() {
    return String(APP_STATE.compare.drillRoot || "");
}

/* 路径相等（大小写不敏感 + 去尾部分隔符；Windows 盘符口径） */
function samePath(a, b) {
    return String(a || "").replace(/[\\/]+$/, "").toLowerCase() ===
        String(b || "").replace(/[\\/]+$/, "").toLowerCase();
}

/* 面包屑链：baseRoot（对比根）→ … → drill（当前下钻根）；首项 path="" 表示回到未下钻 */
function crumbsFor(baseRoot, drill) {
    const out = [{ label: String(baseRoot || "根目录"), path: "" }];
    const d = String(drill || "").replace(/[\\/]+$/, "");
    if (!d) return out;
    const base = String(baseRoot || "").replace(/[\\/]+$/, "");
    if (base && !d.toLowerCase().startsWith(base.toLowerCase() + "\\")) return out;
    const rest = base ? d.slice(base.length).replace(/^\\+/, "") : d;
    let acc = base;
    for (const part of rest.split("\\").filter(Boolean)) {
        acc = acc ? acc + "\\" + part : part;
        out.push({ label: acc, path: acc });
    }
    return out;
}

/* 空态（D4-4）：判据 = **过滤后**的行集合，文案区分「确实无变化」与「已隐藏 N 条」 */
function emptyStateHtml(r) {
    const hidden = Number(r && r.zero_total) || 0;
    const tip = (hidden > 0 && hideZeroOn())
        ? "<p>已按「隐藏零变化」过滤 " + esc(hidden) + " 条 0 增量条目；关闭该开关可查看完整列表。</p>"
        : "<p>当前结果与基线快照一致，没有找到大小变化的目录。</p>";
    return '<div class="empty-state">' + ICONS.success + "<b>无差异</b>" + tip + "</div>";
}

/* 面包屑渲染（未下钻时整条隐藏，不占高度） */
function renderCrumb() {
    const host = $("compare-crumb");
    if (!host) return;
    const st = APP_STATE.compare;
    const base = ownerRootFor(String(st.baseline || ""), String(st.root || ""));
    const drill = drillRootOf();
    const items = crumbsFor(base, drill);
    host.innerHTML = items
        .map((it, i) => {
            const last = i === items.length - 1;
            return '<button type="button" class="crumb-item' + (last ? " is-current" : "") +
                '" data-crumb-path="' + esc(it.path) + '"' +
                ' title="' + esc(it.path || "未下钻（整个对比根）") + '"' +
                (last ? ' aria-current="page"' : "") + ">" + esc(it.label) + "</button>";
        })
        .join('<span class="crumb-sep" aria-hidden="true">›</span>');
    host.toggleAttribute("hidden", !drill);
}

/* 行点击下钻：以该目录为新根重新对比（后端按新根收窄基线两侧，D4-6） */
function drillInto(path) {
    const p = String(path || "").trim();
    if (!p) return;
    APP_STATE.compare.drillRoot = p;
    renderCrumb();
    compareSnapshots();
}

/* 该盘最新快照（会话时间倒序首个未跳过且带 snapshot_path） */
function latestForRoot(root) {
    const r = String(root || "");
    if (!r) return "";
    for (const s of sessionsOf()) {
        const entry = Object.values(s.roots || {}).find(
            (x) => x && x.root === r && !x.skipped && x.snapshot_path
        );
        if (entry) return entry.snapshot_path;
    }
    return "";
}

/* 基线所属盘（会话内 snapshot_path 精确匹配 = 同盘符口径）；找不到回落 fallbackRoot */
function ownerRootFor(baseline, fallbackRoot) {
    const b = String(baseline || "").trim();
    if (!b) return fallbackRoot || "";
    for (const s of sessionsOf()) {
        for (const x of Object.values(s.roots || {})) {
            if (x && x.snapshot_path === b && x.root) return x.root;
        }
    }
    return fallbackRoot || "";
}

/* 默认基线（定稿「默认最近一份」）：优先当前盘最新快照；
   无则该盘无快照 → 回退最近会话首个可用快照（旧行为）并携带 owner 根 */
function defaultBaseline(root) {
    const latest = latestForRoot(root);
    if (latest) return latest;
    for (const s of sessionsOf()) {
        const ok = Object.values(s.roots || {}).find((x) => x && !x.skipped && x.snapshot_path);
        if (ok) return ok.snapshot_path;
    }
    return "";
}

/* ================= APP_STATE.compare 预填（三入口统一落点） ================= */

/* 从 APP_STATE 预填 + 推导默认；返回 {root,baseline,target} 或 null（无任何快照） */
function ensurePrefill() {
    const st = APP_STATE.compare;
    let root = String(st.root || getCurrentRoot() || "");
    let baseline = String(st.baseline || "").trim();
    if (!baseline) baseline = defaultBaseline(root);
    if (!baseline) {
        st.root = root;
        st.baseline = "";
        st.target = "";
        return null;
    }
    const owner = ownerRootFor(baseline, root);
    if (owner) root = owner;
    const target = String(st.target || "") || latestForRoot(root);
    st.root = root;
    st.baseline = baseline;
    st.target = target;
    return { root: root, baseline: baseline, target: target };
}

/* 表单回显（输入框/目标只读/页头副行根提示） */
function syncForm(sel) {
    const b = $("compare-baseline");
    if (b) b.value = sel ? sel.baseline : String(APP_STATE.compare.baseline || "");
    const t = $("compare-target");
    if (t) t.value = sel ? sel.target : String(APP_STATE.compare.target || "");
    const rl = $("compare-root-line");
    if (rl) rl.textContent = (sel ? sel.root : String(APP_STATE.compare.root || ""))
        ? "基线=最近一份快照 · 目标=同盘符最新快照 · 盘 " +
          String((sel ? sel.root : String(APP_STATE.compare.root || "")) || "?").replace(/\\+$/, "")
        : "基线=最近一份快照 · 目标=同盘符最新快照";
}

/* 结果缓存命中判定（同根同基线 **同口径** → 回灌渲染不重发）
   P4：缓存键并入 depth 与「隐藏零变化」——口径不同必须重发，否则切换深度会
   渲染上一次深度的报告。
   ⚠️ 跨页共享兼容：snapshots.js 趋势卡写入的缓存（prefillAndGoCompare）不带这两个
   键（该文件不在 P4 授权面），此时沿用既有「落地渲染不重发」语义（u34 ⑧b /
   smoke A17·A18 红线）：仅在缓存**带**该键且与当前控件不一致时才判为未命中。 */
function resultCacheMatch(sel) {
    const c = APP_STATE.compare.result;
    if (!c || !c.report) return null;
    if (!sel) return null;
    const wantRoot = drillRootOf() || sel.root;
    if (!samePath(c.root, wantRoot)) return null;
    if (String(c.baseline || "").trim() !== String(sel.baseline || "").trim()) return null;
    if (c.depth !== undefined && String(c.depth == null ? "" : c.depth) !== String(depthValue())) return null;
    if (c.hideZero !== undefined && !!c.hideZero !== hideZeroOn()) return null;
    return c;
}

/* ================= 页面三态（空态/骨架/结果） ================= */

function isPageMounted() {
    return !!$("compare-result");
}

function showEmpty() {
    const empty = $("compare-empty");
    const loading = $("compare-loading");
    const result = $("compare-result");
    if (empty) empty.toggleAttribute("hidden", false);
    if (loading) loading.toggleAttribute("hidden", true);
    if (result) result.toggleAttribute("hidden", true);
}

function showLoading() {
    const empty = $("compare-empty");
    const loading = $("compare-loading");
    const result = $("compare-result");
    if (empty) empty.toggleAttribute("hidden", true);
    if (loading) loading.toggleAttribute("hidden", false);
    if (result) result.toggleAttribute("hidden", true);
    // 阶段B（B-2）：loading 骨架屏附加取消按钮与已用时
    const cancelBtn = $("btn-compare-cancel");
    if (cancelBtn) cancelBtn.classList.remove("hidden");
    const elapsed = $("compare-loading-elapsed");
    if (elapsed) {
        elapsed.hidden = false;
        elapsed.textContent = "已用时 0 秒";
    }
}

function hideLoading() {
    const loading = $("compare-loading");
    if (loading) loading.toggleAttribute("hidden", true);
    const cancelBtn = $("btn-compare-cancel");
    if (cancelBtn) cancelBtn.classList.add("hidden");
    const elapsed = $("compare-loading-elapsed");
    if (elapsed) elapsed.hidden = true;
}

function showResult() {
    const empty = $("compare-empty");
    const loading = $("compare-loading");
    const result = $("compare-result");
    if (empty) empty.toggleAttribute("hidden", true);
    if (loading) loading.toggleAttribute("hidden", true);
    if (result) result.toggleAttribute("hidden", false);
}

/* ================= 对比执行（W2.4/W2.13 语义保留；B-1/B-2 异步化+超时收敛） ================= */

let scanPending = false; // W2.4：409 时保持按钮禁用直到扫描完成（pds:scan 完成分支恢复）
let scanRetries = 0;     // U3.4：409 锁竞争自动重试上限（启动期 浏览/索引 占用为瞬态）

/* ---- 阶段B（B-1/B-2）：对比请求生命周期 ---- */
let compareAbort = null;      // AbortController（30s 超时 + 用户取消共用）
let compareNow = 0;           // 计时器句柄（已用时刷新）
let compareJobTimer = null;   // /api/compare/status 轮询句柄
let compareJobId = null;      // 202 异步任务 job_id
let compareCancelled = false; // B-2：用户/超时取消标志（catch 识别终态）
const COMPARE_TIMEOUT_MS = 30000; // B-2：30s 用户可感知阈值
const COMPARE_STATUS_POLL_MS = 1500; // 202 任务轮询间隔
let cancelEscBound = false; // B-2：Esc 取消的 document 级监听只绑一次（U1.3 纪律）

function stopCompareTimers() {
    if (compareNow) { clearInterval(compareNow); compareNow = 0; }
    if (compareJobTimer) { clearInterval(compareJobTimer); compareJobTimer = 0; }
}

function startElapsedTick() {
    const t0 = Date.now();
    const el = $("compare-loading-elapsed");
    if (el) el.textContent = "已用时 0 秒";
    if (compareNow) clearInterval(compareNow);
    compareNow = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        const e = $("compare-loading-elapsed");
        if (e) e.textContent = "已用时 " + s + " 秒";
    }, 1000);
}

function setCompareBusyText(text) {
    setStatus("compare-status", "busy", text);
}

/* 取消当前对比（Esc/取消按钮/超时共用）：中止 fetch + 停止轮询 + 按钮恢复 */
function cancelCompare(restoreBtn) {
    stopCompareTimers();
    if (compareAbort) {
        try { compareAbort.abort(); } catch (e) { /* ignore */ }
        compareAbort = null;
    }
    compareCancelled = true;
    compareJobId = null;
    const btn = $("btn-compare");
    if (btn && restoreBtn !== false) btn.disabled = false;
}

/* pds:scan 订阅（模块级一次——同 snapshots.js ensureScanListener 模式：
   DOM 空守卫 + 扫描中禁用/完成恢复（W2.4 语义镜像）；锁释放后自动重试一次）
   ⚠️ 重试上限 3：避免持续 409（如 SDK 锁长期被占）造成轮询风暴——超限后转手动 */
let scanSubscribed = false;
function ensureScanListener() {
    if (scanSubscribed) return;
    scanSubscribed = true;
    window.addEventListener("pds:scan", (ev) => {
        const st = ev.detail || {};
        const btn = $("btn-compare");
        if (!btn) return;
        if (st.running) {
            btn.disabled = true; // W2.4：全量扫描中对比不可用
        } else if (scanPending) {
            scanPending = false; // 409 后扫描完成 → 恢复（用户可再次点击）
            btn.disabled = false;
            if (scanRetries < 3) {
                scanRetries += 1;
                compareSnapshots({ autoretry: true }); // 锁释放瞬态 → 自动重试
            }
        }
    });
}

/* 202 → 轮询 /api/compare/status 直到 done/error；返回 report 或抛错 */
function pollCompareJob(jobId, jobRoot, jobBaseline) {
    return new Promise((resolve, reject) => {
        let polls = 0;
        const maxPolls = Math.ceil(COMPARE_TIMEOUT_MS / COMPARE_STATUS_POLL_MS);
        const tick = async () => {
            polls += 1;
            if (polls > maxPolls) {
                reject(new Error("对比超时，可稍后重试"));
                return;
            }
            let data;
            try {
                data = await api("/api/compare/status?job_id=" + encodeURIComponent(jobId));
            } catch (e) {
                reject(e);
                return;
            }
            if (data.status === "done") {
                resolve(data.report);
                return;
            }
            if (data.status === "error") {
                const err = new Error(data.error || "对比失败");
                if (data.code) err.code = data.code;
                reject(err);
                return;
            }
            compareJobTimer = setTimeout(tick, COMPARE_STATUS_POLL_MS);
        };
        compareJobTimer = setTimeout(tick, COMPARE_STATUS_POLL_MS);
        /* 超时兜底（AbortController 45s 硬上限，防轮询僵尸） */
        setTimeout(() => {
            if (compareJobTimer) { clearTimeout(compareJobTimer); compareJobTimer = 0; }
            reject(new Error("对比超时，可稍后重试"));
        }, COMPARE_TIMEOUT_MS + 15000);
    });
}

/* 执行对比（opts={baseline,root,autoretry}；页内按钮直读表单，跨页调用默认取 state 缓存） */
export async function compareSnapshots(opts, allowOtherMachine) {
    cancelCompare(false); // 上一次对比仍在途则先取消（幂等）
    if (!(opts && opts.autoretry)) scanRetries = 0; // 用户/挂载发起 → 重试计数复位
    const input = $("compare-baseline");
    const btn = $("btn-compare");
    const st = APP_STATE.compare;
    const drill = drillRootOf();
    let root = (opts && opts.root) || drill || String(st.root || getCurrentRoot() || "");
    let baseline = (opts && opts.baseline)
        ? String(opts.baseline).trim()
        : String((input ? input.value.trim() : "") || st.baseline || "").trim();
    if (!baseline) baseline = defaultBaseline(root);
    if (!baseline) {
        setStatus("compare-status", "warn", "没有可用的历史快照，请先完成全量扫描并保存");
        showEmpty();
        return;
    }
    /* P4：下钻时对比根 = 下钻目录（不再回落基线所属盘）；未下钻时保持既有归属推导 */
    if (!drill) {
        const owner = ownerRootFor(baseline, root);
        if (owner) root = owner;
    }
    const target = latestForRoot(root) || String(st.target || "");
    st.baseline = baseline;
    st.root = root;
    st.target = target;
    syncForm({ root: root, baseline: baseline, target: target });
    renderCrumb();

    if (btn) btn.disabled = true;
    setStatus("compare-status", "busy", "正在对比，请稍候…");
    showLoading();
    startElapsedTick();
    scanPending = false;
    compareCancelled = false; // 新请求复位（取消标志只属于上一次对比）
    compareAbort = new AbortController();
    /* B-2：30s 超时（AbortController）——超时 →「对比超时，可稍后重试/Esc 取消」+ 按钮恢复 */
    const timeoutHandle = setTimeout(() => {
        try { if (compareAbort) compareAbort.abort(); } catch (e) { /* ignore */ }
    }, COMPARE_TIMEOUT_MS);
    try {
        /* P4：drop_zero / order_by 由本页固定下发（问题 6 的后端切片前过滤与
           |delta| 排序），depth 仅在选了具体层数时下发（缺省 = 修复前逐字节口径） */
        const depthText = depthValue();
        const payload = {
            root: root,
            baseline: baseline,
            allow_other_machine: !!allowOtherMachine, // P12·W2.13 二次提交放行
            drop_zero: hideZeroOn(),
            order_by: "abs",
        };
        if (depthText) payload.depth = Number(depthText);
        const data = await postJson("/api/compare", payload, { signal: compareAbort.signal });
        /* B-1：202 + {job_id, status:"scanning"} → 轮询 /api/compare/status */
        if (data && data.job_id && (data.status === "scanning" || data.status === "queued")) {
            compareJobId = data.job_id;
            setCompareBusyText("后台对比扫描进行中（可稍候自动完成，Esc 取消）…");
            const report = await pollCompareJob(data.job_id, root, baseline);
            if (compareCancelled || (compareAbort && compareAbort.signal.aborted)) return; // 已被取消/超时
            scanRetries = 0;
            renderReport(report, root, baseline);
            if (btn) btn.disabled = false;
            stopCompareTimers();
            hideLoading();
            return;
        }
        /* 同步 report（缓存命中或后端未启用异步）：既有路径 */
        scanRetries = 0; // 成功 = 锁竞争已解除（重试计数复位）
        renderReport(data.report, root, baseline);
        if (btn) btn.disabled = false;
        stopCompareTimers();
        hideLoading();
    } catch (e) {
        clearTimeout(timeoutHandle);
        stopCompareTimers();
        hideLoading(); // 保证 loading 收敛（B-2：骨架屏不永久存在）
        if (compareCancelled) {
            // 用户主动取消（取消按钮/Esc）
            setStatus("compare-status", "warn", "对比已取消");
            if (btn) btn.disabled = false;
            return;
        }
        if (compareAbort && compareAbort.signal.aborted) {
            // 30s 超时：AbortError
            setStatus("compare-status", "warn", "对比超时，可稍后重试（Esc 取消）");
            if (btn) btn.disabled = false;
            return;
        }
        // P12·W2.13：异机基线 → 红字确认后二次提交携带 allow 字段
        if (e && e.code === "machine_mismatch") {
            const ok = await confirmDialog({
                title: "跨机器基线确认",
                text: "该基线来自其他机器，对比数字可能误导，仍要继续吗？",
                okLabel: "仍要对比",
                okClass: "btn-danger",
            });
            if (ok) return compareSnapshots({ baseline: baseline, root: root }, true);
            setStatus("compare-status", "warn", "已取消跨机器对比");
            if (btn) btn.disabled = false;
            return;
        }
        // P12·W2.4：扫描中/锁占用 409 → 中性提示＋按钮禁用，pds:scan 完成分支自动重试
        if ((e.message || "").indexOf("全量扫描进行中") !== -1) {
            toast("扫描完成后可对比", "warn");
            if (btn) btn.disabled = true;
            scanPending = true;
            pollFullscan();
            showEmpty();
            setStatus("compare-status", "warn", "对比暂不可用：扫描或索引占用中，完成后将自动重试（或稍后手动点击）");
        } else {
            /* B-2：500/超时/网络错误终态文案区分 */
            const msg = (e.message || "") + "";
            if (msg.indexOf("对比超时") !== -1) {
                setStatus("compare-status", "err", "对比超时，可稍后重试（Esc 取消）");
            } else if (msg.indexOf("500") !== -1 || /基线快照加载失败/.test(msg)) {
                setStatus("compare-status", "err", "对比失败（服务器错误）：" + msg);
            } else {
                setStatus("compare-status", "err", msg);
            }
            showEmpty(); // 结果区隐藏（保持旧卡行为：错误态不残留旧结果）
            if (btn) btn.disabled = false;
        }
    }
}

/* ================= 结果渲染（摘要 3 卡 / 发散图 L3-6 / 表格 F19） ================= */

function renderSummary(r) {
    const box = $("compare-summary");
    if (!box) return; // 页面未挂载（跨页触发只记账不回 UI）
    const delta = Number(r.delta_total) || 0;
    const rows = r.rows || [];
    /* D4-5：优先取后端 additive 字段（全量聚合行口径，未按 100 条切片）；
       旧后端 / 桩态无该字段时回退为按 rows 现算（u34 桩态断言不变） */
    const hasAdditive = r.max_growth !== undefined && r.max_growth !== null &&
        r.max_release !== undefined && r.max_release !== null;
    let maxGrowth = Number(r.max_growth) || 0;
    let release = Number(r.max_release) || 0;
    if (!hasAdditive) {
        maxGrowth = 0;
        release = 0;
        rows.forEach((row) => {
            const d = Number(row.delta) || 0;
            if (d > 0) maxGrowth = Math.max(maxGrowth, d);
            if (d < 0) release += -d;
        });
    }
    const scope = hasAdditive ? (Number(r.rows_total) || rows.length) : rows.length;
    const hiddenZeros = Number(r.zero_total) || 0;
    const hiddenText = (hasAdditive && hiddenZeros > 0 && hideZeroOn())
        ? "已隐藏 " + esc(hiddenZeros) + " 条零变化" : "相较基线";
    // P12·W1.2：基线含「已知异常大小」行时前置 warn 提示（additive 字段 legacy_count）
    const legacyNotice = Number(r.legacy_count) > 0
        ? '<div class="notice notice-warn compare-legacy" role="status">基线含 ' +
          esc(Number(r.legacy_count)) +
          ' 条已知异常大小数据，对比数字可能失真，建议重扫重建基线。</div>'
        : "";
    box.innerHTML =
        legacyNotice +
        '<div class="compare-stat" title="全部条目增删净额（后端 delta_total 口径）">' +
        '<span class="compare-stat-label">总变化</span>' +
        '<strong class="compare-stat-value ' + deltaClass(delta) + '">' +
        '<span class="compare-stat-arrow">' + arrowOf(delta) + "</span>" +
        '<span class="compare-stat-num" data-v="0" data-target="' + delta + '" data-fmt="signed">' +
        esc(signedBytes(delta)) + "</span></strong>" +
        '<span class="compare-stat-sub">' + esc(humanBytes(r.total_baseline)) + " → " + esc(humanBytes(r.total_current)) + "</span></div>" +
        '<div class="compare-stat" title="全量 ' + scope + ' 条聚合条目中增长最多者">' +
        '<span class="compare-stat-label">最大增长</span>' +
        '<strong class="compare-stat-value ' + (maxGrowth > 0 ? "grow" : "flat") + '">' +
        '<span class="compare-stat-arrow">' + (maxGrowth > 0 ? "▲" : "±") + "</span>" +
        '<span class="compare-stat-num" data-v="0" data-target="' + maxGrowth + '" data-fmt="signed">' +
        esc(signedBytes(maxGrowth)) + "</span></strong>" +
        '<span class="compare-stat-sub">全量 ' + esc(scope) + " 条 · " + hiddenText + "</span></div>" +
        '<div class="compare-stat" title="全量 ' + scope + ' 条聚合条目中缩减合计（可回收空间）">' +
        '<span class="compare-stat-label">可释放</span>' +
        '<strong class="compare-stat-value ' + (release > 0 ? "shrink" : "flat") + '">' +
        '<span class="compare-stat-arrow">' + (release > 0 ? "▼" : "±") + "</span>" +
        '<span class="compare-stat-num" data-v="0" data-target="' + release + '" data-fmt="plain">' +
        esc(humanBytes(release)) + "</span></strong>" +
        '<span class="compare-stat-sub">缩减合计</span></div>';
    // L1-4 count-up（600ms --dur-4；reduced 直显终值；dataset.v 记账）
    box.querySelectorAll(".compare-stat-num").forEach((el) => {
        const v = Number(el.getAttribute("data-target")) || 0;
        const fmt = el.getAttribute("data-fmt") === "signed" ? signedBytes : humanBytes;
        countUp(el, v, { fmt: fmt });
    });
}

function renderDiverge(r) {
    const host = $("compare-diverge");
    if (!host) return;
    const rows = (r.rows || [])
        .slice()
        .sort((a, b) => Math.abs(Number(b.delta)) - Math.abs(Number(a.delta)))
        .slice(0, 8); // 与旧「变化排行榜」同为 Top 8
    if (!rows.length) {
        host.innerHTML = '<div class="diverge-empty">' + emptyStateHtml(r) + "</div>";
        return;
    }
    const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(Number(row.delta) || 0)));
    host.innerHTML = rows
        .map((row) => {
            const d = Number(row.delta) || 0;
            const grow = d > 0;
            // 条宽 = |Δ|/max|Δ| × 半轨（≤50%——中轴两侧各半，最大条目铺满其侧）
            const w = Math.max(2, (Math.abs(d) / maxAbs) * 50).toFixed(2);
            const pct = row.growth_pct == null
                ? ""
                : (Number(row.growth_pct) >= 0 ? "+" : "") + Number(row.growth_pct).toFixed(2) + "%";
            const cls = deltaClass(d);
            const bar = grow
                ? '<span class="diverge-bar diverge-bar-grow" data-w="' + w + '" style="width:' + w + '%"></span>'
                : d < 0
                    ? '<span class="diverge-bar diverge-bar-shrink" data-w="' + w + '" style="width:' + w + '%"></span>'
                    : '<span class="diverge-bar diverge-bar-flat" style="width:2px"></span>'; // 无变化：中轴中性标记
            return (
                '<button class="diverge-row" type="button" data-path="' + esc(row.path || "") + '"' +
                ' data-drill-path="' + esc(row.path || "") + '"' +
                ' title="下钻查看 ' + esc(row.path || "") + '" aria-label="' + esc(row.path || "") + " " +
                esc((grow ? "增长" : d < 0 ? "缩减" : "无变化") + " " + signedBytes(d)) + '">' +
                '<span class="diverge-name">' + esc(row.path || "") + "</span>" +
                '<span class="diverge-track" aria-hidden="true">' +
                '<span class="diverge-axis"></span>' +
                bar + "</span>" +
                '<span class="diverge-meta">' +
                '<span class="diverge-sign ' + cls + '">' + arrowOf(d) + "</span>" +
                '<span class="diverge-value ' + cls + '">' + esc(signedBytes(d)) + "</span>" +
                '<span class="diverge-badge ' + cls + '" data-pct="' + esc(pct) + '">' + esc(pct || "-") + "</span>" +
                "</span></button>"
            );
        })
        .join("");
    animateDiverge(host);
}

/* L3-6：中轴生长 500ms（--dur-diverge，仅 transform scaleX）+ 徽标 pop-in
   scale .8→1（--dur-3 + --ease-spring，仅 transform/opacity）；reduced 直显终值 */
function animateDiverge(host) {
    const dur = motionDur("--dur-diverge");
    if (!dur || reducedMotion()) return;
    const ease = motionEase("--ease-out") || "linear";
    const popDur = motionDur("--dur-3");
    const popEase = motionEase("--ease-spring") || "linear";
    host.querySelectorAll(".diverge-bar").forEach((bar) => {
        bar.animate(
            [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
            { duration: dur, easing: ease, fill: "forwards" }
        );
    });
    host.querySelectorAll(".diverge-badge").forEach((badge) => {
        if (!popDur) { badge.style.transform = "none"; badge.style.opacity = "1"; return; }
        badge.animate(
            [{ transform: "scale(.8)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
            { duration: popDur, easing: popEase, fill: "forwards" }
        );
    });
}

function renderTable(r) {
    const body = $("compare-body");
    if (!body) return;
    const rows = r.rows || [];
    if (!rows.length) {
        body.innerHTML =
            '<tr><td colspan="4">' + emptyStateHtml(r) + "</td></tr>";
    } else {
        body.innerHTML = rows
            .map((row) => {
                const d = Number(row.delta) || 0;
                const growth = row.growth_pct == null
                    ? "-"
                    : (Number(row.growth_pct) >= 0 ? "+" : "") + Number(row.growth_pct).toFixed(2) + "%";
                const tags = [];
                if (row.added) tags.push('<span class="tag tag-added">新增</span>');
                if (row.removed) tags.push('<span class="tag tag-removed">已删除</span>');
                return (
                    // P4（D4-6）：整行可点 = 页内下钻（以该目录为新根重新对比）
                    '<tr class="compare-row" data-drill-path="' + esc(row.path) +
                    '" title="点击下钻到该目录（以它为对比根）">' +
                    '<td class="delta-cell ' + deltaClass(d) + '">' + arrowOf(d) + " " + esc(signedBytes(d)) + "</td>" +
                    "<td>" + esc(growth) + "</td>" +
                    '<td><span class="cell-name"><span class="name" title="' + esc(row.path) + '">' + esc(row.path) + "</span>" +
                    tags.join("") + "</span></td>" +
                    // F19：对比表格行操作 = 定位（open-path）+ 复制路径（act-copy-cmp 行为保留）
                    '<td class="cmp-ops"><button class="icon-btn act-open-cmp" data-act-path="' + esc(row.path) +
                    '" title="在资源管理器中定位" aria-label="在资源管理器中定位">' + ICONS.folder + "</button>" +
                    '<button class="icon-btn act-copy-cmp" data-act-path="' + esc(row.path) +
                    '" title="复制路径" aria-label="复制路径">' + ICONS.copy + "</button></td>" +
                    "</tr>"
                );
            })
            .join("");
    }
    // L1-2：可视区前 12 行 stagger（fadeSlide8，间隔 --dur-stagger-row；reduced 直显）
    const rowEls = Array.from(body.querySelectorAll("tr")).slice(0, 12);
    if (rowEls.length && !reducedMotion()) {
        staggerIn(rowEls, { y: 8, delay: motionDur("--dur-stagger-row") });
    }
}

function renderReport(r, root, baseline, opts) {
    const fromCache = !!(opts && opts.fromCache);
    const depthText = depthValue();
    const hideZero = hideZeroOn();
    const drill = drillRootOf();
    /* P4：缓存键含口径（depth / 隐藏零变化），否则切深度会回灌上一次的报告 */
    APP_STATE.compare.result = {
        root: root, baseline: baseline, report: r, at: Date.now(),
        depth: r && r.depth !== undefined ? r.depth : (depthText ? Number(depthText) : null),
        hideZero: hideZero,
    };
    APP_STATE.compare.depth = depthText;
    APP_STATE.compare.hideZero = hideZero;
    // U2.4：最近对比迷你卡数据源（主页右栏；本页填写，主页渲染）
    APP_STATE.compare.lastSummary = {
        baseline: baseline,
        root: root,
        totalBaseline: Number(r.total_baseline) || 0,
        totalCurrent: Number(r.total_current) || 0,
        delta: Number(r.delta_total) || 0,
        at: Date.now(),
        atText: new Date().toLocaleString(),
    };
    renderCompareMini();
    // U3.1：N13 圆点提醒——仅真实对比完成挂点；缓存回灌（路由往返/趋势卡共享）
    // 不挂点（提醒语义=在别处发生的新事件；回灌会误挂并跨路由残留）
    if (!fromCache) markNavDot("/compare");
    if (!isPageMounted()) return; // 跨页触发：只记账+圆点，UI 由页面挂载时回灌
    showResult();
    renderSummary(r);
    renderDiverge(r);
    renderTable(r);
    // P12·W3.3：truncated 如实化——真实语义是 compare 行数超 50 万上限截断；
    // 「100 条」只是 top_growth 的固定切片（表格行 = 该切片全量）
    const delta = Number(r.delta_total) || 0;
    const extra = r.truncated
        ? "（注意：数据集超过快照 50 万行上限已截断，结果可能不完整；下表展示变化最大的 " + (r.rows || []).length + " 条）"
        : "（展示变化最大的 " + (r.rows || []).length + " 条差异）";
    // P4：深度 / 下钻 / 零变化过滤如实透出（口径可见，不伪装）
    const depthInfo = (r.depth !== undefined && r.depth !== null)
        ? "；" + Number(r.depth) + " 层聚合（全量 " + (Number(r.rows_total) || (r.rows || []).length) + " 条聚合行）"
        : "";
    const drillInfo = drill ? "；已下钻 " + String(drill).replace(/\\+$/, "") : "";
    const hiddenInfo = (hideZero && Number(r.zero_total) > 0)
        ? "；已隐藏 " + Number(r.zero_total) + " 条零变化" : "";
    // P12·W2.11（B-3）：状态行透出当前数据时间，过期缓存不再伪装实时
    const dataTime = r.current_completed_at
        ? "；当前数据时间 " + String(r.current_completed_at).replace("T", " ")
        : "";
    setStatus(
        "compare-status",
        "ok",
        "对比完成：" + humanBytes(r.total_baseline) + " → " + humanBytes(r.total_current) +
        "，变化 " + signedBytes(delta) + extra + depthInfo + drillInfo + hiddenInfo + dataTime
    );
}

/* ================= 页面接线（每次挂载新 DOM 重绑） ================= */

function bindComparePage() {
    // 对比（按钮 + 基线输入 Enter）
    $("btn-compare").addEventListener("click", () => compareSnapshots());
    $("compare-baseline").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") compareSnapshots();
    });
    // P4（D4-2/D4-6）：深度切换 → 记状态并重发（口径变了不能吃缓存）；下钻中换深度
    // 以「当前下钻根」为新根重新聚合，不回到整盘。
    const depthSel = $("compare-depth");
    if (depthSel) {
        depthSel.addEventListener("change", () => {
            APP_STATE.compare.depth = depthValue();
            APP_STATE.compare.result = null; // 口径变更 → 弃用旧报告缓存
            compareSnapshots();
        });
    }
    // P4（D4-3/D4-4）：隐藏零变化开关（后端切片前过滤；关 = 请求 drop_zero=false）
    const zeroBox = $("compare-hide-zero");
    if (zeroBox) {
        zeroBox.addEventListener("change", () => {
            APP_STATE.compare.hideZero = !!zeroBox.checked;
            APP_STATE.compare.result = null;
            compareSnapshots();
        });
    }
    // P4（D4-6）：面包屑逐级返回（首项 path="" = 回到未下钻的整盘口径）
    const crumb = $("compare-crumb");
    if (crumb) {
        crumb.addEventListener("click", (ev) => {
            const btn = ev.target.closest(".crumb-item[data-crumb-path]");
            if (!btn) return;
            const path = btn.getAttribute("data-crumb-path") || "";
            APP_STATE.compare.drillRoot = path;
            APP_STATE.compare.result = null;
            renderCrumb();
            compareSnapshots();
        });
    }
    // 阶段B（B-2）：loading 骨架屏取消按钮——中止在途对比并恢复按钮
    const cancelBtn = $("btn-compare-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
        cancelCompare();
        setStatus("compare-status", "warn", "对比已取消");
        showEmpty();
        hideLoading();
    });
    // 阶段B（B-2）：Esc 取消在途对比（弹窗栈优先——红线 #9；document 级只绑一次）
    if (!cancelEscBound) {
        cancelEscBound = true;
        document.addEventListener("keydown", (ev) => {
            if (ev.key !== "Escape") return;
            if (document.querySelector(".modal:not(.hidden)")) return;
            if (compareAbort || compareJobId) {
                cancelCompare();
                setStatus("compare-status", "warn", "对比已取消（Esc）");
                showEmpty();
                hideLoading();
            }
        });
    }
    // 基线输入变化 → 回写 state（切页不丢）+ 目标随同盘符联动（只读展示）
    $("compare-baseline").addEventListener("input", () => {
        const b = $("compare-baseline").value.trim();
        APP_STATE.compare.baseline = b;
        /* P4：换基线 = 换对比对象 → 下钻根失效（避免把 A 盘的子目录当成 B 盘的新根） */
        if (APP_STATE.compare.drillRoot) {
            APP_STATE.compare.drillRoot = "";
            renderCrumb();
        }
        const root = ownerRootFor(b, APP_STATE.compare.root || getCurrentRoot()) || "";
        if (root) {
            APP_STATE.compare.root = root;
            const target = latestForRoot(root);
            if (target) APP_STATE.compare.target = target;
        }
        syncForm();
    });
    // P12·W1.4：对比明细行尾操作（定位 F19 / 复制路径）——行为保留，委托渲染内容更新
    // P4（D4-6）：整行点击 = 页内下钻（行尾操作按钮优先，命中则不下钻）
    $("compare-body").addEventListener("click", (ev) => {
        const openBtn = ev.target.closest(".act-open-cmp");
        if (openBtn) { openInExplorer(openBtn.getAttribute("data-act-path")); return; }
        const copyBtn = ev.target.closest(".act-copy-cmp");
        if (copyBtn) { copyPath(copyBtn.getAttribute("data-act-path")); return; }
        const tr = ev.target.closest("tr[data-drill-path]");
        if (tr) drillInto(tr.getAttribute("data-drill-path"));
    });
    // P4（D4-6）：发散图行点击同口径 = 页内下钻（原「浏览该路径」由表格行尾「定位」保留）
    $("compare-diverge").addEventListener("click", (ev) => {
        const row = ev.target.closest(".diverge-row[data-drill-path]");
        if (row) drillInto(row.getAttribute("data-drill-path"));
    });
    ensureScanListener();
}

/* ============================================================
   U2.1/U3.4：页面契约（render/mount/unmount；§3.3 布局，§6.5 空态）
   ============================================================ */

const COMPARE_PAGE_HTML =
    '<section class="page page-compare" data-page="compare">' +
    '<header class="page-head page-head-row page-head-compare">' +
    '<div class="page-head-titles">' +
    '<h1 class="page-title" data-page-title>历史对比</h1>' +
    '<p class="page-sub" id="compare-root-line">基线=最近一份快照 · 目标=同盘符最新快照</p>' +
    "</div>" +
    '<div class="compare-controls" role="group" aria-label="对比参数">' +
    '<label class="compare-ctl" for="compare-baseline" title="基线快照（datalist 可选；留空自动取最近一份）">' +
    "基线" +
    '<input id="compare-baseline" list="baseline-suggest" type="text" autocomplete="off" spellcheck="false"' +
    ' placeholder="默认取最近一份快照" aria-label="基线快照路径（留空自动选最近一份）" title="基线快照（datalist 可选；留空自动取最近一份）">' +
    "</label>" +
    '<datalist id="baseline-suggest"></datalist>' +
    '<label class="compare-ctl compare-ctl-target" for="compare-target" title="仅展示：对比的目标为当前磁盘最新状态（同盘符最新快照为标识性口径）">' +
    "目标" +
    '<input id="compare-target" type="text" readonly tabindex="-1" placeholder="同盘符最新快照" aria-label="目标（只读）=同盘符最新快照" title="同盘符最新快照（只读展示；对比目标实为当前磁盘状态）">' +
    "</label>" +
    // P4（D4-2）：深度选择器——缺省「叶子（默认）」= 修复前口径（不发 depth）
    '<label class="compare-ctl compare-ctl-depth" for="compare-depth" title="深度：按相对对比根的第 N 层聚合目录增量（后端在排序/截断之前聚合，不由前端近似）">' +
    "深度" +
    '<select id="compare-depth" aria-label="对比深度（叶子 / 第 N 层聚合）" title="深度聚合：叶子（默认，修复前口径）/ 第 1..5 层">' +
    '<option value="">叶子（默认）</option>' +
    '<option value="1">1 层</option>' +
    '<option value="2">2 层</option>' +
    '<option value="3">3 层</option>' +
    '<option value="4">4 层</option>' +
    '<option value="5">5 层</option>' +
    "</select></label>" +
    // P4（D4-3/D4-4）：隐藏零变化（默认开）——后端切片前过滤 delta==0
    '<label class="compare-ctl compare-ctl-zero" for="compare-hide-zero" title="隐藏零变化：后端在排序与 Top-100 截断之前过滤 delta=0 的条目（避免零行补位、避免负增量被挤出榜单）">' +
    '<input id="compare-hide-zero" type="checkbox" checked aria-label="隐藏零变化条目">' +
    "隐藏零变化</label>" +
    '<button id="btn-compare" class="btn btn-primary">' +
    '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v18"/><path d="M16 3v18"/><path d="M3 8h5"/><path d="M16 16h5"/></svg>' +
    "开始对比</button>" +
    "</div></header>" +
    '<div class="page-body page-compare-body">' +
    '<div id="compare-status" class="status-line" role="status"><span class="dot"></span>' +
    '<span id="compare-status-text">选择一份基线快照，开始对比两个时间点的空间变化。</span></div>' +
    // P4（D4-6）：下钻面包屑（未下钻时 hidden，不占高度）
    '<nav id="compare-crumb" class="compare-crumb" aria-label="下钻路径（点击返回上级）" hidden></nav>' +
    '<div id="compare-empty" class="page-compare-empty">' +
    '<div class="empty-state">' +
    '<b>选择一份基线快照</b>' +
    "<p>开始对比两个时间点的空间变化。</p>" +
    "</div></div>" +
    '<div id="compare-loading" class="compare-loading" hidden>' +
    '<div class="skel-list" aria-hidden="true">' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    '<div class="skel-row"><span class="skel-block skel-name"></span><span class="skel-bar skel-block"></span><span class="skel-block skel-size"></span></div>' +
    "</div>" +
    '<span class="muted">正在对比，请稍候…</span>' +
    ' <span id="compare-loading-elapsed" class="muted scan-elapsed" hidden></span>' +
    ' <button id="btn-compare-cancel" class="btn btn-sm hidden" type="button">取消</button></div>' +
    '<div id="compare-result" class="compare-result" hidden>' +
    '<div id="compare-summary" class="compare-summary-row" role="group" aria-label="对比摘要（总变化/最大增长/可释放）"></div>' +
    '<div id="compare-diverge" class="compare-diverge" role="group" aria-label="红绿发散条形图（增长向左红/缩减向右绿）"></div>' +
    '<div class="table-wrap compare-table-wrap">' +
    '<table class="dir-table compare-table" aria-label="对比明细">' +
    "<thead><tr><th style=\"width:120px\">变化</th><th style=\"width:90px\">增速</th><th>路径</th><th style=\"width:80px\">操作</th></tr></thead>" +
    '<tbody id="compare-body"></tbody></table></div></div>' +
    "</div></section>";

export function renderCompare() {
    const el = document.createElement("div");
    el.innerHTML = COMPARE_PAGE_HTML;
    return el.firstElementChild;
}

export function mountCompare() {
    bindComparePage();
    rebuildBaselineSuggest(sessionsOf()); // datalist 全量快照路径（回灌填充）
    /* P4：回灌口径控件（切页不丢：深度选择器 + 隐藏零变化开关），再渲面包屑 */
    const depthSel = $("compare-depth");
    if (depthSel) depthSel.value = String(APP_STATE.compare.depth || "");
    const zeroBox = $("compare-hide-zero");
    if (zeroBox) zeroBox.checked = APP_STATE.compare.hideZero !== false;
    const sel = ensurePrefill(); // 三入口预填（趋势卡/迷你卡/直达默认最近一份）
    renderCrumb();
    syncForm(sel);
    if (!sel) {
        showEmpty();
        return;
    }
    const cached = resultCacheMatch(sel);
    if (cached) {
        // 路由往返回灌：同根同基线**同口径** → 从缓存渲染不重发（含趋势卡共享结果；不挂圆点）
        renderReport(cached.report, cached.root, cached.baseline, { fromCache: true });
        return;
    }
    compareSnapshots(); // 自动执行（定稿 6.4：预填即骨架屏→摘要→图→表）
}

/* 数据清空（settings.wipeData）联动：结果/迷你摘要复位；对比页在位则回空态 */
export function resetCompareData() {
    APP_STATE.compare.result = null;
    APP_STATE.compare.lastSummary = null;
    APP_STATE.compare.drillRoot = "";   // P4：下钻根一并复位
    APP_STATE.compare.depth = "";
    APP_STATE.compare.hideZero = true;
    renderCompareMini();
    if (isPageMounted()) {
        const input = $("compare-baseline");
        if (input) input.value = "";
        const depthSel = $("compare-depth");
        if (depthSel) depthSel.value = "";
        const zeroBox = $("compare-hide-zero");
        if (zeroBox) zeroBox.checked = true;
        APP_STATE.compare.baseline = "";
        APP_STATE.compare.root = "";
        APP_STATE.compare.target = "";
        renderCrumb();
        setStatus("compare-status", "", "选择一份基线快照，开始对比两个时间点的空间变化。");
        showEmpty();
    }
}

export function unmountCompare() {
    /* 无 rAF/轮询归本页；pending 的 compare 回包经 DOM 空守卫自吞 */
}
