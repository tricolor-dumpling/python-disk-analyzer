// ==UserScript==
// @name        pds-u11-scroll-probe
// @namespace   pds
// @version     1.0
// @description U1.1 验收探针：默认视口零滚动观测值（精确双档窗口属 U1.3 A2）
// @match       http://127.0.0.1/*
// @grant       none
// @run-at      document-idle
// ==/UserScript==

const de = document.documentElement;
const b = document.body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1200); // 等 app 布数据后再量
return {
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  docScrollHeight: de.scrollHeight,
  bodyScrollHeight: b ? b.scrollHeight : null,
  docClientHeight: de.clientHeight,
  overflowX: de.scrollWidth > de.clientWidth,
  zeroScroll: de.scrollHeight <= window.innerHeight + 1,
  theme: de.getAttribute("data-theme"),
  url: location.href,
};
