/* ============================================================
   阶段 A（R0）· 快照夹具生成器 fixture_snapshots.mjs
   - 生成五类快照会话（当前 / 23h / 25h / 8d / 跨盘），全部写入
     隔离数据目录（缺省 %TEMP%\pds_fixture_snapshots_<ts>），
     禁真实 %LOCALAPPDATA%（约定：默认绝不写真实用户目录）。
   - 产出：
     · snapshots/<root>_<ts>_<auto|explicit>_<guid8>.snap.gz
       = gzip 压缩 JSONL：首行 header {format,machine_guid,root,created_at,auto,crc}
       （CRC = zlib.crc32(utf-8 紧凑 JSON{format,machine_guid,root,created_at,auto})，
       与 snapshots.py _header_crc_payload 同源；后随每行 {"p":path,"s":bytes}）
     · session_<ts>_<guid8>_<seq>.json 清单（session.py 结构：
       session_id/auto/machine_guid/roots/ledger_backup/created_at，
       roots 条目 {root,snapshot,snapshot_path,skipped}）
   - 可被 /api/snapshots（读 session_*.json）与 /api/compare（读 .snap.gz）消费：
     启动 Flask 服务前把数据目录指向本夹具根（%LOCALAPPDATA% 重定向
     或 DSA_SNAPSHOT_DIR=夹具根\snapshots + 清单置于夹具根）。
   - 用法：
     node scripts/dev/fixture_snapshots.mjs [--dir <夹具根>] [--now <ISO>]
     --dir  输出夹具根（缺省 %TEMP%\pds_fixture_snapshots_<ts>）
     --now  统一的"当前"参考时刻 ISO 字符串（缺省 datetime.now；用于
            程序化复现固定时间窗口）
   - 输出：各会话摘要 + 夹具根路径（末端一行 FIXTURE_ROOT=...）。
   全程仅标准库（node:fs/node:zlib/node:path），无第三方依赖。
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

/* ---------------- 参数 ---------------- */
function arg(name, dflt) {
    const i = process.argv.indexOf("--" + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const FIXTURE_ROOT = path.resolve(arg("dir", path.join(os.tmpdir(), "pds_fixture_snapshots_" + Date.now())));
const NOW_ISO = arg("now", null);
const NOW = NOW_ISO ? new Date(NOW_ISO) : new Date();
/* --fixture：选择生成哪些场景（P0-4 新增 growth/flat/series；P4 挂账清理新增 tree）
   all(缺省) = 既有五类 + growth + flat + series + tree；也可单独指定一个。 */
const FIXTURE_SEL = (arg("fixture", "all") || "all").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

/* 固定机器 GUID（夹具统一；跨盘/异机测试可覆写，见底部注释） */
const MACHINE_GUID = "3f2a1c9d-0000-4000-8000-00000000f1x7";

const SNAP_DIR = path.join(FIXTURE_ROOT, "snapshots");

/* ---------------- 工具 ---------------- */

function pad(n, w = 2) { return String(n).padStart(w, "0"); }

/* 时刻 → 快照文件名时间戳 YYYYMMDD_HHMMSS（本地时区，与 snapshots.py 同口径） */
function tsOf(d) {
    return (
        d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" +
        pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    );
}
function isoOf(d, timespec = "seconds") {
    const base = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    if (timespec === "seconds") return base;
    return base + "." + pad(d.getMilliseconds(), 3);
}

/* 快照文件头（含 CRC；字段与 snapshots.py _HEADER_FIELDS / _build_header 一致） */
function buildHeader(root, created_at, auto) {
    const header = { format: 1, machine_guid: MACHINE_GUID, root, created_at, auto };
    /* CRC 覆盖负载 = 固定字段序紧凑 JSON（与 _header_crc_payload 同源） */
    const canonical = JSON.stringify(
        { format: header.format, machine_guid: header.machine_guid, root: header.root,
          created_at: header.created_at, auto: header.auto },
        ["format", "machine_guid", "root", "created_at", "auto"]
    );
    header.crc = crc32(Buffer.from(canonical, "utf-8"));
    return header;
}

function crc32(buf) {
    /* zlib.crc32 合成（Node 无直接 API；CRC32 查表实现） */
    let crc = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

/* 快照文件完整内容（gzip JSONL） */
function snapshotBuffer(root, created_at, auto, rows) {
    const header = buildHeader(root, created_at, auto);
    const lines = [JSON.stringify(header)];
    for (const row of rows) lines.push(JSON.stringify(row));
    return zlib.gzipSync(Buffer.from(lines.join("\n") + "\n", "utf-8"));
}

/* 快照文件名（与 snapshots.py _root_name/_make_filename 同型：
   Path(root).name，盘根空名回退 rstrip("\\/:")；再净化非法字符） */
function snapshotName(root, d, mode) {
    const parsed = path.parse(String(root));
    let name = parsed.name || String(root).replace(/[\\/:]+$/, "");
    name = name.replace(/[<>:"/\\|?*]/g, "_").replace(/[.\s]+$/, "") || "root";
    return `${name}_${tsOf(d)}_${mode}_${MACHINE_GUID.slice(0, 8).toLowerCase()}.snap.gz`;
}

/* ---------------- 五类会话数据 ---------------- */

/* 行集合（路径→大小）。每份快照含根行 + 一级子目录行（compare 口径够用） */
function cRows(scale) {
    return [
        { p: "C:\\", s: 100 * scale },
        { p: "C:\\Windows", s: 60 * scale },
        { p: "C:\\Users", s: 38 * scale },
        { p: "C:\\Program Files", s: 2 * scale },
    ];
}
function dRows(scale) {
    return [
        { p: "D:\\", s: 200 * scale },
        { p: "D:\\data", s: 150 * scale },
        { p: "D:\\docs", s: 45 * scale },
        { p: "D:\\backup", s: 5 * scale },
    ];
}
function eRows(scale) {
    return [
        { p: "E:\\", s: 50 * scale },
        { p: "E:\\media", s: 40 * scale },
        { p: "E:\\iso", s: 10 * scale },
    ];
}

/* 组装一个会话：{name, at, auto, groups: [{root, rows}]} */
function session(name, at, auto, groups) {
    return { name, at, auto, groups };
}
const SESSIONS = [
    /* 当前会话（最近；较昨日/较上周基线窗口均落空——同刻空态对照） */
    session("current", NOW, true, [
        { root: "C:\\", rows: cRows(100) },
        { root: "D:\\", rows: dRows(100) },
    ]),
    /* 23h 前（较昨日窗口 0<Δt≤24h 命中基线） */
    session("23h", new Date(NOW.getTime() - 23 * 3600e3), false, [
        { root: "C:\\", rows: cRows(90) },
        { root: "D:\\", rows: dRows(95) },
    ]),
    /* 25h 前（较昨日窗口未命中、较上周 (24h,7d] 命中） */
    session("25h", new Date(NOW.getTime() - 25 * 3600e3), false, [
        { root: "C:\\", rows: cRows(85) },
        { root: "D:\\", rows: dRows(90) },
    ]),
    /* 8d 前（(24h,7d] 窗口外——较上周不命中；跨周空态对照） */
    session("8d", new Date(NOW.getTime() - 8 * 24 * 3600e3), false, [
        { root: "C:\\", rows: cRows(50) },
        { root: "D:\\", rows: dRows(60) },
    ]),
    /* 跨盘（E:\ 单独会话；对比跨盘基线选择时应提示拒绝） */
    session("cross-drive", new Date(NOW.getTime() - 2 * 3600e3), false, [
        { root: "E:\\", rows: eRows(100) },
    ]),
];

/* ---------------- P0-4 新增三类对比夹具 ----------------
   growth（复现问题 5、6）：同一根 D:\ 两个时刻，含正/负/零增量混合，
     且存在 ≥4 层深目录链（apps>framework>core>engine），用于对比页
     深度聚合/下钻判据。
   flat（复现问题 6 的「全 0 增量」）：两个时刻完全一致。
   series（复现问题 8 的多快照趋势）：同一根 D:\ 6 个时刻递进总量。 */

/* D:\ 深层目录链：apps(1)>framework(2)>core(3)>engine(4) */
function growthRows0() {
    return [
        { p: "D:\\", s: 1000 },
        { p: "D:\\apps", s: 500 },
        { p: "D:\\apps\\framework", s: 300 },
        { p: "D:\\apps\\framework\\core", s: 200 },
        { p: "D:\\apps\\framework\\core\\engine", s: 120 },          // 第 4 层
        { p: "D:\\apps\\framework\\core\\engine\\lib.dll", s: 100 }, // 第 5 层文件
        { p: "D:\\apps\\framework\\core\\engine\\conf.bin", s: 20 },
        { p: "D:\\data", s: 300 },          // 零增量（t0=t1）
        { p: "D:\\data\\docs", s: 150 },
        { p: "D:\\docs", s: 200 },          // 负增量（t1 缩）
        { p: "D:\\docs\\old", s: 150 },
    ];
}
function growthRows1() {
    return [
        { p: "D:\\", s: 1050 },             // 总量 +50（正）
        { p: "D:\\apps", s: 600 },          // +100（正）
        { p: "D:\\apps\\framework", s: 380 },
        { p: "D:\\apps\\framework\\core", s: 280 },
        { p: "D:\\apps\\framework\\core\\engine", s: 200 },          // 第 4 层 +80
        { p: "D:\\apps\\framework\\core\\engine\\lib.dll", s: 170 },
        { p: "D:\\apps\\framework\\core\\engine\\conf.bin", s: 30 },
        { p: "D:\\data", s: 300 },          // 零增量（不变）
        { p: "D:\\data\\docs", s: 150 },
        { p: "D:\\docs", s: 150 },          // 负增量（-50）
        { p: "D:\\docs\\old", s: 100 },
    ];
}
function flatRows(scale) {
    return [
        { p: "D:\\", s: 800 * scale },
        { p: "D:\\flat", s: 400 * scale },
        { p: "D:\\flat\\a", s: 250 * scale },
        { p: "D:\\flat\\a\\b", s: 150 * scale },
        { p: "D:\\flat\\a\\b\\c", s: 100 * scale },
        { p: "D:\\flat\\a\\b\\c\\file.dat", s: 100 * scale },
    ];
}
function seriesRows(k) {
    /* k=0..5，总量随 k 线性递进（trend 判据） */
    const base = 100 + k * 25;
    return [
        { p: "D:\\", s: base * 10 },
        { p: "D:\\series", s: base * 6 },
        { p: "D:\\series\\one", s: base * 3 },
        { p: "D:\\series\\one\\two", s: base * 2 },
        { p: "D:\\series\\one\\two\\file.bin", s: base },
    ];
}

/* P4 挂账清理：**树一致**夹具（父 = 直接子项之和，逐层闭合）。
   既有 growth/flat 为合成数据（父 ≠ 子和，例如 apps=500 而唯一子键 framework=300），
   深度聚合在「被折叠祖先的直属字节」上会留下残差，探针判据须写作
   `Σ(行) + 残差 == delta_total`。本夹具让残差**恒为 0**（任意 depth 均成立），
   使 `Σ(聚合行 delta) == delta_total` 可以在干净数据上被正向断言。
   校验（t0/t1 均闭合）：600=200+400、400=250+150、1000=600+400；
   700=220+480、480=300+180、1150=700+450。 */
function treeRows(scale) {
    const v = (x) => x * scale;
    return [
        { p: "D:\\", s: v(1000) },
        { p: "D:\\tree", s: v(1000) },
        { p: "D:\\tree\\app", s: v(600) },
        { p: "D:\\tree\\app\\a.bin", s: v(200) },
        { p: "D:\\tree\\app\\sub", s: v(400) },
        { p: "D:\\tree\\app\\sub\\x.bin", s: v(250) },
        { p: "D:\\tree\\app\\sub\\y.bin", s: v(150) },
        { p: "D:\\tree\\data", s: v(400) },
        { p: "D:\\tree\\data\\c.bin", s: v(400) },
    ];
}
function treeRows1() {
    /* t1：app +100（a.bin +20 / sub +80；sub 内 x.bin +50 / y.bin +30）、
       data +50（c.bin +50）、根 +150——逐层仍闭合 */
    return [
        { p: "D:\\", s: 1150 },
        { p: "D:\\tree", s: 1150 },
        { p: "D:\\tree\\app", s: 700 },
        { p: "D:\\tree\\app\\a.bin", s: 220 },
        { p: "D:\\tree\\app\\sub", s: 480 },
        { p: "D:\\tree\\app\\sub\\x.bin", s: 300 },
        { p: "D:\\tree\\app\\sub\\y.bin", s: 180 },
        { p: "D:\\tree\\data", s: 450 },
        { p: "D:\\tree\\data\\c.bin", s: 450 },
    ];
}

const P0_SESSIONS = [];
/* 时间偏移（hours before NOW）保证所有 D:\ 快照时间戳两两互异，且避开既有
   五类的 D/C 时间戳（否则 <root>_<ts>_explicit_<guid>.snap.gz 相撞被覆盖）：
   · 既有五类 D/C: 偏移 {0,23,25}（今日 C/D 20:00、昨日 21:00/19:00）、8d（08-31）
   · E: 偏移 2h（今日 18:00，不同盘无影响）
   · growth-t0=27h→09-07 17:00；growth-t1=3h→09-08 17:00
   · flat-a=33h→09-07 11:00；flat-b=9h→09-08 11:00
   · series-1..6=21,17,13,7,5,1h→09-07 23:00、09-08 03/07/13/15/19:00
   全部互异且与五类不撞。 */

/* growth：两个会话（t0 基准、t1 增量），deep 链正增量 + data 零 + docs 负 */
P0_SESSIONS.push(
    session("growth-t0", new Date(NOW.getTime() - 27 * 3600e3), false, [
        { root: "D:\\", rows: growthRows0() },
    ]),
    session("growth-t1", new Date(NOW.getTime() - 3 * 3600e3), false, [
        { root: "D:\\", rows: growthRows1() },
    ])
);
/* flat：两个会话完全一致（全 0 增量） */
P0_SESSIONS.push(
    session("flat-a", new Date(NOW.getTime() - 33 * 3600e3), false, [
        { root: "D:\\", rows: flatRows(1) },
    ]),
    session("flat-b", new Date(NOW.getTime() - 9 * 3600e3), false, [
        { root: "D:\\", rows: flatRows(1) },
    ])
);
/* series：同根 D:\ 6 个时刻递进总量（趋势判据） */
const SERIES_H = [21, 17, 13, 7, 5, 1]; // hours  09-07 23:00, 09-08 03/07/13/15/19:00
for (let k = 0; k < 6; k++) {
    P0_SESSIONS.push(
        session("series-" + (k + 1), new Date(NOW.getTime() - SERIES_H[k] * 3600e3), false, [
            { root: "D:\\", rows: seriesRows(k) },
        ])
    );
}
/* P4：tree 树一致夹具（两时刻；偏移 39h/15h 与既有全部 D:\ 时间戳互异） */
P0_SESSIONS.push(
    session("tree-t0", new Date(NOW.getTime() - 39 * 3600e3), false, [
        { root: "D:\\", rows: treeRows(1) },
    ]),
    session("tree-t1", new Date(NOW.getTime() - 15 * 3600e3), false, [
        { root: "D:\\", rows: treeRows1() },
    ])
);

/* 选择待写会话：默认 all = 既有五类 + P0 三类（+ P4 tree） */
function selectedSessions() {
    const want = FIXTURE_SEL;
    if (want.includes("all")) return { classic: SESSIONS, p0: P0_SESSIONS };
    const out = { classic: [], p0: [] };
    for (const s of SESSIONS) if (want.includes(s.name)) out.classic.push(s);
    for (const s of P0_SESSIONS) if (want.includes(s.name) || (s.name.startsWith("growth") && want.includes("growth")) || (s.name.startsWith("flat") && want.includes("flat")) || (s.name.startsWith("series") && want.includes("series")) || (s.name.startsWith("tree") && want.includes("tree"))) out.p0.push(s);
    return out;
}

/* ---------------- 写入 ---------------- */

fs.mkdirSync(SNAP_DIR, { recursive: true });
let seq = 0;
const written = [];
const ALL_TO_WRITE = [...selectedSessions().classic, ...selectedSessions().p0];

for (const s of ALL_TO_WRITE) {
    const sessionId = `session_${tsOf(s.at)}_${MACHINE_GUID.slice(0, 8).toLowerCase()}_${pad(++seq, 6)}.json`;
    const rootsPayload = {};
    let anySkipped = false;
    for (const g of s.groups) {
        const fname = snapshotName(g.root, s.at, s.auto ? "auto" : "explicit");
        const fpath = path.join(SNAP_DIR, fname);
        fs.writeFileSync(fpath, snapshotBuffer(g.root, isoOf(s.at), s.auto, g.rows));
        rootsPayload[g.root] = {
            root: g.root,
            snapshot: fname,
            snapshot_path: fpath,
            skipped: false,
        };
        written.push(fpath);
    }
    const sessionPayload = {
        session_id: sessionId,
        auto: s.auto,
        machine_guid: MACHINE_GUID,
        roots: rootsPayload,
        ledger_backup: {},
        created_at: isoOf(s.at),
    };
    const sfile = path.join(FIXTURE_ROOT, sessionId);
    fs.writeFileSync(sfile, JSON.stringify(sessionPayload, null, 2), "utf-8");
    written.push(sfile);
    console.log(`[fixture] ${s.name.padEnd(10)} at=${isoOf(s.at)} auto=${s.auto} roots=${s.groups.map((g) => g.root).join(",")} session=${sessionId}`);
}

/* 摘要输出 */
console.log(`\n[fixture] 写入文件 ${written.length} 个：`);
written.forEach((f) => console.log("  " + f));
console.log(`\n[fixture] 快照目录: ${SNAP_DIR}`);
console.log(`[fixture] 数据目录根: ${FIXTURE_ROOT}`);
console.log(`FIXTURE_ROOT=${FIXTURE_ROOT}`);