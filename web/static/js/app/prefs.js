/* ============================================================
   UI 2.0（SpaceLens Pro）· prefs.js（2026-09-13 用户实测反馈新增）

   「记录部分使用设置」——**使用偏好**统一登记与持久化层。

   背景：改造前用户的选择散落三处且各有各的寿命：
     ① 后端 config.json（auto_save / last_roots / theme）——持久，但只有 3 项；
     ② localStorage 散键（pds_theme_v1 / pds_selected_drives_v1 / pds_last_browse_v1）
        ——持久，但键名/校验各自为政；
     ③ APP_STATE（view.mode / view.mergeTop / compare.depth / compare.hideZero /
        list.kind / list.sort）——**刷新即丢**，重开页面永远回到默认（本次修的就是这批）。
   本模块提供第 ④ 类：**单一 localStorage 文档（pds_prefs_v1）+ 白名单注册表**，
   读写都过注册表校验（未登记 id 不落盘、类型/枚举/范围不合法回落默认），
   出错一律静默降级为默认值（存储不可用也不影响功能）。

   ⚠️ 边界（与红线一致）：
   - 只依赖 state.js（叶子模块），**不 import 任何页面模块** → 零环；
     把偏好「应用」到页面控件由调用方（pages/*、components/settings.js）负责；
   - 不碰后端：`/api/settings` 白名单（auto_save/last_roots/theme）保持原样，
     UI 偏好不进 config.json（避免每次点视图切一次盘）。
   - 清空数据目录（wipe）**不清**使用偏好——偏好是用户习惯而非扫描数据
     （与既有「pds_theme_v1 恢复出厂保留」同口径）。

   注册表字段：id / group / label / hint / def / options（枚举）| min,max（数值）。
   ============================================================ */

import { APP_STATE } from "./state.js";

export const PREFS_KEY = "pds_prefs_v1";
export const PREFS_VERSION = 1;

const VIEW_MODE_TEXT = { treemap: "矩形图", ranking: "排行", table: "表格", relate: "关系" };
const LIST_KIND_TEXT = { all: "全部", dir: "仅目录", file: "仅文件" };
const LIST_SORT_TEXT = { "size-desc": "按大小（降序）", "name-asc": "按名称", "size-asc": "大小最小" };

/* 白名单注册表 = 单一事实源（设置弹窗的「使用偏好」区直接由它渲染） */
export const PREF_REGISTRY = [
    {
        id: "view.mode", group: "工作台", label: "默认视图", def: "treemap",
        hint: "打开工作台时使用的视图（矩形图 / 排行 / 表格 / 关系）",
        options: ["treemap", "ranking", "table", "relate"], optionText: VIEW_MODE_TEXT,
    },
    {
        id: "view.mergeTop", group: "工作台", label: "矩形图合并阈值", def: 24,
        hint: "超过该数量的子项合并进「其他」色块（1–200，工具栏 ± 步长 10）",
        min: 1, max: 200,
    },
    {
        id: "list.kind", group: "列表", label: "默认内容类型", def: "all",
        hint: "排行 / 表格视图的类型筛选（全部 / 仅目录 / 仅文件）",
        options: ["all", "dir", "file"], optionText: LIST_KIND_TEXT,
    },
    {
        id: "list.sort", group: "列表", label: "默认排序", def: "size-desc",
        hint: "排行 / 表格视图的排序方式",
        options: ["size-desc", "name-asc", "size-asc"], optionText: LIST_SORT_TEXT,
    },
    {
        id: "compare.depth", group: "对比", label: "默认对比深度", def: "",
        hint: "空间对比页的深度聚合口径（叶子 = 逐目录；1–5 层 = 聚合到第 N 层）",
        options: ["", "1", "2", "3", "4", "5"],
        optionText: { "": "叶子（默认）", 1: "1 层", 2: "2 层", 3: "3 层", 4: "4 层", 5: "5 层" },
    },
    {
        id: "compare.hideZero", group: "对比", label: "默认隐藏零变化", def: true,
        hint: "空间对比页默认过滤 delta=0 的条目（避免零行补位）",
    },
];

const REG_BY_ID = new Map(PREF_REGISTRY.map((r) => [r.id, r]));

export function prefDef(id) { return REG_BY_ID.get(id) || null; }

/* ---- 存储读写（任何异常 → 空对象/静默，功能不受影响） ---- */

function readDoc() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return {};
        const doc = JSON.parse(raw);
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
        const values = doc.values;
        return values && typeof values === "object" && !Array.isArray(values) ? values : {};
    } catch (e) {
        return {};
    }
}

