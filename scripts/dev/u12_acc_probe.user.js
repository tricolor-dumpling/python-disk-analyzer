// ==UserScript==
// @name        pds-u12-acc-probe
// @namespace   pds
// @version     1.0
// @description U1.2 验收探针：真实页 dynamic import 手动调 countUp（滚动采样/终值/记账/reduced 直显/控制台错误捕获，顶层 return 结果）
// @match       http://127.0.0.1/*
// @grant       none
// @run-at      document-idle
// ==/UserScript==

const R = { errs: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

window.addEventListener("error", (e) => R.errs.push("onerror:" + (e.message || "")));
window.addEventListener("unhandledrejection", (e) => R.errs.push("unhandledrejection:" + String((e.reason && e.reason.message) || e.reason)));
const origErr = console.error.bind(console);
console.error = function () { R.errs.push("console.error:" + Array.prototype.map.call(arguments, String).join(" ")); origErr.apply(console, arguments); };

try {
  // 真实页运行环境：Flask /static 静态服务，原生 ES Module dynamic import（零构建链，无打包）
  const motion = await import("/static/js/app/motion.js");
  R.motionLoaded = true;
  R.motionExports = Object.keys(motion).sort().join(",");
  R.motionTokenDur4 = getComputedStyle(document.documentElement).getPropertyValue("--dur-4").trim();
  R.motionTokenDur4ms = parseFloat(R.motionTokenDur4);

  const el = document.createElement("div");
  document.body.appendChild(el);
  const fmt = (v) => Math.round(v).toLocaleString();

  // ① 正常滚动：duration 取 token（--dur-4 = 600ms），中途采样应单调增长，终点精确
  const target = 12345;
  motion.countUp(el, target, { fmt });
  await wait(150);
  R.rolling150 = el.textContent;      // 应 >0 且 <target（easeOutExpo 已滚过一段）
  await wait(200);
  R.rolling350 = el.textContent;      // 应 > rolling150（单调推进）
  await wait(500);
  R.finalText = el.textContent;       // 应 = "12,345"（精确终值，千分位 fmt）
  R.finalDatasetV = el.dataset.v;     // 应 = "12345"（记账）
  R.rollingMonotonic = Number(R.rolling150.replace(/[^0-9]/g, "")) > 0 &&
                       Number(R.rolling350.replace(/[^0-9]/g, "")) > Number(R.rolling150.replace(/[^0-9]/g, ""));

  // ② 二次调用：from = 上次记账 12345 → 100（验证数据集连续性与首帧不空白）
  motion.countUp(el, 100, { fmt });
  R.secondFirstFrame = el.textContent; // 应非空（首帧写 fmt(from)）
  await wait(750);
  R.secondFinal = el.textContent;      // "100"

  // ③ reduced-motion：直显终值（桩 matchMedia）
  const origMM = window.matchMedia;
  window.matchMedia = function (q) {
    if (String(q).indexOf("prefers-reduced-motion") !== -1) {
      return { matches: true, media: q, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} };
    }
    return origMM(q);
  };
  try {
    motion.countUp(el, 777, { fmt });
    R.reducedFinal = el.textContent;     // "777"（无滚动、无 rAF）
    R.reducedDatasetV = el.dataset.v;    // "777"
  } finally {
    window.matchMedia = origMM;
  }

  // ④ 其余导出可调用（浅烟测：函数存在性 + 无依赖报错）
  R.exportTruth = typeof motion.reducedMotion === "function" &&
                  typeof motion.ripple === "function" &&
                  typeof motion.staggerIn === "function" &&
                  typeof motion.pageOut === "function" &&
                  typeof motion.pageIn === "function" &&
                  typeof motion.flip === "function" &&
                  typeof motion.sparkline === "function" &&
                  typeof motion.confetti === "function" &&
                  typeof motion.shake === "function" &&
                  typeof motion.drawCheck === "function";

  el.remove();
} catch (e) {
  R.motionLoaded = false;
  R.error = String((e && e.stack) || e);
}

R.phase = "done";
return R;
