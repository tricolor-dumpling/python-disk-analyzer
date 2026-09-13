/* 2026-09-13：快照页纯函数单测（components/snapshot-view.js）
   覆盖：① 日历——日期键解析（ISO / session_id 回退 / 非法）、月份偏移跨年、
   热力档位、月历网格首日/天数/空白格、本月统计（份数/活跃天/最近）、HTML 关键断言
   （有快照日可点、无快照日 disabled、选中日高亮、月份标签）；
   ② 会话可见性（第二轮用户反馈「没有保存不应该出现，保存没有内容也不应该出现」）。
   该模块零 import → 直接 import 真实现（无需像 trend-window 那样复制实现防环）。 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    CAL_WEEKDAYS, FIXTURE_ROOT_RE, calendarHtml, calendarModel, calendarStats, dayKeyOf, defaultMonth,
    hasKnownSize, isFixtureSession, isMeaningfulSession, levelOf, monthKeyOf, recentListHtml,
    savedRoots, sessionSavedBytes, sessionsByDay, shiftMonth, splitSessions, todayKey,
} from "../../web/static/js/app/components/snapshot-view.js";

const SESSIONS = [
    { session_id: "20260912_023335_1", created_at: "2026-09-12T02:33:35", auto: true, roots: { "C:\\": { root: "C:\\", snapshot_path: "c.gz" } }, total_by_root: { "C:\\": 1024 } },
    { session_id: "20260912_210000_2", created_at: "2026-09-12T21:00:00", auto: false, roots: { "D:\\": { root: "D:\\", snapshot_path: "d.gz" } }, total_by_root: { "D:\\": 2048 } },
    { session_id: "20260911_085748_3", created_at: "2026-09-11T08:57:48", auto: true, roots: { "C:\\": { root: "C:\\", snapshot_path: "c2.gz", skipped: true } } },
    { session_id: "20260901_010101_4", created_at: "", auto: false, roots: { "C:\\": { root: "C:\\", snapshot_path: "c3.gz" } }, total_by_root: { "C:\\": 4096 } },
    { session_id: "", created_at: "not-a-date", auto: false, roots: {} },
];

test("dayKeyOf：ISO / session_id 回退 / 非法", () => {
    assert.equal(dayKeyOf("2026-09-12T02:33:35"), "2026-09-12");
    assert.equal(dayKeyOf("2026-09-12"), "2026-09-12");
    assert.equal(dayKeyOf("20260901_010101_4"), "2026-09-01");
    assert.equal(dayKeyOf(""), "");
    assert.equal(dayKeyOf("not-a-date"), "");
    assert.equal(dayKeyOf(null), "");
    // 非法月/日（正则弱命中）必须被拒绝，不能生成假日期
    assert.equal(dayKeyOf("2026-13-45T00:00:00"), "");
});

test("monthKeyOf / defaultMonth / todayKey", () => {
    assert.equal(monthKeyOf("2026-09-12T02:33:35"), "2026-09");
    assert.equal(monthKeyOf("nope"), "");
    assert.equal(defaultMonth(SESSIONS), "2026-09");
    assert.equal(defaultMonth([]), todayKey().slice(0, 7));
    assert.match(todayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test("shiftMonth：跨年/跨月正确，非法输入回落本月", () => {
    assert.equal(shiftMonth("2026-09", 1), "2026-10");
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
    assert.equal(shiftMonth("2026-01", -1), "2025-12");
    assert.equal(shiftMonth("2026-09", 0), "2026-09");
    assert.equal(shiftMonth("bad", 0), todayKey().slice(0, 7));
});

test("levelOf：份数 → 四档热力", () => {
    assert.equal(levelOf(0), 0);
    assert.equal(levelOf(1), 1);
    assert.equal(levelOf(2), 2);
    assert.equal(levelOf(3), 3);
    assert.equal(levelOf(4), 3);
    assert.equal(levelOf(5), 4);
    assert.equal(levelOf(undefined), 0);
});

test("sessionsByDay：按天聚合份数/自动手动/合计；无日期键的会话被丢弃", () => {
    const map = sessionsByDay(SESSIONS);
    assert.equal(map.size, 3); // 09-12 / 09-11 / 09-01（空 session_id + 非法 created_at 丢弃）
    assert.deepEqual(map.get("2026-09-12"), { day: "2026-09-12", count: 2, auto: 1, manual: 1, bytes: 3072 });
    // 跳过盘不计字节，但仍计份数（会话存在即一份快照记录）
    assert.deepEqual(map.get("2026-09-11"), { day: "2026-09-11", count: 1, auto: 1, manual: 0, bytes: 0 });
    assert.equal(map.get("2026-09-01").count, 1);
});

test("calendarModel：网格首日对齐 + 天数 + 前导空白", () => {
    const model = calendarModel(SESSIONS, "2026-09");
    assert.equal(model.month, "2026-09");
    const blanks = model.cells.filter((c) => c.blank).length;
    const days = model.cells.filter((c) => !c.blank).length;
    assert.equal(days, 30); // 2026-09 共 30 天
    assert.equal(blanks, new Date(2026, 8, 1).getDay()); // 9/1 是周二 → 2 个空白
    const d12 = model.cells.find((c) => !c.blank && c.num === 12);
    assert.equal(d12.count, 2);
    assert.equal(d12.level, 2);
    const d13 = model.cells.find((c) => !c.blank && c.num === 13);
    assert.equal(d13.count, 0);
    assert.equal(d13.level, 0);
    // 注入月份（无数据月）也必须有完整 30/31 格
    assert.equal(calendarModel(SESSIONS, "2026-02").cells.filter((c) => !c.blank).length, 28);
});

test("calendarStats：份数/活跃天/最密/最近", () => {
    const st = calendarStats(SESSIONS, "2026-09");
    assert.equal(st.count, 4);
    assert.equal(st.days, 3);
    assert.equal(st.latest, "2026-09-12");
    assert.equal(st.busiest.day, "2026-09-12");
    assert.equal(st.busiest.count, 2);
    assert.equal(st.bytes, 3072 + 4096);
    // 无数据月
    const empty = calendarStats(SESSIONS, "2020-01");
    assert.equal(empty.count, 0);
    assert.equal(empty.days, 0);
    assert.equal(empty.busiest, null);
});

test("calendarHtml：有快照日可点/无快照日 disabled/选中日高亮/月份与统计", () => {
    const html = calendarHtml(SESSIONS, { month: "2026-09", picked: "2026-09-12", today: "2026-09-13" });
    assert.ok(html.includes("2026-09"), "月份标签应出现");
    assert.ok(html.includes('id="cal-month-label">2026-09<'), "月份标签元素");
    assert.ok(html.includes("本月 4 次"), "统计行应含本月份数");
    assert.ok(html.includes("活跃 3 天"), "统计行应含活跃天数");
    // 有快照的日期：可点击（无 disabled）且带份数徽标
    const d12 = /<button[^>]*data-cal-day="2026-09-12"[^>]*>/.exec(html);
    assert.ok(d12, "应渲染 09-12 格子");
    assert.ok(!/\bdisabled\b/.test(d12[0]), "有快照日不应 disabled");
    assert.ok(html.includes('data-cal-day="2026-09-12"') && html.includes('<span class="cal-count">2</span>'), "应有份数徽标 2");
    // 选中日高亮 + aria-pressed
    assert.ok(d12[0].includes("is-picked"), "选中日应有 is-picked");
    assert.ok(d12[0].includes('aria-pressed="true"'), "选中日 aria-pressed=true");
    // 无快照日：disabled 且无 lvl 类
    const d13 = /<button[^>]*data-cal-day="2026-09-13"[^>]*>/.exec(html);
    assert.ok(d13 && d13[0].includes("disabled"), "无快照日应 disabled");
    assert.ok(!d13[0].includes("lvl-"), "无快照日不应有热力档位");
    // 今天内描边（2026-09-13）
    assert.ok(d13[0].includes("is-today"), "今天应有 is-today");
    // 表头七个星期列 + 图例四档
    assert.equal(CAL_WEEKDAYS.length, 7);
    assert.equal((html.match(/cal-dow/g) || []).length, 7);
    assert.equal((html.match(/cal-swatch/g) || []).length, 4);
    // 日期筛选提示 + 清除按钮
    assert.ok(html.includes("已筛选 09-12（2 份）"), "选中日提示（窄栏用 MM-DD 紧凑格式）");
    assert.ok(html.includes("data-cal-clear"), "应提供清除日期筛选按钮");
});

test("calendarHtml：未选中日 → 提示文案与空态统计", () => {
    const html = calendarHtml([], { month: "2026-09", today: "2026-09-13" });
    assert.ok(html.includes("点有快照的日期可筛选列表"), "未选中日应给操作提示");
    assert.ok(html.includes("本月还没有快照"), "无数据月应给空态统计");
    assert.ok(!html.includes("data-cal-clear"), "未选中日不应有清除按钮");
    // 全部日期格 disabled（空数据）
    const btns = html.match(/<button[^>]*data-cal-day[^>]*>/g) || [];
    assert.equal(btns.length, 30);
    assert.ok(btns.every((b) => b.includes("disabled")), "空数据下所有日期格应 disabled");
});

/* ================= 会话可见性（2026-09-13 第二轮用户实测反馈） =================
   「跳过快照里到底有没有保存，没有保存不应该出现，如果保存没有内容也不应该出现」 */

