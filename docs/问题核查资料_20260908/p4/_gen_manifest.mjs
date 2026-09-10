/* ============================================================
   阶段 P4 · 证据清单生成器 _gen_manifest.mjs
   用途：为 docs/问题核查资料_20260908/p4/ 下全部证据生成 manifest.json
        （每项含绝对路径 / 用途 / 采样节奏 / 时间窗 / 量化摘要 / SHA-256）。
   量化摘要来源：layout-<label>.json（逐视口逐态 DOM + 报告）与
        api-<label>.json（逐请求 depth 入参/行数/零行/汇总/Σ/残差）。
   用法：node docs/问题核查资料_20260908/p4/_gen_manifest.mjs
   ============================================================ */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("docs/问题核查资料_20260908/p4");
const rel = (p) => path.relative(DIR, p).replace(/\\/g, "/");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readJsonSafe(file) {
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "")); } catch (e) { return null; }
}

const layout = { prefix: readJsonSafe(path.join(DIR, "baseline_prefix", "layout-prefix.json")),
                 postfix: readJsonSafe(path.join(DIR, "postfix", "layout-postfix.json")) };
const api = { prefix: readJsonSafe(path.join(DIR, "baseline_prefix", "api-prefix.json")),
              postfix: readJsonSafe(path.join(DIR, "postfix", "api-postfix.json")) };
const summary = { prefix: readJsonSafe(path.join(DIR, "baseline_prefix", "summary-prefix.json")),
                  postfix: readJsonSafe(path.join(DIR, "postfix", "summary-postfix.json")) };

const STATE_ZH = {
    "growth-depth1": "growth 夹具 depth=1（深度聚合）",
    "growth-depth2-drill": "growth 夹具 depth=2 + 行点击下钻",
    "flat-empty": "flat 夹具零增量空态",
    "growth-default": "growth 夹具正负增量默认口径（叶子）",
};