function writeDoc(values) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, values: values }));
        return true;
    } catch (e) {
        return false; // 存储不可用/超配额：本次会话内行为不受影响（仅不持久）
    }
}

/* 值清洗：按注册表定义校验；不合法 → 返回 undefined（调用方回落默认）。
   ⚠️ 必须先判 undefined/null：`compare.depth` 的合法枚举**包含空串**
   （"" = 叶子口径），若不先拦，「未存储」会被 String(undefined) 化成 ""
   而误判为「已显式存储」（storedPrefIds 会把它算成用户自定义项）。 */
function coerce(def, value) {
    if (!def || value === undefined || value === null) return undefined;
    if (Array.isArray(def.options)) {
        const v = typeof value === "number" ? value : String(value == null ? "" : value);
        return def.options.indexOf(v) === -1 ? undefined : v;
    }
    if (typeof def.def === "boolean") {
        return typeof value === "boolean" ? value : undefined;
    }
    if (typeof def.def === "number") {
        const n = Math.floor(Number(value));
        if (!Number.isFinite(n)) return undefined;
        const min = typeof def.min === "number" ? def.min : -Infinity;
        const max = typeof def.max === "number" ? def.max : Infinity;
        return Math.max(min, Math.min(max, n));
    }
    return typeof value === "string" ? value : undefined;
}

/* ---- 对外 API ---- */

/* 读单个偏好（未设置/非法 → 注册表默认值；未登记 id → null） */
export function getPref(id) {
    const def = REG_BY_ID.get(id);
    if (!def) return null;
    const clean = coerce(def, readDoc()[id]);
    return clean === undefined ? def.def : clean;
}

/* 写单个偏好（未登记 id 静默忽略并返回 false；写入成功返回 true） */
export function setPref(id, value) {
    const def = REG_BY_ID.get(id);
    if (!def) return false;
    const clean = coerce(def, value);
    const doc = readDoc();
    if (clean === undefined || clean === def.def) delete doc[id];
    else doc[id] = clean;
    return writeDoc(doc);
}

/* 全量偏好（含默认值）→ { "view.mode": "treemap", … } */
export function readPrefs() {
    const doc = readDoc();
    const out = {};
    PREF_REGISTRY.forEach((def) => {
        const clean = coerce(def, doc[def.id]);
        out[def.id] = clean === undefined ? def.def : clean;
    });
    return out;
}

/* 是否有**显式**存储过的偏好（设置弹窗用于区分「默认」与「你改过」） */
export function storedPrefIds() {
    const doc = readDoc();
    return PREF_REGISTRY.filter((def) => coerce(def, doc[def.id]) !== undefined).map((def) => def.id);
}

/* 展示文本（设置弹窗/命令面板共用；布尔 → 开/关） */
export function prefText(id, value) {
    const def = REG_BY_ID.get(id);
    if (!def) return String(value == null ? "" : value);
    const v = value === undefined ? getPref(id) : value;
    if (typeof def.def === "boolean") return v ? "开" : "关";
    if (def.optionText) return def.optionText[v] !== undefined ? def.optionText[v] : String(v);
    return String(v);
}

/* 恢复默认：整份文档删除（后续读取自然回落注册表默认） */
export function resetPrefs() {
    try {
        localStorage.removeItem(PREFS_KEY);
        return true;
    } catch (e) {
        return false;
    }
}

/* 启动装配：把持久化的偏好落进 APP_STATE（**首渲染之前**调用一次，
   见 main.js start()；此后各页面直接按 APP_STATE 渲染，不需要各自再读存储） */
export function initPrefs() {
    APP_STATE.view.mode = getPref("view.mode");
    APP_STATE.view.mergeTop = getPref("view.mergeTop");
    APP_STATE.compare.depth = getPref("compare.depth");
    APP_STATE.compare.hideZero = getPref("compare.hideZero");
    return readPrefs();
}

/* 设置弹窗用：按分组返回 [{group, items:[{id,label,hint,value,text,def,options,optionText,min,max}]}] */
export function prefGroups() {
    const values = readPrefs();
    const groups = [];
    PREF_REGISTRY.forEach((def) => {
        let g = groups.find((x) => x.group === def.group);
        if (!g) { g = { group: def.group, items: [] }; groups.push(g); }
        g.items.push({
            id: def.id,
            label: def.label,
            hint: def.hint,
            value: values[def.id],
            text: prefText(def.id, values[def.id]),
            def: def.def,
            options: def.options || null,
            optionText: def.optionText || null,
            min: def.min,
            max: def.max,
        });
    });
    return groups;
}
