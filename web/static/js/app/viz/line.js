/* ============================================================
   UI 2.0（SpaceLens Pro）· viz/line.js（P6·D6-4 新增）
   - 多快照趋势折线：**零依赖 SVG**（项目零构建/零第三方图表库红线）；
   - 路径计算复用 motion-core.js 的 sparklinePath / sparklineLastPoint 纯函数
     （同一条折线数学，sparkline 与整图不会两套算法）；
   - 组成：坐标轴（Y 轴量级刻度 + X 轴时间刻度）+ 数据点 + 悬浮读数 + 空态；
   - 空态必须给**原因**（禁止永久空白）：由调用方传入 reason 文案；
   - 动效纪律：折线一次成形（无入场动画，保证探针确定性），
     悬浮读数仅切换 opacity/transform（不触发布局）。
   - 无障碍：宿主元素 tabindex=0，←/→ 键移动读数游标（键盘等价于鼠标悬浮），
     role="img" + aria-label 概述「N 个点、从 A 到 B、变化量」；
   - 2026-09-13 第四轮（用户实测反馈）：**点选数据点**——对比页多选后下方对比
     恒取「最近一份」，用户要的是「点折线上的哪个点，就针对那份快照对比」。
     本模块只负责「把点击落成点选意图」（命中判定 + 回调 + 基准点标记），
     语义（点中的点 = 对比基准）由调用方在 onPick 里落地（viz 层零业务）。
   API：
     lineGeometry(values, width, height, pad) -> {path, points, min, max, ...}
     nearestIndex(points, x) -> 最近点下标
     pickIndex(points, x, y, maxDist) -> 命中点下标 / -1（点选命中判定，纯函数）
     pointDist(points, x, y) -> 到最近点的距离（px，读数的坐标口径）
     snapshotIndexOf(points, snapshot) -> 该快照对应的数据点下标 / -1
     renderLine(host, opts) -> {ok, reason, count, points}
     LINE_PAD（默认内边距）/ PICK_RADIUS_PX（点选命中半径，CSS px）
   ============================================================ */

import { sparklinePath } from "../motion-core.js";
import { esc, humanBytes } from "../api.js";

/* 内边距：左留 Y 轴刻度、下留 X 轴时间、上/右留呼吸位 */
export const LINE_PAD = { l: 62, r: 14, t: 10, b: 20 };

/* 时间文本：ISO/本地串 → "MM-DD HH:MM"（图表刻度用的紧凑格式，不依赖 locale） */
export function shortTime(text) {
    const s = String(text || "").replace("T", " ");
    const m = /^(\d{4})-(\d{2})-(\d{2})[ ]?(\d{2}):(\d{2})/.exec(s);
    if (!m) return s || "-";
    return m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
}

/* 纯函数：把 values 映射为「绘图区内」几何（无 DOM、可 node --test）
   - 返回 null 表示无法成线（<2 个有限值）；
   - points 为**画布绝对坐标**（含内边距），path 为绘图区坐标（调用方平移 pad 后绘制）。 */
export function lineGeometry(values, width, height, pad) {
    const p = pad || LINE_PAD;
    const v = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (v.length < 2) return null;
    const W = Number(width) || 0;
    const H = Number(height) || 0;
    const innerW = W - p.l - p.r;
    const innerH = H - p.t - p.b;
    if (innerW <= 4 || innerH <= 4) return null;
    const path = sparklinePath(v, innerW, innerH);
    if (!path) return null;
    const min = Math.min.apply(null, v);
    const max = Math.max.apply(null, v);
    const span = max - min;
    const step = innerW / (v.length - 1);
    const points = v.map((value, i) => ({
        i: i,
        value: value,
        x: Number((p.l + i * step).toFixed(2)),
        y: Number((p.t + (span > 0 ? innerH - ((value - min) / span) * innerH : innerH / 2)).toFixed(2)),
    }));
    return {
        path: path,
        points: points,
        min: min,
        max: max,
        span: span,
        width: W,
        height: H,
        innerW: innerW,
        innerH: innerH,
        pad: p,
    };
}

/* 读数游标定位（鼠标 x → 最近点下标；纯函数便于单测/探针复用） */
export function nearestIndex(points, x) {
    if (!points || !points.length) return -1;
    let best = 0;
    let bestD = Infinity;
    points.forEach((pt) => {
        const d = Math.abs(pt.x - x);
        if (d < bestD) { bestD = d; best = pt.i; }
    });
    return best;
}