/* 逐图量化摘要：从对应 label 的 layout JSON 里按 视口+态 取样本 */
function quantFor(label, file) {
    const m = /^compare-(.+-[0-9]+x[0-9]+)\.png$/.exec(file);
    if (!m) return null;
    const key = m[1];
    const idx = key.lastIndexOf("-");
    const state = key.slice(0, idx);
    const vp = key.slice(idx + 1);
    const doc = layout[label];
    if (!doc) return null;
    const s = (doc.samples || []).find((x) => x.state === state && (x.vw + "x" + x.vh) === vp);
    if (!s) return null;
    const rows = (s.report && s.report.rows) || [];
    return {
        state: state, state_zh: STATE_ZH[state] || state, viewport: vp,
        request_depth: s.report ? s.report.depth : null,
        request_payload: s.requestPost ? JSON.parse(s.requestPost) : null,
        api_rows: rows.length,
        rows_total: s.report ? s.report.rows_total : null,
        zero_count: s.report ? s.report.zero_count : null,
        zero_total: s.report ? s.report.zero_total : null,
        table_rows_rendered: s.dom ? s.dom.tableRows : null,
        summary_cards: s.dom ? s.dom.summary.map((c) => ({ label: c.label, target: c.target, text: c.text })) : null,
        delta_total: s.report ? s.report.delta_total : null,
        sum_row_delta: rows.reduce((a, r) => a + r.delta, 0),
        row_deltas: rows.map((r) => r.delta),
        row_paths: rows.map((r) => r.path),
        crumb: s.dom ? s.dom.crumbText : null,
        empty_text: s.dom ? s.dom.emptyText : null,
    };
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

const files = walk(DIR).filter((p) => !p.endsWith("manifest.json")).sort();
const items = files.map((p) => {
    const r = rel(p);
    const isPost = r.startsWith("postfix/");
    const isPre = r.startsWith("baseline_prefix/");
    const label = isPost ? "postfix" : isPre ? "prefix" : null;
    const item = {
        path: p.replace(/\\/g, "\\"),
        rel: r,
        bytes: fs.statSync(p).size,
        mtime: fs.statSync(p).mtime.toISOString(),
        sha256: sha256(p),
        role: null, purpose: null, cadence: null, window: null, quant: null,
    };
    if (/\.png$/.test(r)) {
        item.role = isPost ? "C 类关键帧（修复后）" : "红线 A 修复前基线帧";
        item.purpose = isPost
            ? "修复后对比页深度/零增量/下钻像素证据（逐张 read_image 判读）"
            : "修复前（stage-p3 d37627e）现采基线：depth 控件缺失、零增量仍入榜";
        item.cadence = "3 视口（1366×768 / 1440×900 / 1920×1080）× 4 态，每态 1 帧（headless Chromium，viewport 截图）";
        item.window = isPost
            ? "2026-09-10 会话内 stage-p4 代码；夹具时间窗 2026-09-07T17:00 → 2026-09-08T17:00（growth）/ 09-07T11:00 → 09-08T11:00（flat）"
            : "2026-09-10 会话内 stage-p3 代码（d37627e）现采，同一夹具与同一 harness";
        item.quant = quantFor(label, path.basename(p));
    } else if (/^api-(prefix|postfix)\.json$/.test(path.basename(p))) {
        item.role = "API 层逐请求量化";
        item.purpose = "/api/compare 的 depth 入参 / 返回行数 / 零行 / 汇总字段 / Σ(行delta) / 残差 / delta_total";
        item.cadence = "9 组参数组合，每组 1 次真实 HTTP 请求（同一 harness 进程）";
        item.window = isPost ? "stage-p4 代码" : "stage-p3 代码（d37671e 起点基线）".replace("d37671e", "d37627e");
        const doc = api[label];
        item.quant = doc ? {
            cases: doc.cases.length,
            violations: doc.cases.reduce((a, c) => a + c.judges.filter((j) => !j.pass).length, 0),
            per_case: doc.cases.map((c) => ({
                key: c.key, httpStatus: c.httpStatus, rows: c.rowCount, zeroRows: c.zeroRows,
                sumDelta: c.sumDelta, residue: c.residue, deltaTotal: c.deltaTotalRaw,
                depthEcho: c.depthField === undefined ? null : c.depthField,
            })),
        } : null;
    } else if (/^layout-(prefix|postfix)\.json$/.test(path.basename(p))) {
        item.role = "逐视口逐态 DOM 量化";
        item.purpose = "控件存在性/取值、表格渲染行数、摘要三卡值、面包屑、空态文案、可下钻行数";
        item.cadence = "3 视口 × 4 态 = 12 样本";
        item.window = isPost ? "stage-p4 代码" : "stage-p3 代码（d37627e）";
        const doc = layout[label];
        item.quant = doc ? {
            samples: doc.samples.length,
            per_sample: doc.samples.map((s) => ({
                key: s.state + "@" + s.vw + "x" + s.vh,
                depthControl: s.dom.depthControl, depthValue: s.dom.depthValue,
                hideZeroControl: s.dom.hideZeroControl, tableRows: s.dom.tableRows,
                apiRows: ((s.report && s.report.rows) || []).length,
                crumb: s.dom.crumbText, empty: (s.dom.emptyText || "").slice(0, 60),
            })),
        } : null;
    } else if (/^summary-(prefix|postfix)\.json$/.test(path.basename(p))) {
        item.role = "判定汇总";
        item.purpose = "J1–J8 违规计数、逐态明细、console 错误、关键帧清单";
        item.cadence = "每次探针运行 1 份";
        item.window = isPost ? "stage-p4 代码" : "stage-p3 代码（d37627e）";
        const doc = summary[label];
        item.quant = doc ? doc.totals : null;
    } else if (/^harness-(prefix|postfix)\.log$/.test(path.basename(p))) {
        item.role = "harness 运行日志";
        item.purpose = "夹具对比服务启动信息（隔离数据目录、快照目录、夹具 GUID、当前侧行数）";
        item.cadence = "每次探针运行 1 份";
        item.window = isPost ? "stage-p4 代码" : "stage-p3 代码（d37627e）";
        const txt = fs.readFileSync(p, "utf-8");
        const ready = /HARNESS_READY[^\r\n]*/.exec(txt);
        item.quant = { ready_line: ready ? ready[0] : null };
    } else if (/^backcompat-postfix\.txt$/.test(path.basename(p))) {
        item.role = "契约证伪自证输出";
        item.purpose = "不传 depth 时引擎输出与 stage-p3 引擎逐字段相等（7 字段组 / 10 用例 / 53 行）";
        item.cadence = "1 次（每变更集后复跑）";
        item.window = "stage-p3 vs stage-p4（同夹具同数据）";
        const txt = fs.readFileSync(p, "utf-8");
        item.quant = { verdict: /BACKCOMPAT-VERDICT: (\w+)/.exec(txt)?.[1] || null,
                       lines: txt.split("\n").filter((l) => l.includes("[PASS]") || l.includes("[FAIL]")).length };
    } else if (/^redline_b_datadir\.txt$/.test(path.basename(p))) {
        item.role = "红线 B 复核输出";
        item.purpose = "用户真实数据目录跑测前后「清单 + 尺寸 + mtime」零变化";
        item.cadence = "1 次（全部跑测结束后）";
        item.window = "基线 2026-09-10 19:48 采集 → 收尾复核";
        const txt = fs.readFileSync(p, "utf-8");
        item.quant = { verdict: /红线 B：(\w+)/.exec(txt)?.[1] || null,
                       before: (/基线（跑测前） : ([^\r\n]+)/.exec(txt) || [])[1] || null,
                       after: (/收尾（跑测后） : ([^\r\n]+)/.exec(txt) || [])[1] || null,
                       diff: (/新增=\d+[^\r\n]*/.exec(txt) || [])[0] || null };
    } else if (/_fixture_compare_server\.py$/.test(path.basename(p))) {
        item.role = "夹具 harness（证据侧，非生产代码）";
        item.purpose = "真实 Flask 应用 + 夹具数据源（fullscan.result/status 替换），用于确定性复现；隔离 LOCALAPPDATA/DSA_SNAPSHOT_DIR";
        item.cadence = "探针运行期间常驻（探针自拉自收）";
        item.window = "—";
    } else if (/_verify_backcompat\.py$/.test(path.basename(p))) {
        item.role = "契约证伪脚本";
        item.purpose = "git show stage-p3:compare.py 取修复前引擎，同进程逐字段比对默认参数输出";
        item.cadence = "按需（每变更集后）";
        item.window = "—";
    } else if (/_verify_datadir_redline\.mjs$/.test(path.basename(p))) {
        item.role = "红线 B 复核脚本";
        item.purpose = "真实数据目录清单/尺寸/mtime 三口径对照（复用 P3 同名脚本口径）";
        item.cadence = "跑测前后各 1 次";
        item.window = "—";
    } else if (/_datadir_baseline_prerun\.json$/.test(path.basename(p))) {
        item.role = "红线 B 基线";
        item.purpose = "跑测前真实数据目录清单快照（PowerShell ConvertTo-Json 写出）";
        item.cadence = "1 次（跑测前）";
        item.window = "2026-09-10T19:48 采集";
    } else if (/_gen_manifest\.mjs$/.test(path.basename(p))) {
        item.role = "清单生成器";
        item.purpose = "生成本 manifest（含 SHA-256 与量化摘要）";
        item.cadence = "每次证据更新后 1 次";
        item.window = "—";
    } else {
        item.role = "其它";
        item.purpose = "—";
        item.cadence = "—";
        item.window = "—";
    }
    return item;
});

/* 图片哈希分组（同哈希 = 同像素，用于自证「哪些帧是同一证据」） */
const byHash = {};
for (const it of items.filter((i) => /\.png$/.test(i.rel))) {
    (byHash[it.sha256] = byHash[it.sha256] || []).push(it.rel);
}
const dupGroups = Object.entries(byHash).filter(([, v]) => v.length > 1)
    .map(([h, v]) => ({ sha256: h, files: v }));

const manifest = {
    stage: "P4（对比深度选择 + 聚合 + 下钻 / 零增量过滤）",
    generated_at: new Date().toISOString(),
    repo: "D:\\deepseek\\python-disk-analyzer",
    branch: "stage-p4",
    baseline_ref: "stage-p3 @ d37627e（tag p3-rail-layout）",
    fixture: {
        generator: "node scripts/dev/fixture_snapshots.mjs --dir %TEMP%\\pds_p4_iso\\home\\PythonDiskScanner --now 2026-09-08T20:00:00 --fixture growth,flat",
        snapshots: [
            "D_20260907_170000_explicit_3f2a1c9d.snap.gz（growth-t0 基线）",
            "D_20260908_170000_explicit_3f2a1c9d.snap.gz（growth-t1 当前侧）",
            "D_20260907_110000_explicit_3f2a1c9d.snap.gz（flat-a 基线）",
            "D_20260908_110000_explicit_3f2a1c9d.snap.gz（flat-b 当前侧，与 a 完全一致）",
        ],
        isolation: "LOCALAPPDATA 与 DSA_SNAPSHOT_DIR 双隔离于 %TEMP%；红色 B 复核见 redline_b_datadir.txt",
    },
    counts: {
        files: items.length,
        images: items.filter((i) => /\.png$/.test(i.rel)).length,
        images_postfix: items.filter((i) => i.rel.startsWith("postfix/") && /\.png$/.test(i.rel)).length,
        images_prefix: items.filter((i) => i.rel.startsWith("baseline_prefix/") && /\.png$/.test(i.rel)).length,
        duplicate_hash_groups: dupGroups.length,
    },
    duplicate_hash_groups: dupGroups,
    items: items,
};

fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
console.log("manifest=" + path.join(DIR, "manifest.json"));
console.log("files=" + manifest.counts.files + " images=" + manifest.counts.images +
    " (postfix=" + manifest.counts.images_postfix + ", prefix=" + manifest.counts.images_prefix + ")");
console.log("duplicate_hash_groups=" + dupGroups.length);
for (const g of dupGroups) console.log("  [" + g.sha256.slice(0, 12) + "] " + g.files.join(" , "));
