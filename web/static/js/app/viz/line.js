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
     role="img" + aria-label 概述「N 个点、从 A 到 B、变化量」。
   API：
     lineGeometry(values, width, height, pad) -> {path, points, min, max, ...}
     renderLine(host, opts) -> {ok, reason, count, points}
     LINE_PAD（默认内边距）
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

function hostSize(host) {
    const rect = host.getBoundingClientRect ? host.getBoundingClientRect() : { width: 0, height: 0 };
    const w = Math.max(240, Math.round(rect.width || host.clientWidth || 0));
    const h = Math.max(72, Math.round(rect.height || host.clientHeight || 0));
    return { w: w, h: h };
}

/* 主渲染入口。
   opts = {
     points: [{ label, value, at, sub }],   // label=悬浮读数主标题（时间），value=字节数
     reason: "空态原因（points 为空时必填）",
     state:  "ok"|"empty"|"loading",
     aria:   "无障碍概述（可省，自动推导）",
     valueFmt: (n)=>string（缺省 humanBytes）
   }
   返回 {ok, reason, count}，同时写入 host.dataset.state（探针判据） */
export function renderLine(host, opts) {
    const o = opts || {};
    const list = (o.points || []).filter((p) => p && Number.isFinite(Number(p.value)));
    const fmt = typeof o.valueFmt === "function" ? o.valueFmt : humanBytes;
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
    const aria = o.aria ||
        ("多快照趋势折线：" + list.length + " 个点，" + (first.label || "") + " 至 " + (last.label || "") +
         "，由 " + fmt(first.value) + " 变化为 " + fmt(last.value) +
         "（" + (delta >= 0 ? "+" : "") + fmt(Math.abs(delta)) + "）");
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

    /* 数据点 */
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
        /* 读数位置：跟随游标，靠右时翻到左侧（不溢出宿主） */
        const left = pt.x > geo.width * 0.62 ? pt.x - 12 : pt.x + 12;
        readout.style.transform = "translateX(" + Math.round(left) + "px)";
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
    host.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        const cur = Number(host.dataset.cursor);
        const base = Number.isFinite(cur) && host.dataset.cursor !== undefined ? cur : geo.points.length - 1;
        const next = Math.min(geo.points.length - 1, Math.max(0, base + (ev.key === "ArrowLeft" ? -1 : 1)));
        moveTo(next);
        ev.preventDefault();
    });

    return { ok: true, reason: "", count: list.length, geometry: geo };
}