/* ================= 点选（2026-09-13 第四轮）===========
   坐标口径：点的 x/y 是 SVG viewBox 坐标；命中判定用的是屏幕（CSS px）距离，
   因此调用方须先把点击坐标换算到 viewBox（svgScaleFactor）并把 maxDist 除以
   横/纵缩放（见 renderLine 内的 pickAt）——本组函数只做纯数学。 */

/* 点选命中半径（CSS px）：数据点本身只有 ~2.6px，太小不好点；
   28px ≈ 指头/鼠标的容错范围，且小于相邻点常见间距，避免误选邻点。 */
export const PICK_RADIUS_PX = 28;

/* 到最近数据点的距离（px，与传入坐标同口径）；无点返回 Infinity（= 不可能命中） */
export function pointDist(points, x, y) {
    if (!points || !points.length) return Infinity;
    const px = Number(x) || 0;
    const py = Number(y) || 0;
    let best = Infinity;
    points.forEach((pt) => {
        const dx = pt.x - px;
        const dy = pt.y - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
    });
    return best;
}

/* 点选命中判定（纯函数）：返回命中点下标；超出 maxDist 或参数非法 → -1
   （-1 = 不把这次点击当点选，交由调用方忽略——避免在图上随便点一下
   就把「对比基准」改成离得老远的某个点）。 */
export function pickIndex(points, x, y, maxDist) {
    if (!points || !points.length) return -1;
    const limit = Number.isFinite(maxDist) ? maxDist : PICK_RADIUS_PX;
    if (!(limit > 0)) return -1;
    const i = nearestIndex(points, x);
    if (i < 0) return -1;
    return pointDist([points[i]], x, y) <= limit ? i : -1;
}

/* 快照路径 → 数据点下标（首命中；找不到 -1）。
   对比页用它把「当前对比基准」标到折线对应的点上（纯字符串比较，不做路径归一化）。 */
export function snapshotIndexOf(points, snapshot) {
    const want = String(snapshot == null ? "" : snapshot);
    if (!want || !points || !points.length) return -1;
    for (let k = 0; k < points.length; k += 1) {
        if (String(points[k] && points[k].snapshot) === want) return k;
    }
    return -1;
}

/* 读数气泡水平落位（纯函数，便于 node --test）：
   返回相对宿主左边缘的 left（px，已取整）。
   规则：默认贴游标右侧（+gap）；右侧放不下 → 翻到游标左侧；两侧都放不下 → 夹取进宿主。
   2026-09-13 用户实测反馈：首/末数据点的读数会越出卡片、最右时甚至超出窗口被截断
   （实测末点 overflowRight=+123px、超出视口 94px）——原实现只做「右侧超 62% 翻左」，
   没有按读数实际宽度做边界夹取。 */
export function readoutLeft(ptX, readoutW, hostW, gap, edge) {
    const g = Number.isFinite(gap) ? gap : 12;
    const e = Number.isFinite(edge) ? edge : 4;
    const w = Math.max(0, Number(readoutW) || 0);
    const W = Math.max(0, Number(hostW) || 0);
    const x0 = Number(ptX) || 0;
    let x = x0 + g;
    if (x + w > W - e) x = x0 - g - w;      // 右侧溢出 → 翻到左侧
    if (x < e) x = e;                        // 左侧溢出 → 贴左边界
    if (x + w > W - e) x = Math.max(e, W - e - w); // 仍溢出（宿主比读数窄）→ 夹取
    return Math.round(x);
}

function hostSize(host) {
    const rect = host.getBoundingClientRect ? host.getBoundingClientRect() : { width: 0, height: 0 };
    const w = Math.max(240, Math.round(rect.width || host.clientWidth || 0));
    const h = Math.max(72, Math.round(rect.height || host.clientHeight || 0));
    return { w: w, h: h };
}

/* 主渲染入口。
   opts = {
     points: [{ label, value, at, sub, snapshot }],  // label=读数主标题（时间），value=字节数，
                                                     // snapshot=快照路径（点选回传用）
     reason: "空态原因（points 为空时必填）",
     state:  "ok"|"empty"|"loading",
     aria:   "无障碍概述（可省，自动推导）",
     onPick: (index, point) => void,  // 点选回调（点击数据点；未命中不算）
     active: 当前对比基准的点下标 / -1（画基准环 + aria-current）
     valueFmt: (n)=>string（缺省 humanBytes）
   }
   返回 {ok, reason, count, geometry}，同时写入 host.dataset.state（探针判据） */
