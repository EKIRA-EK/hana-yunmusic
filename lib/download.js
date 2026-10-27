/**
 * lib/download.js — 下载控制（App 侧）。
 *
 * 真正的字节由 runtime/downloader.cjs 那个本机小服务去取（原因见那个文件的头注释：
 * 应用进程吃 HTTPS-only 与 8MB 两条限制，而且写不到用户选的目录）。
 *
 * 这一层只管三件事：
 *   1. 把歌曲换成直链（走 api.songUrl，跟播放同一份取源）；
 *   2. 决定落盘路径与文件名；
 *   3. 把下载器报回来的任务状态整理成界面能看的样子。
 */

import os from "node:os";
import path from "node:path";

export const DL_BASE = "http://127.0.0.1:3320";

/**
 * 把网易云的“富文本行”转成标准 LRC 行（与 Tools\HANA云音乐-归档\rich-lrc.mjs 同一套规则）。
 *
 * 背景：/lyric 返回的 lyric 里，最前几行不是 LRC，而是：
 *     {"t":255,"c":[{"tx":"作曲: "},{"tx":"Tide潮汐"}]}
 * t 是毫秒，c 是文字片段。直接存进 lyrics.lrc 会让播放器解析不出那几行。
 * 顺手把“短标签 + 冒号”的制作人员行（作词/作曲/吉他 :/发行 :）也丢掉 ——
 * 它们在富文本里天然被跳过，转成普通行后却会变成歌词一句句刷过去。
 */
const CREDIT_LINE = /^[^\s:：，。！？]{1,10}\s*[:：]\s*\S/;

export function richToLrc(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const obj = JSON.parse(line);
        const t = Number(obj.t) || 0;
        const body = (Array.isArray(obj.c) ? obj.c : []).map((c) => String((c && c.tx) || "")).join("").trim();
        if (!body || CREDIT_LINE.test(body)) continue;
        const mm = String(Math.floor(t / 60000)).padStart(2, "0");
        const ss = String(Math.floor((t % 60000) / 1000)).padStart(2, "0");
        const ms = String(Math.round(t % 1000)).padStart(3, "0");
        out.push(`[${mm}:${ss}.${ms}] ${body}`);
      } catch {
        /* 不是合法 JSON：宁可不存这一行 */
      }
      continue;
    }
    const m = /^\[(\d+:\d+[.\d]*)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    if (CREDIT_LINE.test(m[2].trim())) continue;
    out.push(line);
  }
  return out.length ? out.join("\n") + "\n" : "";
}
/**
 * 默认下载目录。**必须与机器无关**：本机用户选的目录（工作区里的 Downloads）会落在
 * storage 的 `download-v1` 里，所以这里给的是「换台机器也说得通」的默认值。
 */
export const DEFAULT_DIR = path.join(os.homedir(), "Downloads", "HANA云音乐");
/** 用户要的四档（v0.16.3 加了「标准」：未登录时只有它真生效）。 */
export const DL_LEVELS = ["standard", "exhigh", "lossless", "hires"];
export const DL_LEVEL_LABEL = {
  standard: "标准 128K",
  exhigh: "320K MP3",
  lossless: "无损 FLAC",
  hires: "Hi-Res FLAC",
};

