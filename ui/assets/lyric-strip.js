/**
 * ui/assets/lyric-strip.js — 输入栏上方那条歌词带子（挂在 App 的 input panel 里）。
 *
 * 数据全部来自本应用自己的路由，跟 mini 一样：
 *   GET /state                 → 当前曲目 / 位置 / 播放态（约 1s 一次，本地插值补平滑）
 *   GET /lyric?id=…            → 原始 LRC 文本（换歌才拉，拿到非空才缓存）
 *   GET /lyric-strip/config    → 显示偏好（mode + font，存后端；别处改了本页自动跟随）
 *
 * 两种显示方式，都只画歌词本身：
 *   center —— 中位恒定：三段横排，正在唱的那句固定在正中并放大，两侧虚化。
 *   scroll —— 横向流动：字从左往右走，当前句扫过正中。
 *
 * 右上那片空白里有一颗「A」钮：**平时隐身**，鼠标进面板才淡出来，点一下切当前句字号。
 * ⚠ 它能不能被点到，取决于下面 declareInteractive()：宿主对 App 面板默认不把鼠标
 *   交给 iframe（面板就贴在输入框上方，让点击穿过去才不挡打字），要在页里显式声明
 *   可交互区域。不声明的话，连 :hover 都不会触发，按钮永远不现身。
 *
 * 没在播时整块留白，不写「未在播放」。
 */
import { initHana, api, post } from "./client.js";
import { createShatterField } from "./shatter-text.js";

const track = document.getElementById("track");
const segPrev = document.getElementById("segPrev");
const segCur = document.getElementById("segCur");
/* 出句替身：与庭中同格叠放，只负责把上一句原地带走（见 @keyframes ls-out-mid） */
const segGhost = document.getElementById("segGhost");
const segNext = document.getElementById("segNext");
const flow = document.getElementById("flow");
const kara = document.getElementById("kara");
const karaBase = document.getElementById("karaBase");
const karaFill = document.getElementById("karaFill");
const idle = document.getElementById("idle");
const shatterCanvas = document.getElementById("shatter");
/** 散雪那一档的实现单独一个模块（用户 0.18.0 带来的，见 ui/assets/shatter-text.js）；
 *  没有 canvas 就整档安静地不工作（旧宿主/旧快照下不至于报错）。 */
const shatter = shatterCanvas ? createShatterField(shatterCanvas) : null;
const fontBtn = document.getElementById("fontBtn");
const paletteBtn = document.getElementById("paletteBtn");

/** 一行歌词。t 是秒。 */
let lines = [];
let songId = "";
let songName = "";
let lastIndex = -1;
/** 后端最近一次报的播放态 + 到达时刻，用来本地推位置。 */
let snap = { position: 0, duration: 0, playing: false, at: 0 };
const lyricCache = new Map();
/** 空歌词的重试窗口（取源服务刚重启时会回一次空，不能一直认账）。 */
let lyricTries = 0;
let lyricRetryAt = 0;

/** 四种显示方式（2026-10-25 改名与重排）："center" 居盈（中位恒定）/ "shatter" 散雪（唱完碎掉）/
 *  "scroll" 行云（横向流动）/ "karaoke" 尽染（逐字上色）。
 *  偏好存在后端，可被 mini 或 Agent 工具在别处改（本页每 2 秒核一次）。 */
let mode = "center";
/** 当前句字号档位（后端可能覆盖这份默认）。 */
let fontSteps = [20, 24, 30, 36];
let font = 20;
/** 配色档位。theme = 跟随界面主题（默认），其余是手选固定色。
 *  id 必须与 lib/lyric-strip.js 的 STRIP_PALETTES 一致（后端会校验）；中文名只在这一层用（title）。 */
const PALETTES = [
  { id: "theme", name: "跟随主题" },
  { id: "clay", name: "陶土" },
  { id: "teal", name: "苔青" },
  { id: "ink", name: "藏青" },
  { id: "sage", name: "松绿" },
  { id: "whale", name: "鲸蓝" },
];
let palette = "theme";
/** 滚动模式下已经在台上的句子：index → element。 */
const flowItems = new Map();

const STEP_LABELS = ["anim-prev", "anim", "anim-next"];

/* ---------------- 交互区域 ----------------
 * 声明整块面板可交互。宿主对 App 面板默认把鼠标事件穿过去（面板就贴在
 * 输入框上方，怕挡打字），不声明的话面板里的 :hover 与点击都收不到。
 * 尺寸变化时重报一次。
 */
async function declareInteractive(hana) {
  try {
    if (!hana || !hana.surface || typeof hana.surface.setInteractiveRegions !== "function") return;
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    await hana.surface.setInteractiveRegions([{ x: 0, y: 0, width, height }]);
  } catch {
    /* 老宿主没这个口子，就算了 */
  }
}

/* ---------------- LRC ---------------- */

/**
 * 解析 LRC。`[ti:…]` 这类元信息行因为时间戳正则要求数字，天然被跳过。
 * 同一行多个时间戳会展开成多条（副歌重复用得上）。
 */
function parseLrc(text) {
  const out = [];
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const times = [];
    let m;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(raw))) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const fracText = m[3] || "";
      const frac = fracText ? Number(fracText) / Math.pow(10, fracText.length) : 0;
      times.push(min * 60 + sec + frac);
    }
    if (!times.length) continue;
    const body = raw.replace(stamp, "").trim();
    for (const t of times) out.push({ t, text: body });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * 解析网易云 yrc（**逐字**时间轴）：
 *   [行开始ms,行时长ms](字开始ms,字时长ms,0)字(字开始,字时长,0)字…
 * 返回与 parseLrc 同一个数组形状，额外带 chars（每个字的 t / dur / text），
 * 卡拉OK 那一档靠它做到「每个字亮起来」而不是按字数均分。
 */