export function renderLine(host, opts) {
    const o = opts || {};
    const list = (o.points || []).filter((p) => p && Number.isFinite(Number(p.value)));
    const fmt = typeof o.valueFmt === "function" ? o.valueFmt : humanBytes;
    const onPick = typeof o.onPick === "function" ? o.onPick : null;
    host.innerHTML = "";
    host.classList.add("line-host");

    if (list.length < 2) {
        const reason = o.reason || "暂无可用于成线的数据点";
        host.dataset.state = "empty";
        host.dataset.count = String(list.length);
        host.setAttribute("aria-label", reason);
        const p = document.createElement("p");
        p.className = "line-empty";
        p.textContent = reason;
        host.appendChild(p);
        return { ok: false, reason: reason, count: list.length };
    }

    const size = hostSize(host);
    const geo = lineGeometry(list.map((p) => Number(p.value)), size.w, size.h, LINE_PAD);
    if (!geo) {
        const reason = o.reason || "画布尺寸不足，无法绘制折线";
        host.dataset.state = "empty";
        host.setAttribute("aria-label", reason);
        const p = document.createElement("p");
        p.className = "line-empty";
        p.textContent = reason;
        host.appendChild(p);
        return { ok: false, reason: reason, count: list.length };
    }

    const first = list[0];
    const last = list[list.length - 1];
    const delta = Number(last.value) - Number(first.value);
    const canPick = !!(onPick && o.pickable !== false);
    const aria = o.aria ||
        ("多快照趋势折线：" + list.length + " 个点，" + (first.label || "") + " 至 " + (last.label || "") +
         "，由 " + fmt(first.value) + " 变化为 " + fmt(last.value) +
         "（" + (delta >= 0 ? "+" : "") + fmt(Math.abs(delta)) + "）" +
         (canPick ? "；点击任一数据点即可针对该快照做对比（←/→ 移动读数，Enter 选中）" : ""));
    host.dataset.state = "ok";
    host.dataset.count = String(list.length);
    host.setAttribute("aria-label", aria);
    if (!host.hasAttribute("tabindex")) host.tabIndex = 0;
    if (!host.hasAttribute("role")) host.setAttribute("role", "img");

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "line-svg");
    svg.setAttribute("viewBox", "0 0 " + geo.width + " " + geo.height);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    const add = (tag, cls, attrs) => {
        const el = document.createElementNS(svgNS, tag);
        if (cls) el.setAttribute("class", cls);
        Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, String(attrs[k])));
        svg.appendChild(el);
        return el;
    };

    /* Y 轴：量级刻度线（max / mid / min）+ 文本 */
    const ticks = geo.span > 0
        ? [
            { y: LINE_PAD.t, text: fmt(geo.max) },
            { y: LINE_PAD.t + geo.innerH / 2, text: fmt(geo.min + geo.span / 2) },
            { y: LINE_PAD.t + geo.innerH, text: fmt(geo.min) },
        ]
        : [{ y: LINE_PAD.t + geo.innerH / 2, text: fmt(geo.max) }];
    ticks.forEach((t) => {
        add("line", "line-grid-line", {
            x1: LINE_PAD.l, y1: t.y, x2: geo.width - LINE_PAD.r, y2: t.y,
            "vector-effect": "non-scaling-stroke",
        });
        add("text", "line-axis-text line-axis-y", {
            x: LINE_PAD.l - 6, y: t.y + 3, "text-anchor": "end",
        }).textContent = t.text;
    });

    /* 折线本体：绘图区坐标 + translate 平移（sparklinePath 的坐标系） */
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("transform", "translate(" + LINE_PAD.l + "," + LINE_PAD.t + ")");
    svg.appendChild(g);
    const pathEl = document.createElementNS(svgNS, "path");
    pathEl.setAttribute("class", "line-path");
    pathEl.setAttribute("d", geo.path);
    pathEl.setAttribute("fill", "none");
    pathEl.setAttribute("vector-effect", "non-scaling-stroke");
    g.appendChild(pathEl);

    /* 数据点（可点选：光标 pointer + 点选意图回调，见文件头 2026-09-13 第四轮注记）
       ⚠️ SVG 的 cursor 是表现属性，不走 CSS 继承链 → 直接写属性即可。 */
    if (canPick) svg.setAttribute("cursor", "pointer");
    const dots = document.createElementNS(svgNS, "g");
    dots.setAttribute("class", "line-dots");
    svg.appendChild(dots);
    geo.points.forEach((pt) => {
        const c = document.createElementNS(svgNS, "circle");
        c.setAttribute("class", "line-dot");
        c.setAttribute("data-i", String(pt.i));
        c.setAttribute("cx", String(pt.x));
        c.setAttribute("cy", String(pt.y));
        c.setAttribute("r", "2.6");
        dots.appendChild(c);
    });

    /* 当前对比基准点标记（2026-09-13 第四轮）：加大的环 + 高亮实心点，
       与悬浮游标（虚线 + 小实心点）区分开——用户可以一眼看到「此刻在与哪份快照比」 */
    const activeG = document.createElementNS(svgNS, "g");
    activeG.setAttribute("class", "line-active-g");
    activeG.setAttribute("hidden", "");
    svg.appendChild(activeG);
    const activeRing = document.createElementNS(svgNS, "circle");
    activeRing.setAttribute("class", "line-active-ring");
    activeRing.setAttribute("r", "6.5");
    activeG.appendChild(activeRing);
    const activeDot = document.createElementNS(svgNS, "circle");
    activeDot.setAttribute("class", "line-active-dot");
    activeDot.setAttribute("r", "3.2");
    activeG.appendChild(activeDot);

    /* 基准点标记刷新（渲染时调用一次；aria-current 供探针/读屏断言） */
    const refreshActive = () => {
        const idx = Number.isFinite(Number(o.active)) ? Number(o.active) : -1;
        const pt = idx >= 0 ? geo.points[idx] : null;
        Array.from(dots.children).forEach((c) => {
            const on = !!pt && Number(c.getAttribute("data-i")) === idx;
            c.classList.toggle("is-active", on);
            if (on) c.setAttribute("aria-current", "true");
            else c.removeAttribute("aria-current");
        });
        if (!pt) {
            activeG.setAttribute("hidden", "");
            delete host.dataset.active;
            return;
        }
        activeRing.setAttribute("cx", String(pt.x));
        activeRing.setAttribute("cy", String(pt.y));
        activeDot.setAttribute("cx", String(pt.x));
        activeDot.setAttribute("cy", String(pt.y));
        activeG.removeAttribute("hidden");
        host.dataset.active = String(idx);
    };
    refreshActive();

    /* 悬浮游标（竖线 + 高亮环），默认隐藏 */
    const guide = add("line", "line-guide", {
        x1: 0, y1: LINE_PAD.t, x2: 0, y2: geo.height - LINE_PAD.b,
        "vector-effect": "non-scaling-stroke",
    });
    guide.setAttribute("hidden", "");
    const cursor = add("circle", "line-cursor", { cx: 0, cy: 0, r: "4.4" });
    cursor.setAttribute("hidden", "");

    /* X 轴时间刻度：首/中/末（点少时只首末，避免重叠） */
    const xIdx = list.length >= 3 ? [0, Math.floor((list.length - 1) / 2), list.length - 1] : [0, list.length - 1];
    xIdx.forEach((i, k) => {
        const anchor = k === 0 ? "start" : (k === xIdx.length - 1 ? "end" : "middle");
        add("text", "line-axis-text line-axis-x", {
            x: geo.points[i].x, y: geo.height - 5, "text-anchor": anchor,
        }).textContent = shortTime(list[i].label);
    });

    host.appendChild(svg);

    /* 悬浮读数（绝对定位在宿主内；仅切 opacity/transform） */
    const readout = document.createElement("div");
    readout.className = "line-readout";
    readout.setAttribute("hidden", "");
    readout.innerHTML =
        '<span class="line-readout-time"></span>' +
        '<span class="line-readout-value"></span>' +
        '<span class="line-readout-sub"></span>';
    host.appendChild(readout);

    const moveTo = (i) => {
        const pt = geo.points[i];
        const item = list[i];
        if (!pt || !item) return;
        guide.removeAttribute("hidden");
        cursor.removeAttribute("hidden");
        guide.setAttribute("x1", String(pt.x));
        guide.setAttribute("x2", String(pt.x));
        cursor.setAttribute("cx", String(pt.x));
        cursor.setAttribute("cy", String(pt.y));
        readout.removeAttribute("hidden");
        readout.querySelector(".line-readout-time").textContent = shortTime(item.label);
        readout.querySelector(".line-readout-value").textContent = fmt(item.value);
        const subEl = readout.querySelector(".line-readout-sub");
        const subText = item.sub || (i === 0 ? "最早" : (i === list.length - 1 ? "最新" : ""));
        subEl.textContent = subText;
        subEl.toggleAttribute("hidden", !subText);
        /* 读数位置：跟随游标；按**读数实际宽度**做边界夹取（不溢出宿主/窗口）。
           坐标系换算：SVG viewBox 宽 = geo.width，而屏幕宽 = host.clientWidth
           （preserveAspectRatio:none）→ 先按比例换算成 CSS px 再落位。 */
        const hostW = host.clientWidth || geo.width;
        const scale = geo.width > 0 ? hostW / geo.width : 1;
        readout.style.transform = "translateX(" +
            readoutLeft(pt.x * scale, readout.offsetWidth, hostW) + "px)";
        readout.dataset.i = String(i);
        host.dataset.cursor = String(i);
    };
    const hide = () => {
        guide.setAttribute("hidden", "");
        cursor.setAttribute("hidden", "");
        readout.setAttribute("hidden", "");
        delete host.dataset.cursor;
    };

    const onMove = (ev) => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        const x = ((ev.clientX - rect.left) / rect.width) * geo.width;
        moveTo(nearestIndex(geo.points, x));
    };
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerleave", hide);
    host.addEventListener("pointerleave", hide);
    host.addEventListener("focus", () => moveTo(geo.points.length - 1));
    host.addEventListener("blur", hide);

    /* 点选（2026-09-13 第四轮）：点击数据点 → onPick(下标, 原始点)。
       命中判定在**屏幕坐标**里做（容错半径按 CSS px），因此先把点击换算到
       viewBox 再把半径按横/纵缩放折回 viewBox 单位——preserveAspectRatio:none
       下图会被水平拉伸，两个方向的 1px 不等价。未命中（离任何点都远）→ 不放行，
       避免"在图上随便点一下"就把对比基准改成离得老远的某个点。 */
    const pickAt = (ev) => {
        if (!canPick || !ev || typeof ev.clientX !== "number") return false;
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const sx = geo.width / rect.width;
        const sy = geo.height / rect.height;
        const x = (ev.clientX - rect.left) * sx;
        const y = (ev.clientY - rect.top) * sy;
        const maxDist = PICK_RADIUS_PX * Math.max(sx, sy);
        const idx = pickIndex(geo.points, x, y, maxDist);
        /* 探针留痕（只读调试面；smoke 断言用它区分「未命中」与「命中但语义没落地」） */
        host.dataset.pick = idx < 0 ? "miss" : String(idx);
        if (idx < 0) return false;
        const item = list[idx];
        if (!item) return false;
        moveTo(idx); // 点选同时把读数停在该点上（点击的视觉反馈）
        onPick(idx, item);
        return true;
    };
    if (canPick) {
        /* 单击（含触屏 tap——浏览器在 tap 后补发 click；拖动滚动不触发，正合语义） */
        svg.addEventListener("click", (ev) => { pickAt(ev); });
    }

    host.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && canPick) {
            /* 键盘等价于点选：Enter 选中读数游标当前所在的点（焦点进入时游标=最后一点） */
            const cur = Number(host.dataset.cursor);
            const at = Number.isFinite(cur) && host.dataset.cursor !== undefined
                ? cur : geo.points.length - 1;
            const item = list[at];
            if (item) {
                onPick(at, item);
                ev.preventDefault();
            }
            return;
        }
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        const cur = Number(host.dataset.cursor);
        const base = Number.isFinite(cur) && host.dataset.cursor !== undefined ? cur : geo.points.length - 1;
        const next = Math.min(geo.points.length - 1, Math.max(0, base + (ev.key === "ArrowLeft" ? -1 : 1)));
        moveTo(next);
        ev.preventDefault();
    });

    return { ok: true, reason: "", count: list.length, geometry: geo };
}