const EXT_OF = { standard: "mp3", exhigh: "mp3", lossless: "flac", hires: "flac" };
const KNOWN_EXT = new Set(["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "ape", "wma"]);
/** 一次整单最多排多少首。批量取直链按 100 首分块，300 首 = 3 次调用，够快又不会把界面挂住。 */
const MAX_BATCH = 300;
/** 各档的**名义**码率（bps）。用来判断接口是不是悄悄回落了。 */
const NOMINAL_BR = { standard: 128000, exhigh: 320000, lossless: 800000, hires: 1400000 };

/**
 * 落盘后缀取**接口实际给的格式**（record.type），不取请求的档位。
 *
 * 踩过（2026-10-15）：没登录时接口把所有档都**静默回落**成 128k mp3
 * （实测 br=128018、type=mp3，九档一模一样），而 `type` 字段是如实回的。
 * 若照旧按请求档命名，就会得到一个「.flac」外壳里装着 128k mp3 的**假无损** ——
 * 这种错标最难发现：文件能放、播放器也当无损读，只到哪天认真一看才发现。
 */
export function extFor(record, level) {
  const t = String((record && record.type) || "").toLowerCase().trim();
  if (KNOWN_EXT.has(t)) return t;
  /* 接口没给 type 时退到按档猜（就这一条老路） */
  return EXT_OF[level] || "mp3";
}

/** 请求的档位与实际码率对不上 = 回落了。 */
export function fellBackFrom(record, level) {
  const nominal = NOMINAL_BR[level] || 0;
  const actual = Number((record && record.br) || 0);
  return nominal > 0 && actual > 0 && actual < nominal * 0.8;
}
const STATE_KEY = "download-v1";
/** 封面怎么存（2026-10-22 用户）：small 默认取小图 / original 原图 / none 不下载封面。
 *  网易的图 URL 支持 `?param=WxH`；实测原图一张能到 **6.9MB**，500y500 只有几十 KB。 */
const COVER_MODES = ["small", "original", "none"];
const COVER_SMALL = "500y500";
/** 按选项把封面地址改成对应的尺寸（去掉原有 query，再接 param）。 */
function sizeCover(url, mode) {
  const raw = String(url || "");
  if (!raw || mode === "none") return "";
  if (mode === "original") return raw;
  return raw.split("?")[0] + "?param=" + COVER_SMALL;
}

/** Windows 文件名里不能出现的字符，一律换成下划线。 */
function safeName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function createDownloader({ ctx, api, service, storage, logger }) {
  const tasks = new Map(); // 下载器任务 id → 我们这边记的说明（歌名 / 档位 / 目标路径）
  let dir = DEFAULT_DIR;
  // 下载音质档：以前它是纯前端 select，每次开页面都跳回「无损」。现在跟目录一起存在 download-v1 里。
  let defaultLevel = "lossless";
  let seq = 0;
  /** 封面选项：small（默认）/ original / none。与目录、档位一起存在 download-v1。 */
  let coverMode = "small";

  function log(level, ...args) {
    try {
      if (logger && typeof logger[level] === "function") logger[level](...args);
    } catch {
      /* ignore */
    }
  }

  function persist() {
    try {
      if (storage) storage.set(STATE_KEY, { dir, level: defaultLevel, cover: coverMode });
    } catch {
      /* ignore */
    }
  }

  function init(saved) {
    if (saved && typeof saved.dir === "string" && saved.dir.trim()) dir = saved.dir.trim();
    if (saved && DL_LEVELS.includes(String(saved.level))) defaultLevel = String(saved.level);
    if (saved && COVER_MODES.includes(String(saved.cover))) coverMode = String(saved.cover);
    return { dir, level: defaultLevel, cover: coverMode };
  }

  function getCoverMode() {
    return coverMode;
  }

  function setCoverMode(next) {
    const value = String(next || "").trim();
    if (!COVER_MODES.includes(value)) return { ok: false, error: "封面选项不合法：" + value };
    coverMode = value;
    persist();
    return { ok: true, cover: coverMode };
  }

  /** 暂停 / 继续整单下载（2026-10-23）：待下的留在下载器那边，一首都不丢。 */
  async function pauseDownloads(on) {
    const started = await service.ensure();
    if (!started) return { ok: false, error: "下载器没起来（宿主的托管运行时不可用）" };
    if (!(await waitReady())) return { ok: false, error: "下载器端口未就绪" };
    const reply = await call(on ? "/pause" : "/resume", {}, 10000);
    if (!reply) return { ok: false, error: "下载器没有回音" };
    return reply;
  }

  /** 读 HANA 字体库里用户导入的字体（名字与 family 而已，不搬文件）。 */
  async function listFonts() {
    const started = await service.ensure();
    if (!started) return { ok: false, error: "下载器没起来" };
    if (!(await waitReady())) return { ok: false, error: "下载器端口未就绪" };
    const reply = await call("/fonts", null, 10000);
    if (!reply) return { ok: false, error: "下载器没有回音" };
    return reply;
  }

  /** 弹系统原生的文件夹选择框（下载器子进程代劳——应用进程弹不了 GUI）。取消回空串。 */
  async function browseDir() {
    const started = await service.ensure();
    if (!started) return { ok: false, error: "下载器没起来（宿主的托管运行时不可用）" };
    if (!(await waitReady())) return { ok: false, error: "下载器端口未就绪" };
    const reply = await call(`/browse?dir=${encodeURIComponent(dir)}`, null, 180000);
    if (!reply) return { ok: false, error: "选择框没有回音" };
    return reply;
  }

  function getDir() {
    return dir;
  }

  function setDir(next) {
    const value = String(next || "").trim().replace(/[\\/]+$/, "");
    if (!value) return { ok: false, error: "目录不能为空" };
    dir = value;
    persist();
    return { ok: true, dir };
  }

  function getLevel() {
    return defaultLevel;
  }

  function setLevel(next) {
    const value = String(next || "");
    if (!DL_LEVELS.includes(value)) return { ok: false, error: "下载音质档不合法：" + value };
    defaultLevel = value;
    persist();
    return { ok: true, level: defaultLevel };
  }

  async function call(route, body, timeoutMs) {
    const init = { method: body ? "POST" : "GET", timeoutMs: timeoutMs || 8000, maxResponseBytes: 512 * 1024 };
    if (body) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await ctx.network.fetch(DL_BASE + route, init);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: `下载器返回非 JSON（HTTP ${res.status}）` };
    }
  }

  /**
   * ensure() 只保证「宿主已接单」，不保证端口已经在听。补一次探活，
   * 否则第一次下载会撞上启动竞态（表现为 fetch failed）。
   */
  async function waitReady(budgetMs = 20000) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      try {
        const reply = await call("/ping", null, 3000);
        if (reply && reply.ok === true) return true;
      } catch {
        /* 还没起来，继续等 */
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  /**
   * 排一首。opts.level 不传按 lossless；opts.prefix 是批量下载时的序号前缀（如 "03 "）。
   * opts.record 是**已经拿到的直链**（整批走批量接口一次问回来的，见 enqueueList）。
   * 只负责「把任务交出去」，不等它下完——进度靠 status() 轮。
   */
  async function enqueue(song, opts = {}) {
    const id = String((song && song.id) || "");
    if (!id) return { ok: false, error: "缺少歌曲 id" };
    const level = DL_LEVELS.includes(String(opts.level)) ? String(opts.level) : defaultLevel;
    const label = DL_LEVEL_LABEL[level];

    let record = opts.record || null;
    if (!record) {
      try {
        record = await api.songUrl(id, level);
      } catch (error) {
        return { ok: false, error: "取音源失败：" + String((error && error.message) || error) };
      }
    }
    if (!record || !record.url) {
      return { ok: false, error: `「${String(song.name || id)}」在 ${label} 档拿不到音源` };
    }

    const ext = extFor(record, level);
    /* 多艺人：网易云给的是 “A _ B”，直接拼进文件名会变成「任素汐 _ 罗晋」——
       列表里难读，拿它去搜索还会一律搜不到（2026-10-23 补封面时验证过）。
       存盘时统一换成 “ & ”，与界面上的显示口径一致。 */
    const artistText = String(song.artist || "").replace(/\s*_\s*/g, " & ");
    const base = `${safeName(artistText) || "未知歌手"} - ${safeName(song.name) || id}`;
    /* 重下去重（2026-10-23）：已经下过同一首时，**沿用已有文件名覆盖**。
       否则批量下的带序号（003 任素汐 - 王招君.mp3）、单曲下的不带序号，
       重下就多出一份裸名副本 + 第二个归档夹（实测过）。
       匹配用“歌手 + 歌名”（本地列表已解析好），命中就把原有前缀一起拿过来。 */
    const norm = (v) =>
      String(v || "")
        .toLowerCase()
        .replace(/[\s·・.,:;!?'"“”‘’()（）\[\]【】\-_/_\\|&]+/g, "");
    let prefix = String(opts.prefix || "");
    try {
      const lib = await listLocal();
      const wantArtist = norm(artistText);
      const wantTitle = norm(song.name);
      const hit = (lib && lib.ok && lib.items ? lib.items : []).find(
        (it) => norm(it.artist) === wantArtist && norm(it.name) === wantTitle
      );
      if (hit && hit.path) {
        const oldName = path.basename(String(hit.path));
        const oldExt = path.extname(oldName);
        const oldStem = oldName.slice(0, -oldExt.length);
        const hitIndex = /^(\d+\s+)/.exec(oldStem);
        if (hitIndex) {
          // 保留原来的序号，并沿用原来的扩展名（同一首换档位重下时会换扩展名，那就只借序号）
          prefix = hitIndex[1];
        }
      }
    } catch {
      /* 查库失败就按新文件处理，不阻塞下载 */
    }
    /* 2026-10-22 用户定的布局：
       · **音频平铺**在下载目录根下（别的播放器直接扫目录就能认，不必逐层翻寄）
       · **封面 / 歌词 / meta 单独归档**到 `<dir>\\封面歌词\\<歌名>\\`，不污染音频目录 */
    const file = `${String(opts.prefix || "")}${base}.${ext}`;
    const dest = `${dir}\\${file}`;
    const sidecarDir = `${dir}\\封面歌词\\${file.replace(/\.[^.]+$/, "")}`;

    /* 名义码率对不上就是回落了（没登录最常见的形态）：记一笔，也跟任务一起报给界面。 */
    const actualBr = Number(record.br) || 0;
    const actualType = String(record.type || "");
    const fellBack = fellBackFrom(record, level);
    if (fellBack) {
      log(
        "warn",
        `hana-music163: 「${String(song.name || id)}」要的是 ${label}，接口只给了 ${Math.round(actualBr / 1000)}kbps ${actualType}（多半是没登录）`,
      );
    }

    const started = await service.ensure();
    if (!started) return { ok: false, error: "下载器没起来（宿主的托管运行时不可用）" };
    if (!(await waitReady())) return { ok: false, error: "下载器已拉起但端口未就绪，稍后重试" };

    // 封面：按选项取（默认小图）。none 就不下封面，目录里只会少 cover.jpg
    let coverUrl = "";
    if (coverMode !== "none") {
      let rawCover = String((song && song.coverUrl) || "");
      if (!rawCover) {
        try {
          const detail = await api.songDetail([id]);
          const hit = Array.isArray(detail) ? detail.find((x) => String(x.id) === String(id)) : null;
          if (hit && hit.coverUrl) rawCover = String(hit.coverUrl);
        } catch {
          /* 取不到封面不影响下载音频 */
        }
      }
      coverUrl = sizeCover(rawCover, coverMode);
    }
    let lyric = "";
    try {
      const ly = await api.lyric(id);
      /* 2026-10-23：拿到的 lyric 最前几行是富文本，以前直接存进去 → 开头几行解析不出来
         （起风了 / 那些花儿 / 明月天涯 三首就是这样）。现在存盘前统一转成标准 LRC。 */
      lyric = richToLrc(String((ly && ly.lyric) || ""));
    } catch {
      /* 取不到歌词也照样下音频；目录里就不会有 lyrics.lrc */
    }
    const meta = {
      id,
      name: String((song && song.name) || ""),
      artist: String((song && song.artist) || ""),
      album: String((song && song.album) || ""),
      level,
      ext,
      br: Number(record.br) || 0,
      type: String(record.type || ""),
      coverUrl,
      at: new Date().toISOString(),
    };

    const reply = await call("/fetch", { url: record.url, dest, sidecarDir, coverUrl, lyric, meta }, 20000);
    if (!reply || reply.ok !== true || !reply.id) {
      return { ok: false, error: (reply && reply.error) || "下载器没有接单" };
    }

    tasks.set(reply.id, {
      id: reply.id,
      songId: id,
      name: String(song.name || ""),
      artist: String(song.artist || ""),
      album: String(song.album || ""),
      level,
      label,
      ext,
      actualBr,
      actualType,
      fellBack,
      path: dest,
      at: Date.now(),
    });
    log("info", "hana-music163: 已排下载", JSON.stringify({ id: reply.id, level, file, actualBr, actualType, fellBack }));
    return { ok: true, id: reply.id, path: dest, level, label, ext, actualBr, actualType, fellBack };
  }

  /**
   * 整批排。序号按总数补零，保证目录里排序不乱。
   *
   * ⚠ 直链要**一次批量问回来**，不能一首一首问：/song/url/v1 支持 id 逗号串（批量接口会自动
   * 分块，百首一次）。踩过（2026-10-15）：100 首逐个问要一两分钟，宿主的路由先超时返回 500
   * —— 界面弹出「Internal Server Error」，而后台循环还在跑、歌照下完（用户看到的怪现象）。
   */
  async function enqueueList(list, opts = {}) {
    const all = Array.isArray(list) ? list.filter((s) => s && s.id) : [];
    if (!all.length) return { ok: false, error: "没有可下载的曲目" };
    const items = all.slice(0, MAX_BATCH);
    const level = DL_LEVELS.includes(String(opts.level)) ? String(opts.level) : defaultLevel;
    const total = items.length;
    const width = String(total).length;

    /* 先批量拿直链（一次调用，约一秒）；拿不到的在下面对应项上自然成为「失败」。 */
    let urls = {};
    try {
      urls = await api.songUrls(items.map((s) => s.id), level);
    } catch (error) {
      log("warn", "hana-music163: 批量取音源失败，逐首回退", String((error && error.message) || error));
      urls = {};
    }

    const queued = [];
    const failed = [];
    for (let i = 0; i < total; i += 1) {
      const prefix = total > 1 ? `${String(i + 1).padStart(width, "0")} ` : "";
      const record = urls[String(items[i].id)] || null;
      const r = await enqueue(items[i], Object.assign({}, opts, { prefix, level, record }));
      if (r.ok) queued.push(r.id);
      else failed.push({ name: String(items[i].name || ""), error: r.error });
    }
    return {
      ok: true,
      total,
      queued: queued.length,
      failed,
      truncated: all.length > items.length ? all.length - items.length : 0,
    };
  }

  /** 下载器的任务状态 + 本地记的歌名。界面轮这个。 */
  async function status() {
    let jobs = [];
    try {
      const reply = await call("/jobs", null, 6000);
      if (reply && reply.ok && Array.isArray(reply.jobs)) jobs = reply.jobs;
    } catch {
      /* 下载器没起来就没有任务 */
    }
    const out = jobs.map((job) => {
      const meta = tasks.get(job.id) || {};
      return {
        id: job.id,
        songId: meta.songId || "",
        name: meta.name || "",
        artist: meta.artist || "",
        label: meta.label || "",
        state: job.state || "",
        bytes: Number(job.bytes) || 0,
        total: Number(job.total) || 0,
        path: job.path || meta.path || "",
        error: job.error || "",
      };
    });
    const counts = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const job of out) counts[job.state] = (counts[job.state] || 0) + 1;
    const live = counts.queued + counts.running;
    return { ok: true, dir, counts, live, jobs: out, levels: DL_LEVELS, labels: DL_LEVEL_LABEL };
  }

  /** 在资源管理器里打开下载目录。由下载器子进程去做（应用进程叫不起外部程序）。 */
  async function openDir() {
    const started = await service.ensure();
    if (!started) return { ok: false, error: "下载器没起来（宿主的托管运行时不可用）" };
    if (!(await waitReady())) return { ok: false, error: "下载器已拉起但端口未就绪，稍后再试" };
    return call("/open", { dir }, 10000);
  }

  /**
   * 本地库：扫下载目录，把音频文件整理成「歌曲」形状。
   * 它们自带 url（指向下载器的 /file），所以播放时不去问网易云。
   * 只扫一层；文件名按「序号 歌手 - 歌名.ext」拆回来（没写「 - 」就当整个是歌名）。
   */
  async function listLocal(extraDir) {
    const at = String(extraDir || dir).trim() || DEFAULT_DIR;
    const started = await service.ensure();
    if (!started) return { ok: false, error: "下载器没起来（宿主的托管运行时不可用）" };
    if (!(await waitReady())) return { ok: false, error: "下载器已拉起但端口未就绪，稍后再试" };
    const reply = await call(`/list?dir=${encodeURIComponent(at)}`, null, 15000);
    if (!reply || reply.ok !== true) return { ok: false, error: (reply && reply.error) || "读不到本地目录" };
    const items = (reply.items || []).map((f) => localSong(f, at));
    return { ok: true, dir: at, items };
  }

  function localSong(file, baseDir) {
    const raw = String(file.name || "");
    const stem = raw.replace(/\.[^.]+$/, "");
    const noIndex = stem.replace(/^\d+\s+/, "");
    const parts = noIndex.split(" - ");
    const artist = parts.length > 1 ? parts[0].trim() : "本地";
    const title = parts.length > 1 ? parts.slice(1).join(" - ").trim() : noIndex;
    return {
      id: "local:" + raw,
      local: true,
      url: `${DL_BASE}/file?p=${encodeURIComponent(String(file.path || ""))}`,
      name: title || stem,
      artist,
      album: baseDir.split(/[\\/]+/).filter(Boolean).pop() || "",
      // 新形态（一首歌一个文件夹）：目录里有 cover.jpg / lyrics.lrc 就交给界面用（2026-10-22）
      coverUrl: file.cover ? `${DL_BASE}/file?p=${encodeURIComponent(String(file.cover))}` : "",
      lrcUrl: file.lrc ? `${DL_BASE}/file?p=${encodeURIComponent(String(file.lrc))}` : "",
      /* 逐字时间轴（2026-10-23）：有它层染才能按字同步，没有就退回行进度。 */
      yrcUrl: file.yrc ? `${DL_BASE}/file?p=${encodeURIComponent(String(file.yrc))}` : "",
      duration: 0,
      size: Number(file.size) || 0,
    };
  }

  /**
   * 取一首本地歌的归档歌词（`<dir>\封面歌词\<同名>\lyrics.lrc`）。
   *  由应用侧出字，不把下载器的 /file 地址直接交给页面 —— 页面与下载器跨端口，
   *  直连要同时过 CORS 与 CSP 两道门（2026-10-22 踩到：歌词页整块空白）。
   */
  async function localLyric(id) {
    const list = await listLocal();
    if (!list || !list.ok) return { ok: false, error: (list && list.error) || "读不到本地目录" };
    const item = (list.items || []).find((s) => s.id === String(id || ""));
    if (!item) return { ok: false, error: "找不到这首本地歌" };
    if (!item.lrcUrl) return { ok: false, error: "这首没有归档歌词" };
    try {
      const res = await ctx.network.fetch(item.lrcUrl, { method: "GET", timeoutMs: 15000, maxResponseBytes: 2 * 1024 * 1024 });
      if (!res || !res.ok) return { ok: false, error: "读歌词失败（HTTP " + (res ? res.status : "?") + "）" };
      const lyric = richToLrc(await res.text());
      /* 逐字也一并取回：带子（层染）用它，整页只用 lyric。 */
      let yrc = "";
      if (item.yrcUrl) {
        try {
          const yres = await ctx.network.fetch(item.yrcUrl, { method: "GET", timeoutMs: 15000, maxResponseBytes: 2 * 1024 * 1024 });
          if (yres && yres.ok) yrc = await yres.text();
        } catch {
          /* 逐字读不到就只用行级 */
        }
      }
      return { ok: true, id: item.id, name: item.name, lyric, yrc };
    } catch (error) {
      return { ok: false, error: "读歌词失败：" + String((error && error.message) || error) };
    }
  }

  return {
    init,
    getDir,
    getCoverMode,
    setCoverMode,
    coverModes: COVER_MODES,
    setDir,
    getLevel,
    setLevel,
    openDir,
    browseDir,
    listFonts,
    pauseDownloads,
    enqueue,
    enqueueList,
    listLocal,
    localLyric,
    status,
    levels: DL_LEVELS,
    labels: DL_LEVEL_LABEL,
  };
}
