/* ============================================================
   UI 2.0（SpaceLens Pro）· components/snapshot-view.js
   （2026-09-13 用户实测反馈新增：快照页可视化；同日第二轮增补会话可见性口径，
     原 snapshot-calendar.js 更名——本模块 = **快照页纯函数**：
     日历热力图 + 会话「是否真的保存了快照」判定）

   【一】月历热力图（原需求：「快照页可不可以加个可视化，能够很方便地看到
   某一天有没有快照，有几个快照之类的」）：
   - 每格一天，格子颜色深浅 = 当天快照份数（1 / 2 / 3-4 / ≥5 四档），
     格内右下角显示份数徽标；
   - 今天有描边、当前筛选日高亮；
   - 头部 = 月份导航（‹ › 本月）+ 本月统计（本月 N 次 · 活跃 M 天 · 最近 …）；
   - 点击有快照的日期 → 交给调用方（snapshots.js）筛选下方会话列表。

   【二】会话可见性（第二轮用户实测反馈：「跳过快照里到底有没有保存，没有保存
   不应该出现，如果保存没有内容也不应该出现」）：
   - `savedRoots(s)`：任一盘真的写了快照文件（snapshot_path 存在且未 skipped）；
   - `isMeaningfulSession(s)`：至少一盘**有内容**（大小未知视为有内容——不因
     缺字段误判为空；已知大小为 0 = 保存了但没内容 → 不算）；
   - `splitSessions(list)` → {meaningful, empty}：列表/日历只渲染 meaningful，
     empty 交调用方做「已隐藏 N 个空会话 + 清理」提示。
   ⚠️ 后端契约不变：`tests/test_stage_d.py` 明确「全盘 skipped 仍生成会话清单」
   （自动保存尝试的审计轨迹）——过滤只发生在**展示层**，不改后端行为。

   ⚠️ 设计纪律（与红线一致）：
   - **零 import、零 DOM 依赖、零模块状态**——全部是纯函数
     （字符串进 / 字符串出），可被 `node --test` 直接单测；
   - **后端零改动**：数据源 = 既有 GET /api/snapshots 的 sessions
     （`created_at` ISO 秒级；缺失时回退解析 `session_id` 前缀），
     不新增字段、不新增路由；
   - 输出只含**正则校验过的数字与 YYYY-MM-DD 字面量** + 固定类名，
     无用户可控文本 → 无注入面（仍做最小属性转义以防未来改动）。

   时间口径：一律按**本地时间**字符串切片（created_at 由后端
   `datetime.now().isoformat()` 生成，本身就是本地时间），不做时区换算。
   ============================================================ */

