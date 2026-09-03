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

/* ---------------- 写入 ---------------- */

fs.mkdirSync(SNAP_DIR, { recursive: true });
let seq = 0;
const written = [];

for (const s of SESSIONS) {
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