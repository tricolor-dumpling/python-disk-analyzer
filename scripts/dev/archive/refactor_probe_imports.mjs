/* ============================================================
   P0-3 · refactor_probe_imports.mjs —— 既有探针引入路径一次性改造
   - 把 41 支 u2x–u6x 探针中硬编码的
       require("C:/Users/26024/.dsh/profiles/web/node_modules/playwright")
     改为从 ./_harness.mjs 导入（chromium 为 Proxy 包装，launch 自动
     注入 executablePath；channel 存在时不注入，兼容 msedge）。
   - 规则（严守「只改引入路径、不改断言」）：
     · Case A（全文件仅 1 处 require 且为 playwright）：删除
       createRequire 块，整体替换为 import { chromium, launch }。
     · Case B（u43 等还 require 其它 node 内置模块）：保留
       createRequire/require，仅把 playwright require 行换成
       import { chromium, launch } from "./_harness.mjs"。
   - 幂等：已改造（无 26024 字样）的文件跳过。
   - 用法：node scripts/dev/refactor_probe_imports.mjs [--check]
     --check 只报告将改动的文件与是否可安全改造，不写盘。
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECK = process.argv.indexOf("--check") >= 0;
const HARD = "C:/Users/26024/.dsh/profiles/web/node_modules/playwright";

const createRequireBlock = 'import { createRequire } from "node:module";';
const requireLine = 'const require = createRequire(import.meta.url);';
const pwRequire = `const { chromium } = require("${HARD}");`;
const harnessImport = 'import { chromium, launch } from "./_harness.mjs";';

/* 行尾无关的整块重写（CRLF/LF 均可），不假设 createRequire 与 require 相邻：
   Step 1  删除 import { createRequire } 行（若已无 require 使用）
   Step 2  把「const require = createRequire(import.meta.url);」+ 紧跟的
           「const { chromium } = require("<HARD>");」换成 harness 导入
   Step 3  若文件顶部 import 区尚无数据引入，在首个 import 后插入 harness 导入
   注：u43 等还 require 其它 node 内置模块（fs/path）——它们不删 createRequire。 */
const importCreateRequireRe = /^import \{ createRequire \} from "node:module";[ \t]*[\r\n]+/m;
const requireAssignRe = /^const require = createRequire\(import\.meta\.url\);[ \t]*[\r\n]+/m;
const pwRequireLineRe = new RegExp(
    '^const \\{ chromium \\} = require\\("' + HARD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\);' +
    '[ \t]*[\r\n]+', "m"
);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".mjs"));
const changed = [], skipped = [];

for (const f of files) {
    const p = path.join(DIR, f);
    let src = fs.readFileSync(p, "utf8");
    if (!src.includes(HARD)) continue; // 已改造或无硬编码
    if (f.startsWith("_harness") || f.startsWith("refactor_probe_imports")) { skipped.push(f + ":tool-self"); continue; }

    const requireCalls = (src.match(/require\(/g) || []).length;
    const hasRequireAssign = requireAssignRe.test(src);
    if (!hasRequireAssign) { skipped.push(f + ":no-require-assign"); continue; }

    if (CHECK) { changed.push(f + " (requireCalls=" + requireCalls + ")"); continue; }

    /* 替换 playwright require 两行 → harness 导入 */
    const pairRe = new RegExp(
        requireAssignRe.source + pwRequireLineRe.source, "m"
    );
    if (!pairRe.test(src)) { skipped.push(f + ":pw-pair-mismatch"); continue; }
    src = src.replace(pairRe, harnessImport + "\n");

    /* 若已无任何 require(...) 使用，删除 createRequire import（避免未用导入） */
    if ((src.match(/require\(/g) || []).length === 0) {
        src = src.replace(importCreateRequireRe, "");
    }

    fs.writeFileSync(p, src, "utf8");
    changed.push(f + (requireCalls === 1 ? " (A)" : " (B)"));
}

console.log((CHECK ? "[check] " : "") + "changed=" + changed.length);
changed.forEach((c) => console.log("  " + c));
console.log("skipped=" + skipped.length);
skipped.forEach((s) => console.log("  " + s));