const SAVED = { session_id: "s-saved", created_at: "2026-09-12T02:00:00", auto: true,
    roots: { "C:\\": { root: "C:\\", snapshot_path: "C:\\snaps\\c.gz", skipped: false },
             "D:\\": { root: "D:\\", snapshot_path: "D:\\snaps\\d.gz", skipped: false } },
    total_by_root: { "C:\\": 1024, "D:\\": 2048 } };
const ALL_SKIPPED = { session_id: "s-skip", created_at: "2026-09-12T16:00:00", auto: true,
    roots: { "C:\\": { root: "C:\\", snapshot_path: null, skipped: true, skip_reason: "already_saved_today" },
             "D:\\": { root: "D:\\", snapshot_path: null, skipped: true, skip_reason: "already_saved_today" } } };
const ZERO_BYTES = { session_id: "s-empty", created_at: "2026-09-12T08:00:00", auto: true,
    roots: { "C:\\": { root: "C:\\", snapshot_path: "C:\\snaps\\e.gz", skipped: false } },
    total_by_root: { "C:\\": 0 } };
const UNKNOWN_SIZE = { session_id: "s-unknown", created_at: "2026-09-11T08:00:00", auto: true,
    roots: { "C:\\": { root: "C:\\", snapshot_path: "C:\\snaps\\u.gz", skipped: false } } };