export const CAL_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
/* session_id 前缀形态（session.py：YYYYMMDD_HHMMSS_…）——created_at 缺失时的回退 */
const SID_RE = /^(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/;

function pad2(n) {
    return (n < 10 ? "0" : "") + n;
}

/* ISO 时间文本（或 session_id）→ "YYYY-MM-DD"；不可解析 → "" */
export function dayKeyOf(text) {
    const s = String(text || "").trim();
    if (!s) return "";
    const m = DAY_RE.exec(s);
    if (m) {
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return m[1] + "-" + m[2] + "-" + m[3];
        return "";
    }
    const sid = SID_RE.exec(s);
    if (sid) {
        const mo = Number(sid[2]);
        const d = Number(sid[3]);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return sid[1] + "-" + sid[2] + "-" + sid[3];
    }
    return "";
}

/* "YYYY-MM-DD" / ISO 文本 → "YYYY-MM"；不可解析 → "" */
export function monthKeyOf(text) {
    const day = dayKeyOf(text);
    return day ? day.slice(0, 7) : "";
}

/* 月份偏移："2026-09" +1 → "2026-10"（跨年正确；非法输入回落本月） */
export function shiftMonth(month, delta) {
    const key = /^\d{4}-\d{2}$/.test(String(month || "")) ? String(month) : monthKeyOf(new Date().toISOString());
    let y = Number(key.slice(0, 4));
    let m = Number(key.slice(5, 7)) + Math.trunc(Number(delta) || 0);
    while (m > 12) { m -= 12; y += 1; }
    while (m < 1) { m += 12; y -= 1; }
    return y + "-" + pad2(m);
}

/* 今天（本地）"YYYY-MM-DD"——可注入 done 便于单测 */
export function todayKey(now) {
    const d = now instanceof Date ? now : new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/* ================= 会话可见性（第二轮用户实测反馈） =================
   背景：自动保存被四原子谓词拒绝时，后端仍会写一份「全盘 skipped」的会话清单
   （审计轨迹，见 tests/test_stage_d.py 契约），于是列表里堆满「0 个盘 / 跳过」
   的空会话——用户实测 38 个会话里 27 个是这种噪音，且把列表挤到只剩一行可见。

   口径（前端展示层，纯函数）：
   ① 没保存 → 不出现：所有盘 skipped / 无 snapshot_path（empty）；
   ② 保存了但没内容 → 不出现：快照大小已知且为 0（empty）；
   ③ 大小未知（旧后端/字段缺失）→ **保留**（不因缺字段把真实快照误判为空）；
   ④ 测试/夹具数据 → 不出现（fixture，见下）：与真实数据隔离展示。 */

/* 夹具/测试根路径（2026-09-13 第三轮：用户实测「C:\SDK5 这些是测试环境吗」——
   确为历史探针留下的测试数据）。只认**明确的测试命名**，不做「不存在即测试」这类
   猜测：真实盘根 C:\ / D:\ 永远不匹配。 */
export const FIXTURE_ROOT_RE = /^[a-z]:[\\/](?:sdk\d*|fixture\d*|fix[-_][^\\/]*|pds[-_]fixture[^\\/]*|test[-_]?(?:root|data|drive)\d*)(?:[\\/]|$)/i;

/* 该会话真正写盘了的盘条目（未跳过且有快照路径） */
export function savedRoots(session) {
    const roots = Object.values((session && session.roots) || {});
    return roots.filter((r) => r && !r.skipped && r.snapshot_path);
}

/* 已保存快照的字节合计（口径与 snapshots.js「合计 X」一致：
   跳过项/无快照项不计；total_by_root 缺失 → 不计，不编造数字） */
export function sessionSavedBytes(session) {
    const totals = (session && session.total_by_root) || {};
    let sum = 0;
    savedRoots(session).forEach((r) => {
        const n = Number(totals[r.root]);
        if (Number.isFinite(n) && n > 0) sum += n;
    });
    return sum;
}

/* 该会话是否有「已知大小」的盘（false = 全部盘大小未知，只能按有快照保留） */
export function hasKnownSize(session) {
    const totals = (session && session.total_by_root) || {};
    return savedRoots(session).some((r) => Number.isFinite(Number(totals[r.root])));
}

/* 会话是否值得出现在列表里（见上方 ①②③ 口径） */
export function isMeaningfulSession(session) {
    const saved = savedRoots(session);
    if (!saved.length) return false;                       // ① 没保存
    if (sessionSavedBytes(session) > 0) return true;       // 有内容
    const totals = (session && session.total_by_root) || {};
    // ② 全部已知且为 0 → 保存了但没内容；③ 有未知项 → 保留
    return saved.some((r) => !Number.isFinite(Number(totals[r.root])));
}

/* 夹具/测试会话：**所有**真正保存的盘都落在测试命名路径下（任一真实盘即不算夹具）。
   无保存项的会话不算夹具（归 empty，走空会话口径）。 */
export function isFixtureSession(session) {
    const saved = savedRoots(session);
    if (!saved.length) return false;
    return saved.every((r) => FIXTURE_ROOT_RE.test(String(r.root || "")));
}

/* list → { meaningful, empty, fixture }（保持原顺序；空数组输入安全）
   meaningful = 既有内容、又非夹具 → 列表/日历/对比基准只认这一组。 */
export function splitSessions(sessions) {
    const meaningful = [];
    const empty = [];
    const fixture = [];
    (sessions || []).forEach((s) => {
        if (!s) return;
        if (isFixtureSession(s)) fixture.push(s);
        else if (isMeaningfulSession(s)) meaningful.push(s);
        else empty.push(s);
    });
    return { meaningful: meaningful, empty: empty, fixture: fixture };
}

/* ================= 左栏「最近快照」纯渲染（2026-09-13 第三轮） =================
   用户实测：日历卡只有 300px 高，左栏下方留出 200px+ 空白。
   本块把空白变成「最近 N 次保存」快捷入口——时间 · 盘 · 大小，点击 = 按该天筛选列表
   （与点日历格同语义，故 data-cal-day 复用同一委托）。 */
export function recentListHtml(sessions, opts) {
    const o = opts || {};
    const limit = Math.max(1, Number(o.limit) || 6);
    const list = (sessions || []).filter((s) => s && isMeaningfulSession(s) && !isFixtureSession(s));
    if (!list.length) {
        return '<div class="recent-head"><h2 class="cal-title">最近快照</h2></div>' +
            '<p class="recent-empty">还没有快照</p>';
    }
    const rows = list.slice(0, limit).map((s) => {
        const day = dayKeyOf(s.created_at) || dayKeyOf(s.session_id);
        const created = String(s.created_at || "").replace("T", " ");
        const drives = savedRoots(s).map((r) => String(r.root || "").replace(/\\+$/, "")).join(" ");
        const size = fmtBytesShort(sessionSavedBytes(s));
        const picked = o.picked && day === o.picked;
        return (
            '<button type="button" class="recent-item' + (picked ? " is-picked" : "") + '"' +
            ' data-cal-day="' + escAttr(day) + '" title="筛选 ' + escAttr(day) + '（点击=只看这一天的会话）">' +
            '<span class="recent-time">' + escAttr(created.slice(5, 16)) + "</span>" +
            '<span class="recent-drives">' + escAttr(drives) + "</span>" +
            '<span class="recent-size">' + escAttr(size || "—") + "</span>" +
            "</button>"
        );
    }).join("");
    return '<div class="recent-head"><h2 class="cal-title">最近快照</h2>' +
        '<span class="recent-sub">共 ' + list.length + " 次</span></div>" +
        '<div class="recent-list">' + rows + "</div>";
}

/* 会话内的快照字节合计（日历内部用；同 sessionSavedBytes，保留私有别名） */
function sessionBytes(s) {
    return sessionSavedBytes(s);
}

/* sessions → Map("YYYY-MM-DD" → {day,count,auto,manual,bytes}) */
export function sessionsByDay(sessions) {
    const map = new Map();
    (sessions || []).forEach((s) => {
        if (!s) return;
        const key = dayKeyOf(s.created_at) || dayKeyOf(s.session_id);
        if (!key) return;
        const e = map.get(key) || { day: key, count: 0, auto: 0, manual: 0, bytes: 0 };
        e.count += 1;
        if (s.auto) e.auto += 1; else e.manual += 1;
        e.bytes += sessionBytes(s);
        map.set(key, e);
    });
    return map;
}

/* 默认展示月份：数据里最新一天所在月（无数据 → 本月） */
export function defaultMonth(sessions) {
    let latest = "";
    sessionsByDay(sessions).forEach((e) => { if (e.day > latest) latest = e.day; });
    return latest ? latest.slice(0, 7) : monthKeyOf(new Date().toISOString());
}

/* 份数 → 热力档位（1/2/3-4/≥5） */
export function levelOf(count) {
    const n = Number(count) || 0;
    if (n <= 0) return 0;
    if (n === 1) return 1;
    if (n === 2) return 2;
    if (n <= 4) return 3;
    return 4;
}

function fmtBytesShort(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    const digits = i === 0 ? 0 : (v >= 100 ? 0 : (v >= 10 ? 1 : 2));
    return v.toFixed(digits) + " " + units[i];
}

/* 本月统计（additive；无数据 → 全 0，调用方据此给空态文案） */
export function calendarStats(sessions, month) {
    const key = /^\d{4}-\d{2}$/.test(String(month || "")) ? String(month) : defaultMonth(sessions);
    let count = 0;
    let days = 0;
    let bytes = 0;
    let busiest = null;
    let latest = "";
    sessionsByDay(sessions).forEach((e) => {
        if (e.day.slice(0, 7) !== key) return;
        count += e.count;
        days += 1;
        bytes += e.bytes;
        if (!busiest || e.count > busiest.count) busiest = e;
        if (e.day > latest) latest = e.day;
    });
    return { month: key, count: count, days: days, bytes: bytes, busiest: busiest, latest: latest };
}

/* 月历网格模型：{month, rows, cells:[{blank:true}|{day,dow,level,count,auto,manual,bytes}]} */
export function calendarModel(sessions, month) {
    const key = /^\d{4}-\d{2}$/.test(String(month || "")) ? String(month) : defaultMonth(sessions);
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    const startDow = new Date(y, m - 1, 1).getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const byDay = sessionsByDay(sessions);
    const cells = [];
    for (let i = 0; i < startDow; i += 1) cells.push({ blank: true });
    for (let d = 1; d <= daysInMonth; d += 1) {
        const day = key + "-" + pad2(d);
        const e = byDay.get(day);
        cells.push({
            blank: false,
            day: day,
            num: d,
            dow: (startDow + d - 1) % 7,
            count: e ? e.count : 0,
            auto: e ? e.auto : 0,
            manual: e ? e.manual : 0,
            bytes: e ? e.bytes : 0,
            level: levelOf(e ? e.count : 0),
        });
    }
    return { month: key, cells: cells };
}

function escAttr(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function cellTitle(c) {
    const bits = [c.day];
    if (!c.count) {
        bits.push("无快照");
        return bits.join(" · ");
    }
    bits.push(c.count + " 次快照");
    const kinds = [];
    if (c.auto) kinds.push("自动 " + c.auto);
    if (c.manual) kinds.push("手动 " + c.manual);
    if (kinds.length) bits.push(kinds.join(" / "));
    const size = fmtBytesShort(c.bytes);
    if (size) bits.push("合计 " + size);
    return bits.join(" · ");
}

/* 月历 HTML（纯字符串；调用方负责插入与事件委托）。
   opts: { month, picked, today } —— today 可注入便于单测/快照对比。 */
export function calendarHtml(sessions, opts) {
    const o = opts || {};
    const model = calendarModel(sessions, o.month);
    const stats = calendarStats(sessions, model.month);
    const picked = /^\d{4}-\d{2}-\d{2}$/.test(String(o.picked || "")) ? String(o.picked) : "";
    const today = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || "")) ? String(o.today) : todayKey();

    const subBits = [];
    if (stats.count) {
        subBits.push("本月 " + stats.count + " 次");
        subBits.push("活跃 " + stats.days + " 天");
        if (stats.latest) subBits.push("最近 " + stats.latest.slice(5));
    } else {
        subBits.push("本月还没有快照");
    }

    const weekdays = CAL_WEEKDAYS
        .map((w) => '<span class="cal-dow" aria-hidden="true">' + w + "</span>")
        .join("");

    const cells = model.cells
        .map((c) => {
            if (c.blank) return '<span class="cal-cell is-blank" aria-hidden="true"></span>';
            const cls = ["cal-cell"];
            if (c.count) cls.push("has-snap", "lvl-" + c.level);
            else cls.push("is-empty");
            if (c.day === today) cls.push("is-today");
            if (c.day === picked) cls.push("is-picked");
            const badge = c.count ? '<span class="cal-count">' + c.count + "</span>" : "";
            const aria = c.count
                ? "筛选 " + c.day + "（" + c.count + " 次快照）"
                : c.day + "（无快照）";
            return (
                '<button type="button" class="' + cls.join(" ") + '" data-cal-day="' + escAttr(c.day) + '"' +
                (c.count ? "" : " disabled") +
                ' title="' + escAttr(cellTitle(c)) + '" aria-label="' + escAttr(aria) + '"' +
                ' aria-pressed="' + (c.day === picked ? "true" : "false") + '">' +
                '<span class="cal-day">' + c.num + "</span>" + badge + "</button>"
            );
        })
        .join("");

    const pickedEntry = picked ? sessionsByDay(sessions).get(picked) : null;
    const pickedLine = picked
        ? '<span class="cal-picked">已筛选 ' + picked.slice(5) + "（" +
          (pickedEntry ? pickedEntry.count + " 份" : "无快照") +
          '）</span><button type="button" class="btn btn-sm cal-clear" data-cal-clear="1" title="清除日期筛选">清除</button>'
        : '<span class="cal-hint">点有快照的日期可筛选列表</span>';

    return (
        '<div class="cal-head">' +
        '<div class="cal-head-main"><h2 class="cal-title">快照日历</h2>' +
        '<p class="cal-sub" id="cal-sub">' + subBits.join(" · ") + "</p></div>" +
        '<div class="cal-nav">' +
        '<button type="button" class="btn btn-sm cal-nav-btn" data-cal-nav="-1" title="上一月" aria-label="上一月">‹</button>' +
        '<span class="cal-month" id="cal-month-label">' + model.month + "</span>" +
        '<button type="button" class="btn btn-sm cal-nav-btn" data-cal-nav="1" title="下一月" aria-label="下一月">›</button>' +
        '<button type="button" class="btn btn-sm cal-today-btn" data-cal-today="1" title="回到本月">本月</button>' +
        "</div></div>" +
        '<div class="cal-grid" role="group" aria-label="' + escAttr(model.month + " 快照日历，每格数字为当天快照份数") + '">' +
        weekdays + cells + "</div>" +
        '<div class="cal-foot">' + pickedLine +
        '<span class="cal-legend" aria-hidden="true">少<i class="cal-swatch lvl-1"></i><i class="cal-swatch lvl-2"></i>' +
        '<i class="cal-swatch lvl-3"></i><i class="cal-swatch lvl-4"></i>多</span>' +
        "</div>"
    );
}
