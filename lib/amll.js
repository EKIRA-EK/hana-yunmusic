/**
 * lib/amll.js — 按需从 AMLL TTML DB 取逐字歌词（2026-10-28）。
 *
 * 为什么是「按需」而不是批量搬：
 *   这个库按投稿量长，覆盖率与歌热不热高度相关。对异羽的曲库实测命中 1/176
 *   （下载库 126 首命中 1、当时队列 50 首命中 0），批量入库毫无意义；
 *   但「播放时问一句，有就用」成本只有一次请求，而且库长大后自动受益。
 *
 * 数据来源：https://github.com/amll-dev/amll-ttml-db（CC0），按**网易云 id** 存
 *   `ncm-lyrics/<id>.ttml`。它的投稿规则只对含有效网易云 ID 的歌词作逐字质量保证，
 *   所以时间轴校的是网易云那一版音频 —— 不会出现「贴到另一版录音整首偏几秒」。
 *
 * 网络：raw.githubusercontent.com 在本机直连不通（实测 193ms 就断），走社区镜像
 *   amlldb.bikonoo.com，内容与 raw 一致（《晴天》两边都是 29077 字节）。
 *   应用进程里必须用 ctx.network.fetch —— 裸 fetch 在宿主权限模型下 ERR_ACCESS_DENIED。
 *
 * 输出：转成**标准 yrc 文本**（`[行起,行时长](字起,字时长,0)字…`），
 *   前端 ui/assets/lyric-strip.js 的 parseYrc 直接就能吃，不用改前端。
 */

const MIRROR = "https://amlldb.bikonoo.com/ncm-lyrics/";
const TIMEOUT_MS = 6000;
const MAX_BYTES = 1024 * 1024;
/** 命中的缓存基本不过期；未命中 24 小时内不再问（别每次播放都打一次 404）。 */
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

/** TTML 时间：`12.345` / `1:23.456` / `00:01:23.456` → 秒。 */
function parseTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  const parts = raw.split(":");
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return Number.isFinite(sec) ? sec : NaN;
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
const unescape = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] || m);

/** 去掉 `ttm:role="x-bg"`（背景和声）与 `x-translation`（翻译）的整棵子树。 */
function dropRoles(fragment) {
  let out = "";
  let i = 0;
  while (i < fragment.length) {
    const open = fragment.indexOf("<span", i);
    if (open < 0) {
      out += fragment.slice(i);
      break;
    }
    out += fragment.slice(i, open);
    const tagEnd = fragment.indexOf(">", open) + 1;
    if (tagEnd <= 0) break;
    const head = fragment.slice(open, tagEnd);
    const skip = /ttm:role="(?:x-bg|x-translation)"/.test(head);
    if (head.endsWith("/>")) {
      if (!skip) out += head;
      i = tagEnd;
      continue;
    }
    // 找配对的 </span>（允许嵌套）
    let depth = 1;
    let j = tagEnd;
    while (depth > 0) {
      const nextOpen = fragment.indexOf("<span", j);
      const nextClose = fragment.indexOf("</span>", j);
      if (nextClose < 0) {
        j = fragment.length;
        break;
      }
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        j = fragment.indexOf(">", nextOpen) + 1;
      } else {
        depth -= 1;
        j = nextClose + 7;
      }
    }
    const bodyEnd = Math.max(tagEnd, j - 7);
    if (!skip) out += head + fragment.slice(tagEnd, bodyEnd) + "</span>";
    i = j;
  }
  return out;
}

/**
 * TTML → 标准 yrc。
 * 只取正文行：每个 `<p>` 的**直接**主词 span 拼成一行；空格 span 并入（不进 chars）。
 */