const NO_ROOTS = { session_id: "s-noroots", created_at: "2026-09-10T08:00:00", auto: true, roots: {} };

test("savedRoots / sessionSavedBytes：只认真的写了盘的条目", () => {
    assert.equal(savedRoots(SAVED).length, 2);
    assert.equal(savedRoots(ALL_SKIPPED).length, 0);
    assert.equal(sessionSavedBytes(SAVED), 3072);
    assert.equal(sessionSavedBytes(ALL_SKIPPED), 0);
    assert.equal(sessionSavedBytes(ZERO_BYTES), 0);
    assert.equal(sessionSavedBytes(null), 0);
    assert.equal(savedRoots(NO_ROOTS).length, 0);
});

test("isMeaningfulSession：① 没保存 → false；② 保存但没内容 → false；③ 大小未知 → 保留", () => {
    assert.equal(isMeaningfulSession(SAVED), true);
    assert.equal(isMeaningfulSession(ALL_SKIPPED), false);   // ① 全盘跳过
    assert.equal(isMeaningfulSession(ZERO_BYTES), false);    // ② 有文件但 0 字节
    assert.equal(isMeaningfulSession(UNKNOWN_SIZE), true);   // ③ 缺 total_by_root → 不误判
    assert.equal(isMeaningfulSession(NO_ROOTS), false);
    assert.equal(isMeaningfulSession(null), false);
});

test("hasKnownSize：区分「已知为 0」与「字段缺失」", () => {
    assert.equal(hasKnownSize(ZERO_BYTES), true);
    assert.equal(hasKnownSize(UNKNOWN_SIZE), false);
    assert.equal(hasKnownSize(ALL_SKIPPED), false);
});

test("splitSessions：保持原顺序拆分，空输入安全", () => {
    const { meaningful, empty, fixture } = splitSessions([ALL_SKIPPED, SAVED, ZERO_BYTES, UNKNOWN_SIZE, NO_ROOTS, null]);
    assert.deepEqual(meaningful.map((s) => s.session_id), ["s-saved", "s-unknown"]);
    assert.deepEqual(empty.map((s) => s.session_id), ["s-skip", "s-empty", "s-noroots"]);
    assert.deepEqual(fixture, []);
    assert.deepEqual(splitSessions(null), { meaningful: [], empty: [], fixture: [] });
    assert.deepEqual(splitSessions([]), { meaningful: [], empty: [], fixture: [] });
});

/* ---- 夹具/测试会话隔离（2026-09-13 第三轮用户实测：「C:\SDK5 这些是测试环境吗」） ---- */

const FIXTURE_SDK = { session_id: "s-sdk", created_at: "2026-09-09T00:25:57", auto: true,
    roots: { "C:\\SDK1": { root: "C:\\SDK1", snapshot_path: "C:\\snaps\\SDK1.snap.gz", skipped: false },
             "C:\\SDK5": { root: "C:\\SDK5", snapshot_path: "C:\\snaps\\SDK5.snap.gz", skipped: false } },
    total_by_root: { "C:\\SDK1": 100, "C:\\SDK5": 100 } };