function parseYrc(text) {
  const out = [];
  const charRe = /\((\d+),(\d+),\d+\)([^(]*)/g;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const head = /^\[(\d+),(\d+)\]/.exec(raw);
    if (!head) continue;
    const chars = [];
    charRe.lastIndex = head[0].length;
    let m;
    while ((m = charRe.exec(raw))) {
      chars.push({ t: Number(m[1]) / 1000, dur: Number(m[2]) / 1000, text: m[3] });
    }
    const body = chars.map((c) => c.text).join("").trim();
    if (!body) continue;
    out.push({ t: Number(head[1]) / 1000, text: body, chars });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 二分找「位置 pos 落在哪一行」。返回 -1 表示还在前奏。 */
function pickIndex(pos) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function textAt(index) {
  if (index < 0 || index >= lines.length) return "";
  // 空行（间奏）不予占位（2026-10-12 用户要求：不用 ♪ 顶位）。
  return String(lines[index].text || "").trim();
}

/** 这一行是不是「留白行」：只有时间戳、没有字。
 *  网易云的 LRC 在段间插了很多这种（如 `[01:49.63]世界啊就放马过来吧` 后面紧跟一行
 *  `[01:49.99]`）。滚动模式里它就是那个“空档”，是对的；但单句显示停上去就成了“正中空着”。 */
function isBlankLine(i) {
  return !(i >= 0 && i < lines.length) || !String(lines[i].text || "").trim();
}

/**
 * 留白行在**单句显示**（center / karaoke）里要跳过：
 *   holdOf[i]     = 第 i 行及之前最近的、有字的那一行（没有则 -1）
 *   nextRealOf[i] = 第 i 行之后第一句有字的行号（没有则 -1）
 * 两个模式因此永远停在真句上，两侧也各取真句。
 * **滚动模式不用这套** —— 那边留白就是该留一个空档（2026-10-12 用户要求）。
 *
 * 背景（2026-10-14 用户报「有时候会这样」：正中那句空了、只剩两侧）：
 * 根因就是当前句落到了留白行上。以前那样看着像坏了。 */
let holdOf = [];
let nextRealOf = [];
function buildLineIndex() {
  const n = lines.length;
  holdOf = new Array(n).fill(-1);
  nextRealOf = new Array(n).fill(-1);
  let carry = -1;
  for (let i = 0; i < n; i += 1) {
    if (!isBlankLine(i)) carry = i;
    holdOf[i] = carry;
  }
  let later = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    nextRealOf[i] = later;
    if (!isBlankLine(i)) later = i;
  }
}

/** 换曲/拿到新歌词都要走它，保证映射表与 lines 同步。 */
function setLines(next) {
  lines = Array.isArray(next) ? next : [];
  buildLineIndex();
  buildWarp();
}

/** 当前句唱到几成（0~1）。最后一句没有下一句，按 4 秒估。 */
function lineProgress(pos, index) {
  if (index < 0 || index >= lines.length) return 0;
  const start = lines[index].t;
  const end = index + 1 < lines.length ? lines[index + 1].t : start + 4;
  if (!(end > start)) return 0;
  return Math.max(0, Math.min(1, (pos - start) / (end - start)));
}

/* ---------------- 颜色（与整页歌词同一套） ----------------
 * 正中是「正在唱」的主题色，两边渐成未唱的淡色。色值从 CSS 变量读（单一来源），
 * 亮/暗主题各一套。用 JS 插值而不用 CSS 的 color-mix —— 后者在旧 Chromium 上
 * 未必支持，表现就是「颜色看着没改到」（2026-10-12 踩到）。
 */
let curRgb = [91, 128, 121];
let sideRgb = [163, 167, 174];
/** 散雪碎片用的颜色（2026-10-25 异羽：“按现在居盈两边的颜色来试试”）——
 *  取的是 `--ls-kara-ghost`，即尽染未上色那层淡墨灰；读不到就退回主题色。
 *  ⚠ 只管**碎片**：散雪的整句仍用 `curRgb`（主题色），两张图分开烘（见 shatter-text.js）。 */
let ghostRgb = null;

function parseColor(value) {
  const text = String(value || "").trim();
  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // 主题表里也见过三位简写（#abc）
  const short = text.match(/^#([0-9a-f]{3})$/i);
  if (short) {
    const h = short[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  const rgb = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** rgb → hsl（h 0..360, s/l 0..1）。 */
function rgbToHsl([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (max === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  const t = (((h % 360) + 360) % 360) / 360;
  if (!s) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (x) => {
    const u = (x + 1) % 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [Math.round(f(t + 1 / 3) * 255), Math.round(f(t) * 255), Math.round(f(t - 1 / 3) * 255)];
}

/* “同温度的灰”（2026-10-25 异羽：“没有配色的就改成主色与中性灰混出来的同温度色”）。
 * 做法：取**主色的色相**，把饱和度压到 10%、亮度固定 61%。
 * 为什么不真做 rgb 平均：那会把亮色档算得太亮、深色档算得太暗；四档手选值
 * （#9a9d9b / #8b929b / #a0948c / #959b96）实测都落在“S 1~10%、L 59~61%”这一带，
 * 所以保住色相 + 固定亮度，出来的灰就与它们同一族，且冷暖跟着主色走。 */
const GHOST_S = 0.1;
const GHOST_L = 0.61;
function deriveGhost(cur) {
  const [h] = rgbToHsl(cur);
  return hslToRgb(h, GHOST_S, GHOST_L);
}

function readColors() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const cur = parseColor(cs.getPropertyValue("--ls-cur-color"));
    const side = parseColor(cs.getPropertyValue("--ls-side-color"));
    if (cur) curRgb = cur;
    if (side) sideRgb = side;
    /* 优先级：手选配色档自己定义的 ghost → 按主色派生。
       派生的值写到**另一个变量**（--ls-kara-ghost-derived）上，
       不直接覆盖 --ls-kara-ghost，否则内联样式会盖过下面那几条配色规则，
       切到 sage / clay 时就读不到它们自己的灰了。 */
    const explicit = parseColor(cs.getPropertyValue("--ls-kara-ghost"));
    if (explicit) {
      ghostRgb = explicit;
    } else {
      ghostRgb = deriveGhost(curRgb);
      document.documentElement.style.setProperty(
        "--ls-kara-ghost-derived",
        `rgb(${ghostRgb[0]}, ${ghostRgb[1]}, ${ghostRgb[2]})`
      );
    }
  } catch {
    /* 读不到就用手上这份 */
  }
}

/**
 * 宿主的主题样式表是**异步**贴进本文档 head 的（SDK ready 之后才注入），
 * 启动时只读一次颜色会读到兜底那套苔青 —— 主题色就白改了。
 * 除了主循环里那 2 秒一次的核对，这里再盯两个更早的时机：
 * ① SDK 报主题变了；② head 里多出/换掉了那份 style。
 */
function watchThemeColors(hana) {
  if (hana && hana.theme && typeof hana.theme.subscribe === "function") {
    try {
      hana.theme.subscribe(readColors);
    } catch {
      /* 老宿主没这口子 */
    }
  }
  try {
    if (document.head && typeof MutationObserver === "function") {
      new MutationObserver(readColors).observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  } catch {
    /* 观测不到就只靠启动那次读 */
  }
  // 兜底：头几秒再各读一次（主题表的插入时机不受我们控制）
  for (const ms of [300, 1200, 3000]) setTimeout(readColors, ms);
}

function mixColor(away) {
  const t = Math.max(0, Math.min(1, away));
  const r = Math.round(curRgb[0] + (sideRgb[0] - curRgb[0]) * t);
  const g = Math.round(curRgb[1] + (sideRgb[1] - curRgb[1]) * t);
  const b = Math.round(curRgb[2] + (sideRgb[2] - curRgb[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/* ---------------- 字体（2026-10-23） ----------------
 * 字体偏好和字号/配色存在一起，整页歌词页也读同一份 —— 免得两个入口长得不一样。
 * "hana" 档不写 font-family（inherit），于是直接跟随 HANA 自己的字体设置。 */
let family = "hana";
let familyCss = "";

/** 把 HANA 字体库里的字体注册进这个文档（2026-10-23）。
 *  不做这一步，选了自定义字体只会回退到副选字体 —— 因为浏览器只认 @font-face。 */
function injectFaces(list) {
  const rules = (list || [])
    .filter((f) => f && f.src && f.family)
    .map((f) => `@font-face{font-family:"${f.family}";src:url("${f.src}") format("${f.format || "truetype"}");font-display:swap;}`);
  if (!rules.length) return;
  let s = document.getElementById("lsFontFaces");
  if (!s) {
    s = document.createElement("style");
    s.id = "lsFontFaces";
    document.head.appendChild(s);
  }
  s.textContent = rules.join("\n");
}

function applyFamily(id, list) {
  const fams = Array.isArray(list) && list.length ? list : null;
  if (fams) injectFaces(fams);
  const hit = fams ? fams.find((f) => f.id === id) : null;
  family = String(id || "hana");
  familyCss = hit ? String(hit.css || "inherit") : "inherit";
  document.documentElement.style.setProperty("--ls-family", familyCss);
  // body 上也直接挂一份：带子里有些块自带 font-family，只给根变量盖不住
  document.body.style.fontFamily = familyCss === "inherit" ? "inherit" : familyCss;
}

/* ---------------- 字号 ---------------- */

function applyFont(px) {
  const value = Number(px);
  if (!Number.isFinite(value)) return;
  font = value;
  document.documentElement.style.setProperty("--ls-cur", value + "px");
  if (!fontBtn) return;
  const index = fontSteps.indexOf(value);
  // 钮上的「A」本身也随档变大变小，一眼看出现在是哪一档。
  fontBtn.style.fontSize = (11 + Math.max(0, index) * 1.5) + "px";
  fontBtn.title = `切换字号（当前 ${value}px）`;
}

async function cycleFont() {
  const index = fontSteps.indexOf(font);
  const next = fontSteps[(index + 1) % fontSteps.length];
  applyFont(next);
  try {
    await post("lyric-strip/config", { font: next });
  } catch {
    /* 存不上不影响这一次 */
  }
}

if (fontBtn) fontBtn.addEventListener("click", () => void cycleFont());

/* ---------------- 配色 ---------------- */

/**
 * 把某一档配色贴到文档上，然后重读颜色（三种模式都只看 --ls-cur-color / --ls-side-color）。
 * theme 档**不写** data-palette：CSS 里没有那条规则，于是回到 var(--accent, 兜底) 的主题跟随。
 */
function applyPalette(id) {
  const found = PALETTES.find((p) => p.id === id);
  palette = found ? found.id : "theme";
  if (palette === "theme") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = palette;
  readColors();
  if (paletteBtn) {
    const name = (found && found.name) || "跟随主题";
    paletteBtn.title = `切换歌词配色（当前 ${name}）`;
  }
}

async function cyclePalette() {
  const index = PALETTES.findIndex((p) => p.id === palette);
  const next = PALETTES[(index + 1) % PALETTES.length];
  applyPalette(next.id);
  try {
    await post("lyric-strip/config", { palette: next.id });
  } catch {
    /* 存不上不影响这一次 */
  }
}

if (paletteBtn) paletteBtn.addEventListener("click", () => void cyclePalette());

/**
 * 卡拉OK 的已唱比例（0~1）。
 * 有逐字时间就按字算（每个字按自己的起止插值），没有就退回句内线性进度。
 * 注意是按**字数**加权而不是像素——中英文混排时与真实字宽会有偏差，但足够用。
 */
function karaokeProgress(pos, index) {
  const line = index >= 0 && index < lines.length ? lines[index] : null;
  const chars = line && Array.isArray(line.chars) ? line.chars : null;
  if (chars && chars.length) {
    let revealed = 0;
    let total = 0;
    for (const c of chars) {
      const len = String(c.text || "").length || 0;
      total += len;
      if (pos >= c.t + c.dur) {
        revealed += len;
      } else if (pos >= c.t) {
        const ratio = c.dur > 0 ? (pos - c.t) / c.dur : 1;
        revealed += len * Math.max(0, Math.min(1, ratio));
      }
    }
    return total > 0 ? Math.max(0, Math.min(1, revealed / total)) : 0;
  }
  return lineProgress(pos, index);
}

/* ---------------- 模式一：中位恒定 ---------------- */

function setSeg(el, text, animClass) {
  if (el.textContent !== text) el.textContent = text;
  el.classList.remove(...STEP_LABELS);
  if (animClass) {
    // 先读一次布局再挂动画类，保证同一句话连续换位时动画能重放。
    void el.offsetWidth;
    el.classList.add(animClass);
  }
}

/* ---------------- 居庭：换句时的交接（v2 就地交叉，2026-10-21） ----------------
 * 上一句交给「替身」原地淡出（只往右挪 6px、缩到 0.92、糊掉）；
 * 右廊接到的正好是刚离开庭中的那句 —— 同字接手，眼睛会连成「它走出去了」。
 * ⚠ 横向交棒（旧句真的走向右廊）试过，胶片上两句会在庭心撞车，已放弃。
 * ⚠ 2026-10-21 用户看过实机后选「方案 2：彻底不重叠」—— 出句 0.14s 淡完，新句 0.16s 后才起，
 *   中间留一瞬空窗（几乎看不见），代价是“从廊里走进来”的连贯感弱一点，换来庭心永远只有一句字。
 */
/** 上一次庭中显示的字（给替身用）。 */
let lastCurText = "";
let ghostTimer = 0;

const measureCtx = document.createElement("canvas").getContext("2d");
/** 这句在中格装不装得下（中格的 CSS 上限是 44vw）。装不下就不拆字，保住省略号。 */
function fitsOnOneLine(text) {
  if (!text || !measureCtx) return false;
  const avail = (track.clientWidth || 0) * 0.44 - 8;
  if (avail <= 20) return false;
  try {
    measureCtx.font = `400 ${font}px ${readFamily()}`;
  } catch {
    return false;
  }
  return measureCtx.measureText(text).width + text.length * 0.2 <= avail;
}

/** 庭中那句：装得下就拆成单字逐字落墨；装不下就整句淡入。 */
function renderCur(text, animate) {
  segCur.classList.remove("anim");
  if (!animate) {
    segCur.textContent = text;
    return;
  }
  if (!fitsOnOneLine(text)) {
    // 长句不拆：一拆 text-overflow: ellipsis 就失效了
    segCur.textContent = text;
    void segCur.offsetWidth;
    segCur.classList.add("anim");
    return;
  }
  segCur.textContent = "";
  const frag = document.createDocumentFragment();
  Array.from(text).forEach((ch, i) => {
    const span = document.createElement("span");
    span.className = "ls-ch";
    span.textContent = ch;
    // 基值 0.16s 与两侧/主句的入场对齐（出句 0.14s 淡完 → 新句 0.16s 起，中间只留一瞬空窗）；
    // 逐字再错峰 18ms，最长封顶 200ms —— 长句不会拖成“一个字一个字打出来”。
    span.style.animationDelay = 160 + Math.min(200, i * 18) + "ms";
    frag.appendChild(span);
  });
  segCur.appendChild(frag);
}

/** 侧欄“滑过去”：长句↔短句时中格宽度会变，两侧的锚点跟着挪（那是**重排**，透明度动画盖不住）。
 *  做法是 FLIP：换字前量旧位置、换完再量新位置，补一个反向位移然后放开 ——
 *  于是一直可见的它从旧位置滑到新位置。透明度降到 0.16 再回来，顺带把“换字”那一下磨平。
 *  用 WAAPI；旧宿主没有就退回“直接到位”（至少字是对的）。
 */
function glideSide(el, dx) {
  if (!el || !Number.isFinite(dx) || Math.abs(dx) < 0.5) return;
  try {
    const anim = el.animate(
      [
        { opacity: 0.16, transform: `translateX(${dx}px) scale(0.96)` },
        { opacity: 0.5, transform: "translateX(0) scale(0.96)" },
      ],
      { duration: 320, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "both" }
    );
    // 跑完就撤掉，免得每换一句都往元素上挂一个填充型动画（撤掉后回到 CSS 的静态值，与终态一致）
    if (anim && anim.finished) anim.finished.then(() => anim.cancel()).catch(() => {});
  } catch {
    /* 没有 WAAPI：不滑，至少字是对的 */
  }
}

function renderCenter(animate) {
  const has = lines.length > 0 && lastIndex >= 0;
  track.style.visibility = has ? "visible" : "hidden";
  if (!has) {
    lastCurText = "";
    return;
  }
  // lastIndex 已经是「显示用」的行号（frame 里过了 holdOf）；两侧各取前后最近的真句，
  // 这样中间那句不会空、两侧也不会出现空行。
  const cur = lastIndex;
  const prev = cur > 0 && holdOf[cur - 1] >= 0 ? holdOf[cur - 1] : -1;
  const next = nextRealOf[cur] >= 0 ? nextRealOf[cur] : -1;

  /* 2026-10-25 退回「三句一起推」（异羽：“不是现在这样从左走到右，是一下出现”）：
     三句**同时**换字、同时挂各自的入场动画（中句 ls-in-mid / 两侧 ls-in-side，同 0.42s 同曲线），
     观感是整条时间轴从左往右推一格，中句整句淡入而不是逐字浮现。
     0.18.2 ~ 0.18.58 那套（出句替身淡出 → 右廊同字接手 → 入句逐字落墨 + 两侧 FLIP 滑动）已停用，
     但代码都留着：renderCur / glideSide / segGhost 仍在，要再切回去恢复下面那几行调用即可。
     ⚠ 代价（当时就是这么发现的）：长句→短句时中格是 auto 宽度会变窄，两侧锚点会跟着挪；
        旧版靠“三句重新入场”把这一下盖过去，看起来就是“一起推”，并不真的解决重排。 */
  setSeg(segPrev, textAt(prev), animate ? "anim-prev" : "");
  setSeg(segCur, textAt(cur), animate ? "anim" : "");
  setSeg(segNext, textAt(next), animate ? "anim-next" : "");
  lastCurText = textAt(cur);
}

/* ---------------- 模式二：横向流动（从左往右） ----------------
 *
 * 带子的运动由一个**连续相位** p 决定：p 的整数部分是「第几句」、小数部分是句内进度，
 * 每句的 x 都等于 (p - 0.5 - j) × gap —— 所以 p 连续 ⇔ 位置连续（换句不会瞬移）。
 *
 * ⚠ 2026-10-17（用户在《亲爱的你啊》上抓到「把风景都看遍一闪就过去、有点跳」）：
 * p 原来是拿**真实时间**算的（cur + lineProgress），于是「一句 = 一格」这件事
 * 让速度 = 一格 ÷ 该句时长。而 LRC 每段末句后面常紧跟一个只有时间戳的空行（用来把画面清掉），
 * 那句的时长被压到 0.42~0.65 秒 —— 速度飙到正常句（7.8 秒）的 **18 倍**，看着就是一道光。
 * 修法（用户选的 1 号）：给每句的推进时间设下限 MIN_LINE_MS，多出来的时间从**后面的长间隔**里
 * 等量借回来。所以整条时间轴的总长不变，锚点最多偏移一个 MIN，且在那段长间奏走完前就追平。
 * 只动相位；卡拉OK 的逐字进度仍走真实时间（lineProgress）。
 *
 * 下限取多少是**量过的**（脚本 `Temp\歌词滚动-短句限速\verify-warp.mjs`，对象是《亲爱的你啊》
 * 里那句 0.42 秒的尾巴，相对“正常句 7.8 秒”的倍数）：
 *   1000ms → 7.4×，锚点最大偏差 0.58 句
 *   1200ms → 6.2×，0.65 句（第一版）
 *   1500ms → 5.0×，0.72 句 ← 用户 2026-10-17 定下这一版
 *   1800ms → 4.1×，0.70 句（债已还不完，兜底会按比例压整条轴）
 *   2400ms → 3.1×，0.64 句（兜底的影响更大）
 * 偏差的峰值都落在紧跟那段长间奏里（那时本来就不显示歌词），所以实际感受到的“晚”比数字小。
 */
const MIN_LINE_MS = 1500;
/** 调整后的每句起点 / 时长（秒）。只有滚动带用它；真句索引仍旧是 lines[].t。 */
let warpT = [];
let warpD = [];

function buildWarp() {
  const n = lines.length;
  warpT = new Array(n).fill(0);
  warpD = new Array(n).fill(0);
  if (!n) return;
  const minSec = MIN_LINE_MS / 1000;

  /* 2026-10-23 异羽定的「有条件兜底」（前两版的教训：全开会把整条轴带偏，全关会重新闪）：
   *
   *  只有同时满足两个条件才兜底：
   *    ① 这句短于 MIN_LINE_MS；
   *    ② **下一行是空行**（只有时间戳、没有文字）—— 也就是当年《亲爱的你啊》那种“短尾巴”。
   *  空的下一行本来就不显示（节感靠 holdOf 跳过），它的时长是“白借”的，
   *  从它身上扣，任何会显示的句子都不会被压缩 —— 所以不会再出现“整条轴被压、行云一路偏早”。
   *
   *  末尾那串制作人员行（吉他/混音/发行…）**永远不碰**：它们下一行不是空行，自然进不了这个分支；
   *  就算进了，借不到就放弃（下面的 0.05 余量判断），**任何情况下都不许按比例压整条轴**。 */
  const realD = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const start = lines[i].t;
    const end = i + 1 < n ? lines[i + 1].t : start + 4;
    realD[i] = Math.max(0, end - start);
    warpD[i] = realD[i];
  }
  const isBlank = (i) => i >= 0 && i < n && !String((lines[i] && lines[i].text) || "").trim();

  for (let i = 0; i < n - 1; i += 1) {
    if (realD[i] >= minSec) continue; // 够长，不用兜
    if (!isBlank(i + 1)) continue; // 下一行不是空行 —— 这就是制作人员行那类，不碰
    const need = minSec - realD[i];
    const donor = i + 1;
    if (warpD[donor] <= need + 0.05) continue; // 空行自己也短，借不出 → 放弃，保持真实时长
    warpD[i] = minSec;
    warpD[donor] -= need; // 空行不显示，从它身上扣，总长不变
  }

  let acc = lines[0].t;
  for (let i = 0; i < n; i += 1) {
    warpT[i] = acc;
    acc += warpD[i];
  }
}

/** 连续相位：句号 + 句内进度。< =0 表示还在第一句之前。 */
function flowPhase(pos) {
  const n = lines.length;
  if (!n || warpT.length !== n) return 0;
  if (pos <= warpT[0]) return 0;
  let i = 0;
  while (i < n - 1 && pos >= warpT[i + 1]) i += 1;
  const d = warpD[i] > 0 ? warpD[i] : 0.001;
  const p = (pos - warpT[i]) / d;
  return i + Math.max(0, Math.min(1, p));
}

function renderFlow(pos, index) {
  const width = flow.clientWidth || 420;
  // 格距跟着宽度走：太窄会挤成一团，太宽会半天不来一句。
  const gap = Math.max(230, Math.min(380, width * 0.62));
  const cur = Math.max(0, index);
  // 带子的相位走 buildWarp 那条「每句至少 MIN_LINE_MS」的时间轴（不是真实时间）。
  const rawPhase = flowPhase(pos);
  // 最后一句只走半格（2026-10-12 用户要求：到最后一句不要滚到尾部）。
  // 它从右侧滑进中心就停住；而上一句唱到尾时它正好在 0.5 格处，衔接处是连续的，不跳。
  const atLast = cur >= lines.length - 1;
  const phaseFloor = Math.floor(rawPhase);
  const phase = atLast ? phaseFloor + (rawPhase - phaseFloor) * 0.5 : rawPhase;
  const keep = new Set();
  const from = Math.max(0, cur - 2);
  const to = Math.min(lines.length - 1, cur + 2);
  for (let j = from; j <= to; j += 1) {
    keep.add(j);
    let item = flowItems.get(j);
    if (!item) {
      item = document.createElement("span");
      item.className = "ls-item";
      item.textContent = textAt(j);
      flow.appendChild(item);
      flowItems.set(j, item);
    }
    // 方向：字从左往右走。j 越大（越靠后的句子）越靠左，等着向右进场；
    // 当前句在自己的持续时间里从**左侧（-0.5 格）经正中滑到右侧（+0.5 格）**，
    // 所以它正好在「自己时长的中点」落在正中（最后一句只走半格，见上）。
    // 连续性：相位 p 在换句处两边等值（句尾 p→i+1，下一句开头 p=i+1），所以不会跳。
    const x = (phase - 0.5 - j) * gap;
    /* 「离中位多远」的权重（v0.17.5，用户 2026-10-17：「歌词在中间的时候还不够显眼」）。
       t 是线性距离，away 用**凸曲线** t^1.3：近中位处掉得慢、往外掉得快。
       为什么：当前句从左侧滑向右侧，只在「正中」附近一小段里最亮，
       线性 away 让它刚经过正中就掉到 0.48，跟旁边两句拉不开差距 —— 看着就“不够跳”。
       换成凸曲线后，正中那一带保持在接近 0 的区间，主次一眼分得出。 */
    const t = Math.min(1, Math.abs(x) / (gap * 1.05));
    const away = Math.pow(t, 1.3);
    /* 正中比字号档位再大 10%（1.10），最远收到 0.60；透明度也跟着更陡。
       这行的历史（前一个数是 scale 斜率、后一个是 opacity 斜率）：
         0.34 / 0.62 —— scale 1→0.66、opacity 1→0.38，尺寸比 1.5×、亮度比 2.6×
         0.50 / 0.74 —— 1.10→0.60、1→0.26，尺寸比 1.8×、亮度比 3.85×
         0.50 / 0.75 —— 尺寸比 1.8×（用户说“够大了”，不再往上）、**亮度比正好 4×**
                       （用户 2026-10-17：「尺寸够大了，亮度比试试到 4X」）
       亮度比 = 1 / (1 - 斜率)，所以：0.75→4×、0.8333→6×、0.875→8×、0.9→10×。 */
    item.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), -50%) scale(${(1.10 - away * 0.50).toFixed(3)})`;
    item.style.opacity = (1 - away * 0.75).toFixed(3);
    item.style.filter = away > 0.45 ? "blur(1.1px)" : "none";
    // 颜色也跟「离中位多远」走：正中 = 正在唱的主题色，越靠边越淡（与整页同一套色）。
    item.style.color = mixColor(away);
  }
  for (const [j, item] of flowItems) {
    if (!keep.has(j)) {
      item.remove();
      flowItems.delete(j);
    }
  }
}

/* ---------------- 模式三：卡拉OK（逐字上色） ---------------- */

function renderKara(pos, index) {
  const has = lines.length > 0 && index >= 0;
  if (!has) {
    if (karaBase.textContent) { karaBase.textContent = ""; karaFill.textContent = ""; }
    return;
  }
  const text = textAt(index);
  if (karaBase.textContent !== text) {
    karaBase.textContent = text;
    karaFill.textContent = text;
  }
  const p = karaokeProgress(pos, index);
  /* 2026-10-23：不再用 clip-path（硬切缝），把进度交给 CSS 的 mask 做软边过渡。 */
  karaFill.style.setProperty("--kara-p", p.toFixed(4));
}

function clearFlow() {
  for (const [, item] of flowItems) item.remove();
  flowItems.clear();
}

/* ---------------- 模式四：散雪（唱完碎成雪粒被风吹散） ----------------
 * 2026-10-20：用户在另一台机器上做了这一档（那边从 0.17.2 起，只改了歌词），
 * 原样合并进来，**取代**我给 0.17.9~0.17.11 做的那版「雪碎 / 碎玻璃」。
 * 取舍：他这版把整句先烘成图、再按字切块 —— 碎片与字是**同一份像素**，所以爆开那一帧不跳；
 * 而我这版是逐像素采点、原地生成粒子，形状能调但接缝难免。按用户意思：用他的。
 *
 * 与其它三档最大的不同：**这一档整句画在 canvas 上**，不经过 DOM 文本
 * （.ls-track 在这一档被 applyMode 隐藏）。实现在 ui/assets/shatter-text.js。
 *
 * 时间轴：这句「唱完」的时刻就爆开 —— 有逐字时间（yrc）按最后一个字唱完算，否则按下一句的时间；
 * 最后 0.55 秒先把整句 smoothstep 胀到 1.2 倍（吸气），爆开那一下正好到顶。
 */
/** 画面当前显示的是哪一行（-1 = 没在显示）。 */
let shatterLine = -1;
/** 已经碎掉的行号：唱完那一刻碎一次，避免同一句反复爆。 */
let shatterBurst = -1;

/** 一句的结束时刻。
 *  有逐字时间轴就用最后一个字唱完的时刻 —— 歌词里的「唱完」是字唱完，
 *  不是下一句开始（两句之间常有几秒间奏）。没逐字才退回下一句的时间。 */
function lineEndTime(index) {
  if (index < 0 || index >= lines.length) return Infinity;
  const line = lines[index];
  let charEnd = 0;
  if (Array.isArray(line.chars) && line.chars.length) {
    for (const c of line.chars) charEnd = Math.max(charEnd, c.t + c.dur);
  }
  const later = nextRealOf[index];
  const nextT = later >= 0
    ? lines[later].t
    : Math.max(line.t + 4, Number(snap.duration) || 0);
  if (charEnd > line.t) return Math.min(nextT, charEnd + 0.18);
  return nextT;
}

/** 面板的衬线族（从 body 的 computed style 读，与 DOM 那边同源）。 */
function readFamily() {
  try {
    return getComputedStyle(document.body).fontFamily || "serif";
  } catch {
    return "serif";
  }
}

function renderShatter(pos, shown, dt) {
  if (!shatter) return;
  const shard = ghostRgb || curRgb;
  shatter.configure({
    font,
    family: readFamily(),
    color: `rgb(${curRgb[0]}, ${curRgb[1]}, ${curRgb[2]})`,
    /* 碎片用居盈两侧那层灰（ghost）；整句仍用主题色，两张烘图分开。 */
    shardColor: `rgb(${shard[0]}, ${shard[1]}, ${shard[2]})`,
  });
  shatter.resize();

  // ① 吸气：最后 0.55 秒把整句缓缓胀到 1.2 倍。曲线用 smoothstep（两头缓、中间快），
  //    平方曲线会在末尾一下冲上去，看着像被弹了一下 —— 这里要的是吸气，不是弹跳。
  if (shatterLine >= 0 && shatterBurst !== shatterLine) {
    const remain = lineEndTime(shatterLine) - pos;
    const k = Number.isFinite(remain) ? Math.max(0, Math.min(1, 1 - remain / 0.55)) : 0;
    shatter.setEmphasis(k * k * (3 - 2 * k));
  }

  // ② 该不该碎：换到别的句子，或这一句已经唱完
  if (shatterLine >= 0 && shatterBurst !== shatterLine) {
    const ended = shown !== shatterLine || pos >= lineEndTime(shatterLine) - 0.02;
    if (ended) {
      shatter.burst();
      shatterBurst = shatterLine;
    }
  }

  // ③ 再把该显示的那句放上去
  if (shown !== shatterLine) {
    // 往回拖进度条（shown 变小）不爆，直接换句，免得倒带一路炸
    if (shatterLine >= 0 && shown < shatterLine) {
      shatter.reset();
      shatterBurst = -1;
    }
    shatterLine = shown;
    if (shown >= 0 && shown !== shatterBurst) shatter.setText(textAt(shown));
    else shatter.setText("");
  }

  shatter.tick(dt);
  shatter.draw();
}

function applyMode() {
  const scroll = mode === "scroll";
  const karaoke = mode === "karaoke";
  const shattering = mode === "shatter";
  // 散雪的整句是画在 canvas 上的，所以这一档要把 DOM 的 .ls-track 藏起来，否则字会重影。
  track.style.display = scroll || karaoke || shattering ? "none" : "";
  flow.hidden = !scroll;
  kara.hidden = !karaoke;
  if (shatterCanvas) shatterCanvas.hidden = !shattering;
  if (shatter) shatter.reset();
  shatterLine = -1;
  shatterBurst = -1;
  // 居庭的出句替身也一起清掉，否则切模式时会留一句半透明的旧字
  if (segGhost) {
    segGhost.textContent = "";
    segGhost.classList.remove("out");
  }
  clearTimeout(ghostTimer);
  lastCurText = "";
  clearFlow();
  lastIndex = -1;
}

/**
 * 跟随偏好：显示方式与字号可能被 mini（或 Agent 工具）在别处改了，而本页只在
 * 出生时读过一次，所以要定期核（主循环里每 2 秒一次）。
 */
async function syncConfig() {
  try {
    const cfg = await api("lyric-strip/config");
    if (cfg) {
      if (["center", "scroll", "karaoke", "shatter"].includes(cfg.mode) && cfg.mode !== mode) {
        mode = cfg.mode;
        applyMode();
      }
      const nextFont = Number(cfg.font);
      if (Number.isFinite(nextFont) && nextFont !== font) applyFont(nextFont);
      // 字体档（与整页共用一份设置）：别处改了，两秒内跟过来
      const nextFamily = String(cfg.family || "");
      if (nextFamily && (nextFamily !== family || !familyCss)) applyFamily(nextFamily, cfg.families);
      // 配色也可能被 mini / Agent 工具在别处改了
      const nextPalette = String(cfg.palette || "");
      if (nextPalette && nextPalette !== palette) applyPalette(nextPalette);
    }
    // 主题可能换了（亮/暗），颜色重读一次
    readColors();
  } catch {
    /* 拿不到就维持现状 */
  }
}

/* ---------------- 后端 ---------------- */

async function loadLyric(id) {
  const cached = lyricCache.get(id);
  // 只缓存真正有词的：空结果不能占着缓存，否则取源服务刚重启那次空会变成永久的「没歌词」。
  if (cached && cached.length) return cached;
  let parsed = [];
  /* 本地歌（id = `local:<文件名>`）：词在下载目录的归档夹里，直接取那份 .lrc。
   *  在线 `lyric?id=` 对 `local:` 开头永远查不到 —— 带子就一直是空的（2026-10-22 异羽报的）。
   *  没有归档就老实空着，不反复重试。 */
  if (id.startsWith("local:")) {
    try {
      const r = await api("local/lyric?id=" + encodeURIComponent(id));
      if (r && r.ok) {
        /* 有逐字（lyrics.yrc）就优先用它 —— 层染按字同步，而不是整行匀速（2026-10-23）。 */
        const yrc = parseYrc(r.yrc);
        parsed = yrc.length ? yrc : parseLrc(r.lyric);
      }
    } catch {
      parsed = [];
    }
    if (parsed.length) lyricCache.set(id, parsed);
    return parsed;
  }
  try {
    const r = await api(`lyric?id=${encodeURIComponent(id)}`);
    // 优先用 yrc（逐字，卡拉OK 用）；没给就退回行级 lrc。
    const yrc = parseYrc(r && r.yrc);
    parsed = yrc.length ? yrc : parseLrc(r && r.lyric);
  } catch {
    parsed = [];
  }
  if (parsed.length) lyricCache.set(id, parsed);
  return parsed;
}

async function refresh() {
  let st = null;
  try {
    st = await api("state");
  } catch {
    return;
  }
  if (!st || st.ok === false) return;
  snap = {
    position: Number(st.position) || 0,
    duration: Number(st.duration) || 0,
    playing: !!st.playing,
    at: Date.now(),
  };
  const song = st.song || null;
  const id = song && song.id ? String(song.id) : "";
  songName = song && song.name ? String(song.name) : "";
  if (id !== songId) {
    songId = id;
    songName = song && song.name ? String(song.name) : "";
    setLines([]);
    lastIndex = -1;
    lyricTries = 0;
    lyricRetryAt = 0;
    clearFlow();
  }
  // 没词就补一次（含换歌）；空结果 12 秒后再试，连试 2 次才当「确实没词」（纯音乐）。
  if (id && !lines.length && Date.now() >= lyricRetryAt && lyricTries < 2) {
    setLines(await loadLyric(id));
    lastIndex = -1;
    if (lines.length) {
      lyricTries = 0;
    } else {
      lyricTries += 1;
      lyricRetryAt = Date.now() + 12000;
    }
  }
}

/** 本地推位置：只在「在播」时走时钟，暂停就冻住。 */
function posNow() {
  if (!snap.playing) return snap.position;
  return snap.position + (Date.now() - snap.at) / 1000;
}

/* ---------------- 启动与主循环 ---------------- */

// initHana 在没有宿主的环境里会一直等握手（比如用浏览器直接打开这个页面看样式），
// 加一道超时，免得后面的渲染逻辑全被挂着不跑（也便于用 headless 截图自查）。
const hana = await Promise.race([
  initHana(),
  new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
]);
if (hana) {
  await declareInteractive(hana);
  window.addEventListener("resize", () => void declareInteractive(hana));
}
readColors();
// 主题表来晚了要再读（「颜色跟主题走」靠这一步 + 主循环里那 2 秒一次的核对）
watchThemeColors(hana);

try {
  const cfg = await api("lyric-strip/config");
  if (cfg) {
    if (["center", "scroll", "karaoke", "shatter"].includes(cfg.mode)) mode = cfg.mode;
    if (Array.isArray(cfg.fonts) && cfg.fonts.length) fontSteps = cfg.fonts.map(Number);
    applyPalette(String(cfg.palette || "theme"));
    const saved = Number(cfg.font);
    applyFont(Number.isFinite(saved) && fontSteps.includes(saved) ? saved : fontSteps[1] ?? 20);
    applyFamily(String(cfg.family || "hana"), cfg.families);
  } else {
    applyPalette("theme");
    applyFont(fontSteps[1] ?? 20);
  }
} catch {
  applyPalette("theme");
  applyFont(fontSteps[1] ?? 20);
}
applyMode();

await refresh();

let lastFetch = 0;
let lastConfigCheck = 0;

/**
 * 「有歌但确实没词」= 纯音乐。判据用重试次数（拉过 2 次都是空），
 * 这样「取源还在就绪中」不会被误当成纯音乐。那行说明就写「歌名 · 纯音乐」。
 */
function syncIdle() {
  const pure = !!(songId && !lines.length && lyricTries >= 2);
  document.body.classList.toggle("pure", pure);
  if (idle.hidden === !pure) return;
  idle.hidden = !pure;
  if (pure) idle.textContent = songName ? `${songName} · 纯音乐` : "纯音乐";
}

/** 换句的提前量（秒）——**现在是 0**。
 *  历史：2026-10-22 为了让带子和整页一致（整页用 t <= 位置 + 0.15），我先给了 0.15。
 *  当晚异羽直接指出“还是快了 0.1 秒” —— 这个量人耳真的能听出来。
 *  带子的位置本身就是准的，就不该再往前偷时间：到点换字，不早不晚。 */
const LINE_LEAD_SEC = 0;

function frame() {
  const now = Date.now();
  const frameNow = performance.now();
  const dt = lastFrameAt ? Math.min(0.05, (frameNow - lastFrameAt) / 1000) : 0.016;
  lastFrameAt = frameNow;
  if (now - lastFetch > 1000) {
    lastFetch = now;
    void refresh();
  }
  if (now - lastConfigCheck > 2000) {
    lastConfigCheck = now;
    void syncConfig();
  }
  const pos = posNow() + LINE_LEAD_SEC;
  const index = pickIndex(pos);
  // 单句显示（center / karaoke / shatter）跳过留白行：停在最近一句真词上；滚动模式照旧用原始行号。
  const shown = mode === "scroll" || index < 0 || holdOf[index] < 0 ? index : holdOf[index];
  if (shown !== lastIndex) {
    // 首次进入不播动画（免得一挂上就闪），往后每次换句都走一次过渡。
    const animate = lastIndex >= 0;
    lastIndex = shown;
    if (mode === "center") renderCenter(animate);
  }
  if (mode === "scroll" && lines.length) renderFlow(pos, index);
  if (mode === "karaoke") renderKara(pos, shown);
  // 散雪：整句在 canvas 上，换句与「唱完爆开」都由 renderShatter 自己按时间轴处理。
  // 它只是装饰：出任何意外都不该把主循环带走 —— rAF 回调一抛异常，后面的
  // requestAnimationFrame 就不会被调到，整条歌词条直接冻死。
  if (mode === "shatter") {
    try {
      renderShatter(pos, shown, dt);
    } catch {
      /* 这一帧画不出来就算了，下一帧再来 */
    }
  }
  syncIdle();
  requestAnimationFrame(frame);
}

let lastFrameAt = 0;
requestAnimationFrame(frame);