export function ttmlToYrc(ttml) {
  const text = String(ttml || "");
  const bodyStart = text.indexOf("<body");
  if (bodyStart < 0) return "";
  const body = text.slice(bodyStart);

  const lines = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let pm;
  while ((pm = pRe.exec(body))) {
    const attrs = pm[1];
    const inner = dropRoles(pm[2]);
    /* 一行里可能有背景和声以外的主词；逐个 span 取 begin/end/文本。 */
    const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/g;
    const chars = [];
    let sm;
    let lastEnd = 0;
    while ((sm = spanRe.exec(inner))) {
      /* span 之间的裸文本：通常就是一个空格（英文分词靠它）。
         不处理的话 "Hello world" 会粘成 "Helloworld"（2026-10-28 样本里中文也有）。 */
      const between = inner.slice(lastEnd, sm.index);
      if (chars.length && /[ \u00a0]/.test(between)) chars[chars.length - 1].space = true;
      lastEnd = sm.index + sm[0].length;
      const sa = sm[1];
      const b = /begin="([^"]+)"/.exec(sa);
      const e = /end="([^"]+)"/.exec(sa);
      if (!b || !e) continue;
      const raw = unescape(sm[2].replace(/<[^>]*>/g, ""));
      const t = parseTime(b[1]);
      const end = parseTime(e[1]);
      if (!Number.isFinite(t) || !Number.isFinite(end) || end < t) continue;
      if (!raw) continue;
      /* 纯空白（词间空格）保留在行文本里，但不算一个字 */
      if (!raw.trim()) {
        if (chars.length) chars[chars.length - 1].space = true;
        continue;
      }
      chars.push({ t, dur: end - t, text: raw });
    }
    if (!chars.length) continue;
    const lineStart = chars[0].t;
    const last = chars[chars.length - 1];
    const lineEnd = /end="([^"]+)"/.exec(attrs);
    const lineStop = lineEnd ? parseTime(lineEnd[1]) : last.t + last.dur;
    const lineDur = Math.max(0.2, (Number.isFinite(lineStop) ? lineStop : last.t + last.dur) - lineStart);
    const bodyText = chars.map((c) => c.text + (c.space ? " " : "")).join("").trim();
    if (!bodyText) continue;
    const ms = (v) => Math.max(0, Math.round(v * 1000));
    const piece = chars
      .map((c) => `(${ms(c.t)},${Math.max(1, ms(c.dur))},0)${c.text}${c.space ? " " : ""}`)
      .join("");
    lines.push({ t: lineStart, line: `[${ms(lineStart)},${ms(lineDur)}]${piece}` });
  }

  lines.sort((a, b) => a.t - b.t);
  return lines.map((l) => l.line).join("\n");
}

export function createAmll({ ctx, dataDir, logger }) {
  let fs = null;
  let path = null;
  const cacheDir = dataDir ? String(dataDir) + "/amll-cache" : "";
  const memory = new Map();
  /** 同一首正在取的那次请求（整页与带子可能同时要）。 */
  const pending = new Map();

  async function ensureFs() {
    if (fs) return true;
    try {
      fs = await import("node:fs");
      path = await import("node:path");
      if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
      return true;
    } catch (error) {
      if (logger) logger.warn && logger.warn("amll 缓存不可用：" + String((error && error.message) || error));
      return false;
    }
  }

  function cachePath(id, ext) {
    return path.join(cacheDir, String(id).replace(/[^\w.-]/g, "_") + ext);
  }

  async function readHit(id) {
    if (memory.has(id)) return memory.get(id);
    if (!(await ensureFs())) return "";
    try {
      const file = cachePath(id, ".yrc");
      if (!fs.existsSync(file)) return "";
      const text = fs.readFileSync(file, "utf8");
      memory.set(id, text);
      return text;
    } catch {
      return "";
    }
  }

  async function missedRecently(id) {
    if (!(await ensureFs())) return false;
    try {
      const st = fs.statSync(cachePath(id, ".miss"));
      return Date.now() - st.mtimeMs < MISS_TTL_MS;
    } catch {
      return false;
    }
  }

  async function writeMiss(id) {
    if (!(await ensureFs())) return;
    try {
      fs.writeFileSync(cachePath(id, ".miss"), String(Date.now()), "utf8");
    } catch {
      /* 写不进去就下次再问一遍，不影响播放 */
    }
  }

  async function writeHit(id, yrc) {
    memory.set(id, yrc);
    if (!(await ensureFs())) return;
    try {
      fs.writeFileSync(cachePath(id, ".yrc"), yrc, "utf8");
      const miss = cachePath(id, ".miss");
      if (fs.existsSync(miss)) fs.unlinkSync(miss);
    } catch {
      /* 同上 */
    }
  }

  async function fetchTtml(id) {
    const url = MIRROR + encodeURIComponent(id) + ".ttml";
    const res = await ctx.network.fetch(url, { method: "GET", timeoutMs: TIMEOUT_MS, maxResponseBytes: MAX_BYTES });
    if (!res.ok) return "";
    return await res.text();
  }

  /**
   * 取一首歌的逐字歌词（yrc 文本）。永不抛错：取不到就返回空串，调用方退回行级。
   * @param {string} id 网易云歌曲 id
   */
  async function getYrc(id) {
    const key = String(id || "").trim();
    if (!key || key.startsWith("local:")) return "";
    const hit = await readHit(key);
    if (hit) return hit;
    if (await missedRecently(key)) return "";
    /* 整页与歌词带子会同时要同一首：合并成一次请求，别打两枪。 */
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const ttml = await fetchTtml(key);
        if (!ttml) {
          await writeMiss(key);
          return "";
        }
        const yrc = ttmlToYrc(ttml);
        if (!yrc) {
          await writeMiss(key);
          return "";
        }
        await writeHit(key, yrc);
        if (logger) logger.info && logger.info(`逐字：AMLL 命中 ${key}（${yrc.length} 字）`);
        return yrc;
      } catch (error) {
        if (logger) logger.warn && logger.warn(`逐字：AMLL 取 ${key} 失败 ${String((error && error.message) || error)}`);
        /* 网络异常不记 miss —— 下次还能再试 */
        return "";
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, task);
    return task;
  }

  return { getYrc, cacheDir };
}