const FIXTURE_MIXED = { session_id: "s-mixed", created_at: "2026-09-09T00:26:00", auto: true,
    roots: { "C:\\SDK1": { root: "C:\\SDK1", snapshot_path: "C:\\snaps\\SDK1.snap.gz", skipped: false },
             "D:\\": { root: "D:\\", snapshot_path: "D:\\snaps\\d.snap.gz", skipped: false } },
    total_by_root: { "C:\\SDK1": 100, "D:\\": 5000 } };

test("isFixtureSession：全为测试根才算夹具；混入真实盘即不算", () => {
    assert.equal(isFixtureSession(FIXTURE_SDK), true);
    assert.equal(isFixtureSession(FIXTURE_MIXED), false, "含真实盘 D: → 不是夹具");
    assert.equal(isFixtureSession(SAVED), false, "真实 C:/D: 永不误判");
    assert.equal(isFixtureSession(ALL_SKIPPED), false, "无保存项 → 归空会话，不归夹具");
    assert.equal(isFixtureSession(null), false);
    // 其它测试命名
    assert.equal(FIXTURE_ROOT_RE.test("C:\\fixture2"), true);
    assert.equal(FIXTURE_ROOT_RE.test("D:\\pds_fixture_tmp\\x"), true);
    assert.equal(FIXTURE_ROOT_RE.test("E:\\test-data"), true);
    assert.equal(FIXTURE_ROOT_RE.test("C:\\SDKTool"), false, "SDKTool 不是 SDK<数字> 形态");
    assert.equal(FIXTURE_ROOT_RE.test("C:\\"), false);
    assert.equal(FIXTURE_ROOT_RE.test("D:\\data"), false);
});

test("splitSessions：夹具会话单列一组，不混进 meaningful/empty", () => {
    const { meaningful, empty, fixture } = splitSessions([SAVED, FIXTURE_SDK, ALL_SKIPPED, FIXTURE_MIXED, ZERO_BYTES]);
    assert.deepEqual(meaningful.map((s) => s.session_id), ["s-saved", "s-mixed"]);
    assert.deepEqual(fixture.map((s) => s.session_id), ["s-sdk"]);
    assert.deepEqual(empty.map((s) => s.session_id), ["s-skip", "s-empty"]);
});

test("recentListHtml：按时间倒序列最近 N 次，含盘与大小；点条目用 data-cal-day", () => {
    const html = recentListHtml([SAVED, ALL_SKIPPED, FIXTURE_SDK, UNKNOWN_SIZE], { limit: 6 });
    assert.ok(html.includes("最近快照"), "标题");
    assert.ok(html.includes("共 2 次"), "只统计有内容且非夹具的会话");
    assert.ok(!html.includes("s-skip") && !html.includes("SDK1"), "空会话/夹具不出现");
    const days = html.match(/data-cal-day="(\d{4}-\d{2}-\d{2})"/g) || [];
    assert.deepEqual(days, ['data-cal-day="2026-09-12"', 'data-cal-day="2026-09-11"']);
    assert.ok(html.includes("09-12 02:00"), "时间紧凑格式");
    assert.ok(html.includes("C: D:"), "盘符列表");
    assert.ok(html.includes("3.00 KB"), "合计大小（1024+2048 = 3072 B）");
});

test("recentListHtml：limit 生效；无数据给空态；picked 高亮", () => {
    const one = recentListHtml([SAVED, UNKNOWN_SIZE], { limit: 1 });
    assert.equal((one.match(/class="recent-item"/g) || []).length, 1);
    const picked = recentListHtml([SAVED], { picked: "2026-09-12" });
    assert.ok(picked.includes("is-picked"), "选中日高亮");
    const none = recentListHtml([], {});
    assert.ok(none.includes("还没有快照"), "空态文案");
});

test("日历只统计传入（可见）会话：空会话不进热力格", () => {
    const all = [SAVED, ALL_SKIPPED, ZERO_BYTES];
    const { meaningful } = splitSessions(all);
    // 09-12 在全部会话里有 3 份（1 保存 + 1 跳过 + 1 空），可见口径下只剩 1 份
    assert.equal(sessionsByDay(all).get("2026-09-12").count, 3);
    assert.equal(sessionsByDay(meaningful).get("2026-09-12").count, 1);
    assert.equal(calendarStats(all, "2026-09").count, 3);
    assert.equal(calendarStats(meaningful, "2026-09").count, 1);
});
