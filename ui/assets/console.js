import { ICON, api, coverSrc, escapeHtml, initHana, mmss, post, svg } from "./client.js";

const $ = (id) => document.getElementById(id);

const el = {
  coverBox: $("coverBox"),
  cover: $("cover"),
  title: $("title"),
  sub: $("sub"),
  badge: $("badge"),
  status: $("status"),
  barwrap: $("barwrap"),
  fill: $("fill"),
  cur: $("cur"),
  dur: $("dur"),
  btnLike: $("btnLike"),
  btnPrev: $("btnPrev"),
  btnPlay: $("btnPlay"),
  btnNext: $("btnNext"),
  btnStop: $("btnStop"),
  btnShuffle: $("btnShuffle"),
  btnRepeat: $("btnRepeat"),
  volume: $("volume"),
  volLabel: $("volLabel"),
  level: $("level"),
  dlLevel: $("dlLevel"),
  dlLevelHint: $("dlLevelHint"),
  // 封面与下载目录（2026-10-22）
  dlCover: $("dlCover"),
  btnDownloadDir: $("btnDownloadDir"),
  dlDirHint: $("dlDirHint"),
  dlHint: $("dlHint"),
  btnDownloadAll: $("btnDownloadAll"),
  backend: $("backend"),
  mpvRow: $("mpvRow"),
  mpvDevice: $("mpvDevice"),
  mpvExclusive: $("mpvExclusive"),
  outHint: $("outHint"),
  note: $("note"),
  tabs: $("tabs"),
  queueList: $("queueList"),
  queueEmpty: $("queueEmpty"),
  queueCount: $("queueCount"),
  kw: $("kw"),
  btnSearch: $("btnSearch"),
  searchHint: $("searchHint"),
  searchList: $("searchList"),
  lyricHint: $("lyricHint"),
  lyricBody: $("lyricBody"),
  btnDaily: $("btnDaily"),
  btnFavorite: $("btnFavorite"),
  btnAccount: $("btnAccount"),
  loginModal: $("loginModal"),
  loginBody: $("loginBody"),
  loginClose: $("loginClose"),
  envBar: $("envBar"),
  envBarText: $("envBarText"),
  envBarBtn: $("envBarBtn"),
  btnEnv: $("btnEnv"),
  envModal: $("envModal"),
  envClose: $("envClose"),
  envSub: $("envSub"),
  envList: $("envList"),
  envLog: $("envLog"),
  envLogBody: $("envLogBody"),
  envRescan: $("envRescan"),
  envNote: $("envNote"),
  plHead: $("plHead"),
  plBack: $("plBack"),
  plTitle: $("plTitle"),
  plPlayAll: $("plPlayAll"),
  plHint: $("plHint"),
  plList: $("plList"),
  localHint: $("localHint"),
  localList: $("localList"),
  jump: $("jump"),
  jumpTop: $("jumpTop"),
  jumpBottom: $("jumpBottom"),
  jumpCurrent: $("jumpCurrent"),
};

el.btnLike.innerHTML = svg(ICON.heartOutline);
el.btnPrev.innerHTML = svg(ICON.prev, "icon big");
el.btnPlay.innerHTML = svg(ICON.play, "icon big");
el.btnNext.innerHTML = svg(ICON.next, "icon big");
el.btnStop.innerHTML = svg(ICON.stop, "icon big");
el.btnShuffle.innerHTML = svg(ICON.shuffle, "icon");
el.btnRepeat.innerHTML = svg(ICON.repeat, "icon");
for (const pane of document.querySelectorAll(".pane")) pane.classList.remove("on");
document.querySelector("#pane-queue").classList.add("on");

/* ---------------- 播放执行器 ----------------
 * 后端持"真相"（队列/当前曲目/期望播放态），这个页面持执行器（audio 元素）。
 * 每 1.5s 拉一次 /state，把期望态落到 audio 上；真实进度经 /progress 回报后端。
 * 这样第二步换 mpv 后端时，后端状态语义一个字都不用改。
 */
const audio = new Audio();
audio.preload = "none";
audio.volume = 0.7;
// 本次加载的执行器身份：后端据此决定「该由谁出声」。整页优先，面板/卡片次之。
const EXEC_ID = "page-" + Math.random().toString(36).slice(2, 10);
let pendingSeek = null;

const view = {
  state: null,
  song: null,
  clock: { pos: 0, at: Date.now(), playing: false, duration: 0 },
  search: { items: [], keyword: "" },
  playlist: { loaded: false, loading: false, level: "list", items: [], id: "", name: "", tracks: [] },
  // 专辑视图：非 null 时歌单面板改为显示这张专辑
  album: null,
  lyric: { id: "", lines: [], translated: [], active: -1, pureMusic: false, tries: 0, retryAt: 0, hasYrc: false },
  dragging: false,
  volumeTouched: false,
  coverKey: null,
  account: null,
  queue: null,
};

// 列表行上的红心状态（id 集合）与队列拖拽的起点
const likeState = new Set();
// 歌单/搜索行上的「无音源」标记（来自 /songs/annotate）；只增不减。
// 注意：队列不用它。队列的灰与「挪队尾」都由后端 unplayable 一并负责，保持一份真相，
// 两份掺在一起会出「只灰不移」（见 v0.11.2）。
const unplayableIds = new Set();
let dragFrom = 0;

let notice = "";
let noticeAt = 0;
let appliedUrl = "";
let appliedSongId = "";
let seekNonce = 0;
let lastProgressAt = 0;

function setNotice(text, ms = 5200) {
  notice = text || "";
  noticeAt = Date.now();
  renderPlayer();
  if (notice) {
    setTimeout(() => {
      if (Date.now() - noticeAt >= ms - 60) {
        notice = "";
        renderPlayer();
      }
    }, ms);
  }
}

/* ---------------- 渲染 ---------------- */

function statusWord() {
  const st = view.state;
  if (!st || !st.song) return "未在播放";
  if (st.error) return "取音源失败";
  return st.playing ? "播放中" : st.song && st.position > 0 ? "已暂停" : "已停止";
}

function renderPlayer() {
  const song = view.song || {};
  const st = view.state || {};
  const off = !st.playing;

  el.title.textContent = song.name || "未在播放";
  // 播放器这行：作者点了去搜他的歌，专辑点了打开这张专辑
  const parts = [song.artist ? artistInner(song.artist) : "", song.album ? albumInner(song) : ""].filter(Boolean);
  el.sub.innerHTML = parts.length ? parts.join(" · ") : "—";
  el.status.textContent = statusWord();
  el.badge.className = "badge" + (off ? " off" : "");
  el.btnPlay.innerHTML = svg(st.playing ? ICON.pause : ICON.play, "icon big");
  el.btnLike.classList.toggle("on", !!song.liked);
  el.btnLike.innerHTML = svg(song.liked ? ICON.heart : ICON.heartOutline);

  const repeat = st.repeat === "all" || st.repeat === "one" ? st.repeat : "off";
  el.btnRepeat.innerHTML = svg(repeat === "one" ? ICON.repeatOne : ICON.repeat, "icon");
  el.btnRepeat.classList.toggle("on", repeat !== "off");
  el.btnRepeat.title = repeat === "one" ? "单曲循环" : repeat === "all" ? "列表循环" : "循环模式：顺序";
  el.btnShuffle.classList.toggle("on", !!st.shuffle);
  el.btnShuffle.title = st.shuffle ? "随机播放：开" : "随机播放：关";

  const key = song.coverUrl || "";
  if (key !== view.coverKey) {
    view.coverKey = key;
    if (!key) {
      el.cover.removeAttribute("src");
    } else {
      el.cover.onerror = () => el.cover.removeAttribute("src");
      el.cover.src = coverSrc(key);
    }
  }

  el.dur.textContent = mmss(view.clock.duration || song.duration / 1000 || 0);
  if (el.outHint) {
    if (st.backend === "audio") {
      // 界面播放的声不经过上面那台「MPV 设备」，它跟系统默认输出走——这点必须写在界面上
      el.outHint.hidden = false;
      el.outHint.textContent =
        "界面播放由 Windows 的默认输出出声，不认上面的「MPV 设备」。没声音时先看默认输出是不是被虚拟音频设备（虚拟声卡 / 音效 DSP 一类）接管了。";
    } else if (mpvExclusiveBlocked) {
      // 那个勾被灰掉了，总得给个理由和出路
      el.outHint.hidden = false;
      el.outHint.textContent =
        "这台输出是虚拟音频设备，不支持 WASAPI 独占，所以「独占」已自动关掉。想要 bit-perfect，请在上面选一台真实的输出设备。";
    } else {
      el.outHint.hidden = true;
    }
  }
  const live = notice && Date.now() - noticeAt < 5200 ? notice : "";
  let hint = "";
  if (!st.error && !live && st.backend === "mpv") {
    const fb = st.mpv && st.mpv.fallback;
    if (fb && fb.reason && Date.now() - (fb.at || 0) < 20000) {
      // 设备被拔/独占开不了时的自动回退：说清楚声音实际走了哪条路
      hint = fb.reason;
    } else if (st.mpv && st.mpv.loaded) {
      // 报实际生效的那个值：配置里勾了独占、实际被降级时要说出来（以前这里显示的是配置值，会骗人）
      const effEx = !!st.mpv.effectiveExclusive;
      const declined = !!st.mpv.exclusive && !effEx;
      hint = "声音正由 MPV 输出" + (effEx ? "（WASAPI 独占）" : declined ? "（独占未生效：这台输出不支持，已改共享）" : "");
    } else if (st.mpv && st.mpv.connected) {
      hint = "MPV 已就绪，按播放开始";
    } else if (st.mpv) {
      hint = "MPV 进程还没起来";
    }
  }
  /* 试听片段：未登录时 VIP 曲目只放 20~60 秒，接口的 freeTrialInfo 直接写着 start/end。
   * 这件事必须说出来，否则用户只会觉得“这歌怎么放到一半就停了”。 */
  const trialSec = st.trial && Number(st.trial.seconds) > 0 ? Number(st.trial.seconds) : 0;
  const trialNote = trialSec ? `试听 ${trialSec} 秒（未登录只能听这一段，登录后听整曲）` : "";
  el.note.textContent = st.error || trialNote || live || hint || "";
  el.note.className = "note" + (st.error ? " warn" : trialSec ? " warn" : (hint && st.mpv && st.mpv.fallback ? " warn" : ""));
}

function tick() {
  const clock = view.clock;
  const duration = clock.duration || 0;
  const pos = Math.min(duration || Infinity, clock.playing ? clock.pos + (Date.now() - clock.at) / 1000 : clock.pos);
  if (!view.dragging) {
    el.cur.textContent = mmss(pos);
    el.fill.style.width = duration ? `${Math.min(100, (pos / duration) * 100)}%` : "0%";
  }
  if (view.lyric.lines.length) highlightLyric(pos);
}

/** 作者名：包成可点的一块，点了就去搜他的歌。返回空串表示没有作者。 */
function artistInner(artist) {
  const name = String(artist || "").trim();
  if (!name) return "";
  return `<span data-artist="${escapeHtml(name)}" title="搜 ${escapeHtml(name)} 的歌">${escapeHtml(name)}</span>`;
}

/** 专辑名：包成可点的一块，点了打开这张专辑。
 *  带的是**歌曲 id**（不是专辑 id）——旧数据里只有专辑名没有专辑 id，统一由后端反查。 */
function albumInner(song) {
  const name = String((song && song.album) || "").trim();
  if (!name || !song || !song.id) return "";
  return `<span data-album="${escapeHtml(String(song.id))}" title="打开专辑《${escapeHtml(name)}》">${escapeHtml(name)}</span>`;
}

function heartButton(id) {
  const on = likeState.has(String(id));
  return `<button class="row-heart${on ? " on" : ""}" data-like="${escapeHtml(String(id || ""))}" title="${on ? "取消红心" : "红心"}" aria-label="红心">${svg(on ? ICON.heart : ICON.heartOutline, "icon")}</button>`;
}

/** 行上的下载按钮。下载中 / 已完成时由 markDownloadRows() 点亮。 */
function dlButton(song) {
  const id = String((song && song.id) || "");
  if (!id) return "";
  const attrs = [
    `data-dl="${escapeHtml(id)}"`,
    `data-dl-name="${escapeHtml(String((song && song.name) || ""))}"`,
    `data-dl-artist="${escapeHtml(String((song && song.artist) || ""))}"`,
    `data-dl-album="${escapeHtml(String((song && song.album) || ""))}"`,
  ].join(" ");
  return `<button class="row-dl" ${attrs} title="下载这首" aria-label="下载"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.4v9.4"/><path d="M8.3 10.5 12 14.2l3.7-3.7"/><path d="M5.6 18.8h12.8"/></svg></button>`;
}

/* ---------------- 下载到本地 ----------------
 * 字节由应用后端的下载器子进程去取（见 lib/download.js 与 runtime/downloader.cjs）。
 * 这里只管两伴事：发起（单首 / 整单）、把进度画在 #dlHint 上并把行上的钮点亮。 */
const dlJobs = { live: new Set(), done: new Set(), failed: new Set() };
let dlTimer = 0;

function showDlHint(text, warn, title) {
  if (!el.dlHint) return;
  el.dlHint.textContent = text || "";
  el.dlHint.hidden = !text;
  el.dlHint.classList.toggle("warn", !!warn);
  el.dlHint.title = text ? `${title ? title + " · " : ""}点击打开下载目录` : "";
}

/** 面上只留最后一级目录名；完整路径挂到 title 上。窄栅里拼整条路径会折成两三行。 */
function dirLabel(dir) {
  const parts = String(dir || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(dir || "");
}

function markDownloadRows() {
  for (const btn of document.querySelectorAll(".row-dl")) {
    const id = String(btn.dataset.dl || "");
    const on = dlJobs.live.has(id) || dlJobs.done.has(id);
    btn.classList.toggle("on", on);
    btn.title = dlJobs.done.has(id) ? "已下载" : dlJobs.live.has(id) ? "下载中" : "下载这首";
  }
}

async function startDownload(song) {
  if (!song || !song.id) return;
  const level = (el.dlLevel && el.dlLevel.value) || "lossless";
  try {
    const r = await post("download", { id: song.id, name: song.name, artist: song.artist, album: song.album, level });
    if (!r || r.ok !== true) return showDlHint((r && r.error) || "排下载失败", true);
    const who = `${song.artist ? song.artist + " - " : ""}${song.name || song.id}`;
    if (r.fellBack) {
      /* 要无损、接口只给了 128k（没登录）—— 文件已按实际格式命名，这里得说明白 */
      const got = `${Math.round((r.actualBr || 0) / 1000)}kbps ${String(r.actualType || "").toUpperCase()}`;
      showDlHint(`已排入队列：${who} · 实际只有 ${got}（未登录时接口会回落，文件按实际格式存 .${r.ext || ""}）`, true);
    } else {
      showDlHint(`已排入下载队列：${who}`);
    }
    pollDownload();
  } catch (error) {
    showDlHint(String((error && error.message) || error), true);
  }
}

async function startDownloadAll() {
  const items = ((view.queue && view.queue.items) || []).map((x) => ({
    id: x.id,
    name: x.name,
    artist: x.artist,
    album: x.album,
  }));
  if (!items.length) return showDlHint("播放列表是空的", true);
  const level = (el.dlLevel && el.dlLevel.value) || "lossless";
  showDlHint(`正在排 ${items.length} 首…`);
  try {
    const r = await post("download/list", { items, level });
    if (!r || r.ok !== true) return showDlHint((r && r.error) || "整单排下载失败", true);
    const failed = Array.isArray(r.failed) ? r.failed.length : 0;
    const trunc = r.truncated ? `（一次最多排 300 首，剩 ${r.truncated} 首下次再排）` : "";
    showDlHint(`已排 ${r.queued} 首${failed ? `（${failed} 首取不到音源）` : ""}，依次下到本地${trunc}`);
    pollDownload();
  } catch (error) {
    showDlHint(String((error && error.message) || error), true);
  }
}

async function pollDownload() {
  try {
    const r = await api("download/status");
    if (!r || r.ok !== true) return;
    const live = new Set();
    const done = new Set();
    const failed = new Set();
    for (const job of r.jobs || []) {
      const id = String(job.songId || "");
      if (!id) continue;
      if (job.state === "done") done.add(id);
      else if (job.state === "failed") failed.add(id);
      else live.add(id);
    }
    dlJobs.live = live;
    dlJobs.done = done;
    dlJobs.failed = failed;
    markDownloadRows();

    const c = r.counts || {};
    const liveCount = (c.queued || 0) + (c.running || 0);
    if (liveCount || c.failed) {
      const cur = (r.jobs || []).find((j) => j.state === "running") || (r.jobs || []).find((j) => j.state === "queued");
      const who = cur ? `：${cur.artist ? cur.artist + " - " : ""}${cur.name}` : "";
      showDlHint(`下载中 ${liveCount} 首${who} · 完成 ${c.done || 0}${c.failed ? ` · 失败 ${c.failed}` : ""}`, !!c.failed, r.dir);
    } else if (c.done) {
      // 面上只写条数和文件夹名，完整路径挂 title（鼠标悬停看）
      showDlHint(`下载完成 ${c.done} 首 · ${dirLabel(r.dir)}`, false, r.dir);
    }
    clearTimeout(dlTimer);
    if (liveCount) dlTimer = setTimeout(pollDownload, 2000);
  } catch {
    /* 后端没起来就算了，不报错 */
  }
}

/* 整单下载的交互（2026-10-23 异羽提的两点）：
 *  ① 一按就下一整张歌单 → 改成**两段确认**（第一下只把按钮变成“确认下载 N 首？”，4 秒内再点才真下）；
 *  ② 下起来之后得能停 → 同一个按钮变身“停止下载”，停下后变“继续下载”（待下的存在下载器里，一首不丢）。
 *  正在下的那一首不强行砍断：几 MB、一两秒就完，比留半截文件安全。 */
let dlAllArmed = false;
let dlAllRunning = false;
let dlAllWatch = 0;

function setDlAllLabel(text) {
  if (el.btnDownloadAll) el.btnDownloadAll.textContent = text;
}

function watchDlAll() {
  clearInterval(dlAllWatch);
  dlAllWatch = setInterval(async () => {
    try {
      const st = await api("download/status");
      const jobs = (st && st.jobs) || [];
      const busy = jobs.some((j) => j.state === "running" || j.state === "queued");
      if (!busy) {
        clearInterval(dlAllWatch);
        dlAllRunning = false;
        setDlAllLabel("整单下载");
      }
    } catch {
      /* 读不到就下一轮再问 */
    }
  }, 2500);
}

if (el.btnDownloadAll) {
  el.btnDownloadAll.addEventListener("click", async () => {
    const label = String(el.btnDownloadAll.textContent || "");
    if (dlAllRunning || label.includes("停止")) {
      try {
        const r = await post("download/pause", { on: true });
        setDlAllLabel("继续下载");
        const left = r && typeof r.parked === "number" ? r.parked : 0;
        setNotice(r && r.ok ? `已停下，还有 ${left} 首排队保留着；点「继续下载」接着来` : "停止没成功，再点一次");
      } catch (error) {
        setNotice(String((error && error.message) || error));
      }
      return;
    }
    if (label.includes("继续")) {
      try {
        const r = await post("download/pause", { on: false });
        setDlAllLabel("停止下载");
        dlAllRunning = true;
        setNotice(r && r.ok ? `继续下载 ${r.resumed || 0} 首` : "继续没成功，再点一次");
        watchDlAll();
      } catch (error) {
        setNotice(String((error && error.message) || error));
      }
      return;
    }
    if (!dlAllArmed) {
      const n = ((view.queue && view.queue.items) || []).length;
      dlAllArmed = true;
      setDlAllLabel(`确认下载 ${n} 首？`);
      setTimeout(() => {
        if (dlAllArmed) {
          dlAllArmed = false;
          setDlAllLabel("整单下载");
        }
      }, 4000);
      return;
    }
    dlAllArmed = false;
    setDlAllLabel("停止下载");
    dlAllRunning = true;
    await startDownloadAll();
    watchDlAll();
  });
}

/* ---------------- 本地库 ----------------
 * 文件与字节都来自下载器子进程（应用进程读不到那个目录）。这页只做一件事：列出来，点了就播。 */
async function loadLocal(force) {
  if (view.local && view.local.loading) return;
  if (view.local && view.local.loaded && !force) {
    renderLocal();
    return;
  }
  view.local = { loading: true, loaded: false, dir: "", items: [], error: "" };
  renderLocal();
  try {
    const r = await api("local/list");
    if (!r || r.ok !== true) {
      view.local = { loading: false, loaded: false, dir: "", items: [], error: (r && r.error) || "读取失败" };
    } else {
      view.local = { loading: false, loaded: true, dir: r.dir || "", items: r.items || [], error: "" };
    }
  } catch (error) {
    view.local = { loading: false, loaded: false, dir: "", items: [], error: String((error && error.message) || error) };
  }
  renderLocal();
}

function renderLocal() {
  const st = view.local;
  if (!st) return;
  const items = st.items || [];
  el.localHint.textContent = st.loading
    ? "读取本地目录…"
    : st.error
      ? st.error
      : items.length
        ? `本地 ${items.length} 首 · 目录 ${dirLabel(st.dir)}`
        : "下载目录里还没有音频文件。先去「播放列表」里下一首。";
  el.localHint.classList.toggle("warn", !!st.error);
  el.localHint.title = st.dir || "";
  el.localList.innerHTML = items
    .map(
      (song, i) => `<li class="trackrow" data-li="${i}">
        <span class="idx num">${i + 1}</span>
        <span class="row-cover">${song.coverUrl ? `<img src="${song.coverUrl}" alt="" loading="lazy" />` : ""}</span>
        <span class="nm"><span class="t">${escapeHtml(song.name)}</span><span class="a">${escapeHtml(song.artist)}${song.size ? " · " + (song.size / 1048576).toFixed(1) + " MB" : ""}</span></span>
        <span class="dur num"></span>
      </li>`,
    )
    .join("");
}

el.localList.addEventListener("click", async (event) => {
  const row = event.target.closest("li[data-li]");
  if (!row) return;
  const i = Number(row.dataset.li);
  const items = (view.local && view.local.items) || [];
  const song = items[i];
  if (!song) return;
  try {
    const r = await post("play", { list: items, index: i });
    if (!r || r.ok === false) setNotice((r && r.error) || "播放失败");
    else setNotice(`本地播放：${song.name}`);
    await refreshState();
    setTimeout(() => refreshQueue(true), 600);
  } catch (error) {
    setNotice(String((error && error.message) || error));
  }
});

/** 点一下下载提示行 = 在资源管理器里打开下载目录。 */
async function openDownloadDir() {
  try {
    const r = await post("download/open", {});
    if (!r || r.ok !== true) showDlHint((r && r.error) || "打开目录失败", true);
  } catch (error) {
    showDlHint(String((error && error.message) || error), true);
  }
}
if (el.dlHint) el.dlHint.addEventListener("click", openDownloadDir);
// 用捕获相让下载钮比「点行就播放」先接到点击；否则一点下载就把歌切了。
document.addEventListener(
  "click",
  (event) => {
    const btn = event.target && event.target.closest ? event.target.closest("[data-dl]") : null;
    if (!btn) return;
    event.stopPropagation();
    startDownload({ id: btn.dataset.dl, name: btn.dataset.dlName, artist: btn.dataset.dlArtist, album: btn.dataset.dlAlbum });
  },
  true,
);

function renderQueue(data) {
  if (data) view.queue = data;
  const items = (view.queue && view.queue.items) || [];
  el.queueCount.textContent = items.length ? ` · ${items.length}` : "";
  el.queueEmpty.style.display = items.length ? "none" : "block";
  el.queueList.innerHTML = items
    .map((item) => {
      const cover = item.coverUrl
        ? `<span class="row-cover"><img src="${coverSrc(item.coverUrl)}" alt="" loading="lazy" /></span>`
        : `<span class="row-cover"></span>`;
      // 队列的灰只认后端这一份（后端同时负责挪队尾）；不吃 unplayableIds——
      // 那份来自歌单/搜索的 annotate，只画灰不挪位，掺进来就会「只灰不移」。
      const bad = item.unplayable === true;
      const trialSec = Number(item.trialSeconds) || 0;
      const rowTitle = bad ? "当前音质档取不到音源（已排到队尾）" : trialSec ? `未登录只能试听 ${trialSec} 秒（登录后听整曲）` : "拖拽可排序";
      return `<li class="trackrow${item.current ? " current" : ""}${bad ? " unplayable" : ""}" data-index="${item.index}" draggable="true" title="${rowTitle}">
        <span class="idx num">${item.current ? "▶" : item.index}</span>
        ${cover}
        <span class="nm"><span class="t">${escapeHtml(item.name || "未知曲目")}</span><span class="a">${artistInner(item.artist) || "—"}${item.album ? " · " + albumInner(item) : ""}</span></span>
        <span class="dur num${bad ? " bad" : trialSec ? " trial" : ""}">${bad ? "无音源" : trialSec ? `试听 ${trialSec}s` : item.duration ? mmss(item.duration) : ""}</span>
        ${heartButton(item.id)}
        ${dlButton(item)}
      </li>`;
    })
    .join("");
}

function renderSearch() {
  const { items, keyword } = view.search;
  if (!keyword) {
    el.searchHint.textContent = "";
    el.searchList.innerHTML = "";
    return;
  }
  el.searchHint.textContent = items.length ? `「${keyword}」找到 ${items.length} 首` : `「${keyword}」没有结果`;
  el.searchList.innerHTML = items
    .map((song, i) => {
      const bad = unplayableIds.has(String(song.id));
      return `<li class="trackrow${bad ? " unplayable" : ""}" data-i="${i}">
        <span class="idx num">${i + 1}</span>
        <span class="row-cover">${song.coverUrl ? `<img src="${coverSrc(song.coverUrl)}" alt="" loading="lazy" />` : ""}</span>
        <span class="nm"><span class="t">${escapeHtml(song.name)}</span><span class="a">${artistInner(song.artist)}${song.album ? " · " + albumInner(song) : ""}</span></span>
        <span class="dur num${bad ? " bad" : ""}">${bad ? "无音源" : song.duration ? mmss(song.duration / 1000) : ""}</span>
        ${heartButton(song.id)}
        ${dlButton(song)}
      </li>`;
    })
    .join("");
}

/* ---------------- 歌单 ---------------- */

/** 一行曲目（歌单 / 专辑共用）。orig 是它在底层数组里的下标（点击播放靠它），
 *  pos 是这一行在显示顺序里的位置——无音源沉底后编号会与原下标分开。
 *  withAlbum：歌单要带专辑（整张列表未必同一张），专辑视图内不带（逐行重复同一张很吵）。 */
function trackRow(song, orig, pos, withAlbum) {
  const bad = unplayableIds.has(String(song.id));
  return `<li class="trackrow${bad ? " unplayable" : ""}" data-ti="${orig}">
        <span class="idx num">${pos + 1}</span>
        <span class="row-cover">${song.coverUrl ? `<img src="${coverSrc(song.coverUrl)}" alt="" loading="lazy" />` : ""}</span>
        <span class="nm"><span class="t">${escapeHtml(song.name)}</span><span class="a">${artistInner(song.artist) || "—"}${withAlbum && song.album ? " · " + albumInner(song) : ""}</span></span>
        <span class="dur num${bad ? " bad" : ""}">${bad ? "无音源" : song.duration ? mmss(song.duration / 1000) : ""}</span>
        ${heartButton(song.id)}
        ${dlButton(song)}
      </li>`;
}

/** 一批曲目：能放的在前、无音源的沉底（各自保持相对顺序）。歌单与专辑共用。 */
function splitPlayable(songs) {
  const ok = [];
  const bad = [];
  (songs || []).forEach((s, i) => (unplayableIds.has(String(s.id)) ? bad : ok).push(i));
  return { shown: ok.concat(bad), badCount: bad.length };
}

function renderPlaylist() {
  if (view.album) return renderAlbum();
  const st = view.playlist;
  el.plBack.textContent = "← 云歌单";
  el.plPlayAll.textContent = "整单播放";
  const detail = st.level === "tracks";
  el.plHead.hidden = !detail;
  el.plPlayAll.disabled = !detail || !st.tracks.length;
  if (detail) {
    el.plTitle.textContent = st.name || "云歌单";
    const n = st.tracks.length;
    // 显示层排到队尾：取不到音源的沉底（各自保持相对顺序），与队列那边一致。
    // 只动显示顺序，不动远端歌单本体；data-ti 仍指向 st.tracks 里的真实下标，点击才对得上。
    const { shown, badCount } = splitPlayable(st.tracks);
    el.plHint.textContent = st.loading
      ? "读取曲目…"
      : n
        ? `共 ${n} 首${badCount ? `，${badCount} 首无音源已排到底部` : ""}`
        : "这个云歌单里没有可播放的曲子";
    el.plList.innerHTML = shown.map((i, pos) => trackRow(st.tracks[i], i, pos, true)).join("");
    return;
  }
  el.plHint.textContent = st.loading ? "读取云歌单…" : st.items.length ? `我收藏的云歌单 ${st.items.length} 个 · 点开看曲目` : "没有读到云歌单（先确认已登录网易云）";
  el.plList.innerHTML = st.items
    .map(
      (p, i) => `<li class="trackrow" data-pl="${i}">
      <span class="idx num">${i + 1}</span>
      <span class="row-cover">${p.coverUrl ? `<img src="${coverSrc(p.coverUrl)}" alt="" loading="lazy" />` : ""}</span>
      <span class="nm"><span class="t">${escapeHtml(p.name)}</span><span class="a">${p.count} 首</span></span>
    </li>`,
    )
    .join("");
}

/** 专辑视图：借歌单面板这一套（层级头 + 曲目表 + 播放全部）来放专辑。 */
function renderAlbum() {
  const al = view.album;
  el.plHead.hidden = false;
  el.plBack.textContent = "← 返回";
  el.plPlayAll.textContent = "整张播放";
  el.plPlayAll.disabled = !al.songs.length;
  el.plTitle.textContent = al.name || "专辑";
  const n = al.songs.length;
  const { shown, badCount } = splitPlayable(al.songs);
  el.plHint.textContent = al.loading
    ? "读取专辑…"
    : n
      ? [al.artist, `共 ${n} 首${badCount ? `，${badCount} 首无音源已排到底部` : ""}`].filter(Boolean).join(" · ")
      : "这张专辑没有曲目";
  el.plList.innerHTML = shown.map((i, pos) => trackRow(al.songs[i], i, pos)).join("");
}

async function loadPlaylists() {
  const st = view.playlist;
  st.loading = true;
  st.level = "list";
  renderPlaylist();
  try {
    const result = await api("playlists?limit=50");
    st.items = result.ok ? result.items || [] : [];
    if (!result.ok) setNotice(result.error || "云歌单读取失败");
    // 只有真读到了才算"读过"：否则重载后服务还没起来的那一次失败会被当成完成，
    // 之后再点歌单也不会重试，列表就永远空着。
    st.loaded = !!result.ok;
  } catch (error) {
    setNotice(String((error && error.message) || error));
  } finally {
    st.loading = false;
    renderPlaylist();
  }
}

async function openPlaylist(index) {
  const st = view.playlist;
  const p = st.items[index];
  if (!p) return;
  st.level = "tracks";
  st.id = p.id;
  st.name = p.name;
  st.tracks = [];
  st.loading = true;
  renderPlaylist();
  try {
    const result = await api(`playlist-tracks?id=${encodeURIComponent(p.id)}&limit=500`);
    if (st.id !== p.id) return;
    st.tracks = result.ok ? result.items || [] : [];
    if (result.ok) void annotate(st.tracks.map((s) => s.id));
    if (!result.ok) setNotice(result.error || "云歌单曲目读取失败");
  } catch (error) {
    setNotice(String((error && error.message) || error));
  } finally {
    st.loading = false;
    renderPlaylist();
  }
}

el.plBack.addEventListener("click", () => {
  if (view.album) {
    view.album = null; // 从专辑退回歌单列表
    renderPlaylist();
    return;
  }
  view.playlist.level = "list";
  renderPlaylist();
});

/** 打开一张专辑：拿歌曲 id 去后端反查（旧数据里没有专辑 id），然后借歌单面板显示。 */
async function openAlbum(songId) {
  const key = String(songId || "");
  if (!key) return;
  view.album = { loading: true, req: key, name: "", artist: "", songs: [] };
  document.querySelector('button[data-tab="playlist"]')?.click();
  renderPlaylist();
  try {
    const r = await api(`album?song=${encodeURIComponent(key)}`);
    if (!view.album || view.album.req !== key) return; // 期间又点了别的专辑
    if (!r || !r.ok) {
      view.album = null;
      setNotice((r && r.error) || "专辑读取失败");
      renderPlaylist();
      return;
    }
    view.album = { loading: false, req: key, name: r.name, artist: r.artist, songs: r.songs || [] };
    renderPlaylist();
    void annotate((r.songs || []).map((s) => s.id));
  } catch (error) {
    view.album = null;
    setNotice(String((error && error.message) || error));
    renderPlaylist();
  }
}

el.plPlayAll.addEventListener("click", () => playFrom(view.album ? view.album.songs : view.playlist.tracks, 0));
el.plList.addEventListener("click", (event) => {
  if (event.target.closest("[data-like]")) return;
  const who = event.target.closest("[data-artist]");
  if (who) return void searchArtist(who.dataset.artist);
  const alb = event.target.closest("[data-album]");
  if (alb) return void openAlbum(alb.dataset.album);
  const pl = event.target.closest("li[data-pl]");
  if (pl) return void openPlaylist(Number(pl.dataset.pl));
  const ti = event.target.closest("li[data-ti]");
  if (!ti) return;
  const i = Number(ti.dataset.ti);
  playFrom(view.album ? view.album.songs : view.playlist.tracks, i);
});

/* ---------------- 歌词 ---------------- */

function parseLrc(text) {
  const out = [];
  if (!text) return out;
  const re = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of String(text).split(/\r?\n/)) {
    re.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = re.exec(raw)) !== null) stamps.push(Number(m[1]) * 60 + Number(m[2].replace(":", ".")));
    const content = raw.replace(re, "").trim();
    if (!stamps.length) continue;
    for (const t of stamps) out.push({ t, text: content });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function renderLyric() {
  const lines = view.lyric.lines;
  if (view.lyric.pureMusic) {
    el.lyricHint.textContent = "";
    el.lyricBody.innerHTML = '<div class="empty">这是一首纯音乐，没有歌词。</div>';
    return;
  }
  if (!lines.length) {
    el.lyricHint.textContent = "";
    el.lyricBody.innerHTML = '<div class="empty">还没有歌词。<br />播放一首歌之后这里会跟着走。</div>';
    return;
  }
  /* 提示要名副其实：有逐字就写“逐字歌词”，只有行级才写“逐行歌词”（2026-10-26 异羽指出的）。
   *  原来不论哪一份都写“逐行歌词”，于是一首明明带 yrc 的歌也显示成逐行 —— 他刚查过逐字，当场就幢上了。 */
  const lyricKind = view.lyric.hasYrc ? "逐字歌词" : "逐行歌词";
  el.lyricHint.textContent = view.lyric.translated.length ? `${lyricKind} · 附翻译` : lyricKind;
  const tr = view.lyric.translated;
  el.lyricBody.innerHTML = lines
    .map((line, i) => `<p data-i="${i}">${escapeHtml(line.text || "·")}</p>` + (tr[i] ? `<p class="tr" data-i="${i}">${escapeHtml(tr[i].text || "")}</p>` : ""))
    .join("");
}

/** 把当前唱到的那句摆到视野上方约 38% 处，后面留出即将唱到的几句。
 *  只在它滑出「舒适带」时才重锚（带内不动），免得每换一句都颠一下。 */
function alignLyric(instant) {
  const pane = el.lyricBody.parentElement;
  const active = el.lyricBody.querySelector("p.on");
  // 面板没显示时 clientHeight 为 0，量出来的 rect 全是 0，别去动滚动条
  if (!pane || !active || pane.clientHeight < 1) return;
  const h = pane.clientHeight;
  const pr = pane.getBoundingClientRect();
  const rr = active.getBoundingClientRect();
  const mid = rr.top - pr.top + rr.height / 2; // 当前行中点在视野内的纵向位置
  if (!instant && mid >= h * 0.25 && mid <= h * 0.6) return;
  const top = pane.scrollTop + (rr.top - pr.top) - h * 0.38 + rr.height / 2;
  pane.scrollTo({ top: Math.max(0, top), behavior: instant ? "auto" : "smooth" });
}

function highlightLyric(position) {
  const lines = view.lyric.lines;
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].t <= position + 0.15) index = i;
    else break;
  }
  if (index === view.lyric.active) return;
  view.lyric.active = index;
  for (const node of el.lyricBody.querySelectorAll("p")) node.classList.toggle("on", Number(node.dataset.i) === index);
  if (index >= 0) alignLyric(false);
}

async function loadLyric(id, opts = {}) {
  if (!id) return;
  if (view.lyric.id === id) {
    // 同一个 id：只有到了重试窗口才再拉一次（force 则直接拉）。
    const due = view.lyric.retryAt && Date.now() >= view.lyric.retryAt;
    if (!opts.force && !due) return;
  } else {
    view.lyric.id = id;
    view.lyric.tries = 0;
    view.lyric.retryAt = 0;
    view.lyric.lines = [];
    view.lyric.translated = [];
    view.lyric.active = -1;
    view.lyric.pureMusic = false;
    view.lyric.hasYrc = false;
    renderLyric();
  }
  /* 本地歌（id 形如 `local:<文件名>`）：词就存在归档夹里，直接读那份 .lrc。
   *  不去在线接口查 —— 那串 id 在线根本不存在，查了只会白等一轮再报“没词”。
   *  归档里没有（就是那 11 首待定）：老实显示“还没有歌词”，不报错、不重试。 */
  if (id.startsWith("local:")) {
    /* 词在下载目录的归档夹里，但**由应用后端取**（新路由 /local/lyric）：
     *  页面直连下载器要同时过 CORS 与 CSP，一失败就是整块空白（2026-10-22 踩到）。
     *  失败也要 render：至少要让人看到“为什么没词”。 */
    try {
      const r = await api("local/lyric?id=" + encodeURIComponent(id));
      if (view.lyric.id !== id) return; // 读的功夫换歌了
      view.lyric.lines = r && r.ok ? parseLrc(r.lyric) : [];
      view.lyric.translated = [];
      view.lyric.pureMusic = false;
      view.lyric.active = -1;
      view.lyric.retryAt = 0;
      view.lyric.hasYrc = !!(r && r.ok && String(r.yrc || "").trim());
      renderLyric();
      if (r && r.ok && view.lyric.lines.length) {
        el.lyricHint.textContent = (view.lyric.hasYrc ? "逐字歌词" : "逐行歌词") + " · 来自本地归档";
      } else el.lyricHint.textContent = (r && r.error) || "这首没有归档歌词";
      return;
    } catch (error) {
      view.lyric.lines = [];
      renderLyric();
      el.lyricHint.textContent = "读本地歌词失败：" + String((error && error.message) || error);
      return;
    }
  }
  try {
    const result = await api(`lyric?id=${encodeURIComponent(id)}`);
    if (view.lyric.id !== id) return;
    const has = !!(result && (result.lyric || result.translated));
    view.lyric.lines = parseLrc(result && result.lyric);
    view.lyric.translated = parseLrc(result && result.translated);
    view.lyric.hasYrc = !!(result && String(result.yrc || "").trim());
    if (has) {
      view.lyric.pureMusic = false;
      view.lyric.retryAt = 0;
      view.lyric.tries = 0;
    } else {
      // 空结果不能锁死：取源服务刚重启那几秒可能回一次空（2026-10-12 踩到）。
      // 20 秒后再试，连试 3 次才认「确实没有歌词」。
      view.lyric.tries += 1;
      view.lyric.pureMusic = view.lyric.tries >= 3;
      view.lyric.retryAt = view.lyric.pureMusic ? 0 : Date.now() + 20000;
    }
    renderLyric();
  } catch (error) {
    view.lyric.tries += 1;
    view.lyric.retryAt = Date.now() + 20000;
    el.lyricHint.textContent = String((error && error.message) || error);
  }
}

/* ---------------- 状态同步 ---------------- */

/* 进度回报：mpv 模式下真相在后端（后端从桥取），页面不报。带上执行器身份，
 * 后端只认「当前执行器」的那一份进度。 */
function reportProgress(payload) {
  if (view.state && view.state.backend === "mpv") return;
  post("progress", Object.assign({ execId: EXEC_ID, role: "page" }, payload)).catch(() => {});
}

/* 整页是否在场。不在场时不去抢执行器，把声音让给面板/卡片。
 * 宿主那份快照是准的——实测那个被藏起来的整页面拿到的是
 * {visible:false, active:false, maxFrameRate:0, motion:"paused", slot:"card", reason:"hidden"}。
 * 所以只看 lifecycleActive 就够，不用自己量布局盒，也不用 rAF。 */
let lifecycleActive = true;
function pageActive() {
  return lifecycleActive;
}
function beat() {
  const st = view.state;
  const held = st && st.execId ? String(st.execId) : "";
  // 不在场就不该占着执行器——**哪怕现在占着的就是我自己**：不再续约，让租约自然过期，
  // 让在场的那位接手。（这里原来写的是“held !== EXEC_ID 才让位”，于是自己占着、自己续，
  //  永远不让——那张看不见的整页就是这样一直压着面板的。）
  // 只有「根本没人接手」时才继续报一次，宁可自己继续出声，也不要彻底没声（§33.5 的防呆）。
  if (!pageActive() && held) return;
  post("progress", { beat: true, execId: EXEC_ID, role: "page" }).catch(() => {});
}

/** 待落的位置：音频还没元数据时先记下，等 loadedmetadata 再落（接手过来时不能从头唱）。 */
function applyPendingSeek() {
  if (pendingSeek == null || audio.readyState < 1) return;
  try {
    audio.currentTime = pendingSeek;
  } catch {
    /* 再等下一次 */
  }
  pendingSeek = null;
}
audio.addEventListener("loadedmetadata", applyPendingSeek);

function syncAudio(st) {
  // mpv 后端：页面不出声（声音在 mpv 那边），把本地 audio 彻底停掉
  if (st.backend === "mpv") {
    if (appliedUrl) {
      appliedUrl = "";
      appliedSongId = "";
      try { audio.pause(); } catch { /* ignore */ }
      audio.removeAttribute("src");
    }
    return;
  }
  // 音频后端：只有「当前执行器」出声。整页优先级最高，所以整页开着时永远是整页，
  // 整页关了才让给面板/同伴卡（后端按心跳选举，见 lib/player.js 的 currentExecutor）。
  if (st.execId !== EXEC_ID) {
    if (!audio.paused) {
      try { audio.pause(); } catch { /* ignore */ }
    }
    return;
  }
  if (!st.song) return;
  if (!st.url) {
    // 当前曲目取不到音源（后端给了空 url）：别让上一首的残留流接着响，
    // 否则会听到 A、界面上却写着 B。同一首的流则留着——它多半还好好的。
    if (appliedUrl && String(appliedSongId) !== String(st.song.id)) {
      appliedUrl = "";
      appliedSongId = "";
      if (!audio.paused) {
        try { audio.pause(); } catch { /* ignore */ }
      }
      audio.removeAttribute("src");
    }
    return;
  }
  if (st.url !== appliedUrl) {
    appliedUrl = st.url;
    appliedSongId = String(st.song.id);
    audio.src = st.url;
    pendingSeek = st.seek ? st.seek.position : null;
    view.clock = { pos: pendingSeek || 0, at: Date.now(), playing: st.wantPlaying, duration: 0 };
  }
  if (st.seek && st.seek.nonce !== seekNonce) {
    seekNonce = st.seek.nonce;
    pendingSeek = st.seek.position;
    applyPendingSeek();
    post("control", { action: "seek-done", nonce: st.seek.nonce }).catch(() => {});
  }
  if (st.wantPlaying && audio.paused) {
    // 单曲循环时 audio 上一次是 ended 状态，先回到 0 再播，否则浏览器可能停在末尾
    if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.05)) {
      try { audio.currentTime = 0; } catch { /* ignore */ }
    }
    audio.play().catch((error) => setNotice("播放被浏览器拒绝：" + error.message, 8000));
  } else if (!st.wantPlaying && !audio.paused) {
    audio.pause();
  }
}

function applyState(st) {
  const prevSongId = view.song && view.song.id;
  view.state = st;
  view.song = st.song;
  if (!view.dragging) {
    view.clock.duration = st.duration || 0;
    const wasPlaying = view.clock.playing;
    const nowPlaying = !!st.playing;
    const target = st.position || 0;
    const expected = wasPlaying ? view.clock.pos + (Date.now() - view.clock.at) / 1000 : view.clock.pos;
    // 播放中由 timeupdate 持续校准本地时钟；这里只在明显跳变（换曲 / seek / 停摆漂移）时校正，
    // 避免用滞后的后端 position 覆盖实时位置、导致进度条回退。
    if (!nowPlaying || Math.abs(target - expected) > 2) {
      view.clock.pos = target;
      view.clock.at = Date.now();
    }
    view.clock.playing = nowPlaying;
  }
  if (st.level && el.level && el.level.value !== st.level) el.level.value = st.level;
  /* 后端把档位回写完了再收一次：未登录时两栏都只留「标准」（显示即实际，偏好不动） */
  applyLevelAvailability();
  if (st.backend && el.backend && el.backend.value !== st.backend) el.backend.value = st.backend;
  syncMpvRow(st);
  syncAudio(st);
  renderPlayer();
  tick();
  applyVolume(st);
  if (st.song && st.song.id !== prevSongId) loadLyric(st.song.id);
  // 上一次没拿到词（或报错）时，到点补一次，不必等换歌
  else if (st.song && view.lyric.retryAt && Date.now() >= view.lyric.retryAt) loadLyric(st.song.id, { force: true });
  if (!st.song) {
    appliedUrl = "";
    appliedSongId = "";
    if (!audio.paused) audio.pause();
    audio.removeAttribute("src");
  }
}

/* 音量：后端持唯一一份（/state.volume），两个后端走同一条回填路。
 * 用户正在拖的时候（volumeTouched）不回填，免得把手指底下的值拽走。 */
function applyVolume(st) {
  const v = Number(st.volume);
  if (!Number.isFinite(v) || view.volumeTouched || !el.volume) return;
  const shown = String(Math.round(v));
  if (el.volume.value !== shown) el.volume.value = shown;
  el.volLabel.textContent = shown;
  if (st.backend !== "mpv") audio.volume = Math.min(1, Math.max(0, v / 100));
}

/* 面板 / 小卡发来的一次性指令已经不走了：宿主没给面板「把整页叫到前面」的能力，
 * 所以面板改成就地展示（见 ui/mini.js 的 openList），不再中转给整页。 */

async function refreshState() {
  try {
    applyState(await api("state"));
  } catch (error) {
    el.note.textContent = `读不到播放状态：${String((error && error.message) || error)}`;
    el.note.className = "note warn";
  }
}

let queueTimer = 0;

/** 一次问清这批歌的「已红心」和「取不到音源」——两个判断都归后端，页面只负责显示。 */
async function annotate(ids) {
  const clean = Array.from(new Set((ids || []).filter(Boolean).map(String))).slice(0, 300);
  if (!clean.length) return;
  try {
    const r = await api(`songs/annotate?ids=${encodeURIComponent(clean.join(","))}`);
    if (!r || !r.ok) return;
    const likedSet = new Set((r.liked || []).map(String));
    for (const id of clean) {
      if (likedSet.has(id)) likeState.add(id);
      else likeState.delete(id);
    }
    // 这一批问过谁，就以这一批的答案为准（能放的要能把旧结论撤掉）。
    // 原来只增不减：换音质档后可播性整批变时，会留下过期灰，连带把能放的歌沉到底部。
    const badSet = new Set((r.unplayable || []).map(String));
    for (const id of clean) {
      if (badSet.has(id)) unplayableIds.add(id);
      else unplayableIds.delete(id);
    }
    renderQueue();
    renderSearch();
    renderPlaylist();
    if (view.song && likeState.has(String(view.song.id)) !== !!view.song.liked) {
      view.song.liked = likeState.has(String(view.song.id));
      renderPlayer();
    }
  } catch {
    /* 拿不到就保持未知 */
  }
}

async function refreshQueue(force) {
  const now = Date.now();
  if (!force && now - queueTimer < 2500) return;
  queueTimer = now;
  try {
    const data = await api("queue");
    // 队列的红心以后端为准：先同步进 likeState 再渲染——
    // 这样第一帧就是对的，不会出现「播放器那颗已亮、列表还全空心」的那几秒。
    for (const it of data.items || []) {
      const id = String(it.id || "");
      if (!id) continue;
      if (it.liked) likeState.add(id);
      else likeState.delete(id);
      if (it.unplayable) unplayableIds.add(id);
    }
    renderQueue(data);
  } catch {
    /* ignore */
  }
}

/* ---------------- 交互 ---------------- */

async function control(action, payload) {
  // 乐观更新：播放/暂停/停止先立刻把按铃、徽标、时间轴切过去，不等回执。
  // 真相仍以后端 /state 为准（下一次刷新自然校正），这里只是不让手指等。
  const target = action === "pause" || action === "stop" ? false : action === "play" || action === "resume" ? true : null;
  if (target !== null && view.state && view.state.song) {
    view.state.wantPlaying = target;
    view.state.playing = target;
    view.clock.playing = target;
    view.clock.at = Date.now();
    renderPlayer();
    tick();
  }
  // 光改界面还不够：执行器的 timeupdate 每秒回报一次 playing:true，它若比这次的
  // /control 晚到，会把后端刚设下的意图又掰回「在播」，界面也跟着翻回去。
  // 所以先把本地这条按住；只往「停」这一侧动手，绝不在本地擅自起播。
  if (target === false) {
    if (!audio.paused) {
      try { audio.pause(); } catch { /* ignore */ }
    }
    if (action === "stop") {
      // 停止一并归零，免得下次播放从半截接上（后端那边也设了 seekTo=0）
      try { audio.currentTime = 0; } catch { /* ignore */ }
    }
  }
  try {
    const result = await post("control", Object.assign({ action }, payload || {}));
    if (!result.ok) setNotice(result.error || "操作失败");
    await refreshState();
    if (action === "next" || action === "prev" || action === "stop" || action === "play-index" || action === "move") {
      setTimeout(() => refreshQueue(true), 600);
    }
  } catch (error) {
    setNotice(String((error && error.message) || error));
  }
}

async function playFrom(list, index) {
  if (!list || !list.length) return;
  const song = list[index];
  if (song) setNotice(`起播：${song.name} — ${song.artist}`);
  try {
    const result = await post("play", { list, index });
    if (!result.ok) setNotice(result.error || "起播失败");
  } catch (error) {
    setNotice(String((error && error.message) || error));
  }
  await refreshState();
  setTimeout(() => refreshQueue(true), 800);
}

el.btnPlay.addEventListener("click", () => control(view.state && view.state.wantPlaying ? "pause" : "play"));
el.btnPrev.addEventListener("click", () => control("prev"));
el.btnNext.addEventListener("click", () => control("next"));
el.btnStop.addEventListener("click", () => control("stop"));
el.btnRepeat.addEventListener("click", () => control("cycle-repeat"));
el.btnShuffle.addEventListener("click", () => control("shuffle", {}));
el.btnLike.addEventListener("click", async () => {
  // 乐观更新：先把这颗心、以及所有列表里同一个 id 的红心一起翻过来，不等后端来回。
  // （以前只发请求、等 4 秒一次的队列轮询把状态带回来，所以“另一边”要等好几秒。）
  const on = !(view.song && view.song.liked);
  const id = view.song ? String(view.song.id) : "";
  if (id) {
    if (on) likeState.add(id);
    else likeState.delete(id);
  }
  if (view.song) view.song.liked = on;
  renderPlayer();
  renderQueue();
  renderSearch();
  renderPlaylist();
  try {
    const r = await post("like", { like: on });
    if (!r || !r.ok) setNotice((r && r.error) || "红心失败");
  } catch (error) {
    setNotice(String((error && error.message) || error));
  }
  refreshState();
  // 后端那边也改好了，取一份回来对齐（拿真实值盖掉乐观值）
  setTimeout(() => refreshQueue(true), 300);
});

el.level.addEventListener("change", async () => {
  await post("level", { level: el.level.value });
  await refreshState();
});

// 下载音质档：写回后端存起来，下次开页面按存的那档回来（以前每次都跳回「无损」）
/* 封面选项与下载目录（2026-10-22）：后端一直支持 POST /download/config {dir, cover}，
 *  以前只是没把这些接到界面上。目录的“改”先给成“打开 + 显示当前路径”，
 *  真要换盘符/换目录时再说（换目录得先想清楚已有 100 个平铺文件怎么办）。 */
async function loadDownloadMeta() {
  try {
    const cfg = await api("download/config");
    if (!cfg || cfg.ok === false) return;
    view.dlMeta = cfg;
    if (el.dlCover && cfg.cover) el.dlCover.value = cfg.cover;
    if (el.dlDirHint && cfg.dir) {
      el.dlDirHint.textContent = "下载到 " + cfg.dir;
      el.dlDirHint.title = cfg.dir + "\n（点一下可以换目录）";
    }
  } catch {
    /* 取源/后端未就绪时安静跳过 */
  }
}
/* 改下载目录（2026-10-23）：后端一直支持 POST /download/config {dir}，以前界面只做了“看 + 打开”。
 *  点那句“下载到 …”就能改。**不自动搬旧文件** —— 搬是另一件事（104 个音频 + 封面歌词），
 *  得你点头再做；所以这里把后果说清楚，别让人以为旧歌凭空没了。 */
if (el.dlDirHint) {
  el.dlDirHint.style.cursor = "pointer";
  el.dlDirHint.title = "点一下可以换下载目录";  el.dlDirHint.addEventListener("click", async () => {
    const cur = (view.dlMeta && view.dlMeta.dir) || "";
    /* 先弹系统原生选择框（0.18.29）；弹不出来或报错时退回手动输入，不给一条死路。 */
    let next = "";
    try {
      const picked = await post("download/browse", {});
      if (picked && picked.ok && picked.dir) next = String(picked.dir).trim();
      else if (picked && picked.ok && picked.cancelled) return;
      else if (picked && picked.error) setNotice("选择框打不开（" + picked.error + "），改成手动输入");
    } catch {
      /* 静默转手动 */
    }
    if (!next) {
      const raw = window.prompt("新的下载目录（音频会直接放在这里，封面歌词放在它下面的「封面歌词」）", cur);
      if (raw === null) return;
      next = String(raw || "").trim();
    }
    if (!next || next === cur) return;
    try {
      const r = await post("download/config", { dir: next });
      if (!r || r.ok === false) {
        setNotice((r && r.error) || "改不了这个目录");
        return;
      }
      await loadDownloadMeta();
      setNotice(`下载目录已换到 ${next}。旧目录里的歌不会自动搬过去，需要的话说一声。`);
    } catch (error) {
      setNotice(String((error && error.message) || error));
    }
  });
}
if (el.dlCover) {
  el.dlCover.addEventListener("change", () => {
    post("download/config", { cover: el.dlCover.value }).catch(() => {});
    if (el.dlHint) {
      el.dlHint.hidden = false;
      el.dlHint.textContent = "封面已切到 " + el.dlCover.options[el.dlCover.selectedIndex].text;
    }
  });
}
if (el.btnDownloadDir) {
  el.btnDownloadDir.addEventListener("click", () => {
    post("download/open", {}).catch((error) => {
      if (el.dlHint) {
        el.dlHint.hidden = false;
        el.dlHint.textContent = "打不开目录：" + String((error && error.message) || error);
      }
    });
  });
}
void loadDownloadMeta();

el.dlLevel.addEventListener("change", () => {
  post("download/config", { level: el.dlLevel.value }).catch(() => {});
});
el.backend.addEventListener("change", async () => {
  const r = await post("backend", { backend: el.backend.value });
  if (r && r.error) setNotice(r.error, 6000);
  else if (el.backend.value === "mpv" && r && r.bridge && !r.bridge.ready) {
    setNotice(r.bridge.error || "mpv 桥没起来，切回界面播放试试", 8000);
  } else if (el.backend.value === "audio") {
    setNotice("界面播放跟系统默认输出走；没声音就先检查 Windows 的默认输出。", 9000);
  }
  await refreshState();
});

/* ---------------- mpv 输出设置 ---------------- */

let mpvDevicesLoaded = false;
let mpvDevicesAt = 0;
let mpvDeviceList = [];
let mpvExclusiveBlocked = false;
const MPV_DEVICES_TTL = 10 * 60 * 1000;

/** 设备名太长会把下拉框撑爆：把外层的“吻声器/耳机 (…)”剥掉，
 *  仍然长就再去掉尾部的驱动括号；完整名字走 title。 */
function shortDeviceLabel(label) {
  let s = String(label || "").trim();
  s = s.replace(/^(吻声器|耳机|头戴式耳机|耳麦|数字输出|显示器)\s*\((.+)\)$/, "$2");
  if (s.length > 24) s = s.replace(/\s*\(([^()]*)\)\s*$/, "");
  return s;
}

async function loadMpvDevices() {
  if (mpvDevicesLoaded && Date.now() - mpvDevicesAt < MPV_DEVICES_TTL) return;
  try {
    const r = await api("mpv/devices");
    const devices = (r && r.devices) || [];
    // 空表说明桥/枚举还没就绪：**别把它当结果缓存**，
    // 否则下拉里就永远只剩「跟随系统默认」一项（这个坑踩过）。
    if (!devices.length) return;
    mpvDeviceList = devices;
    el.mpvDevice.innerHTML = "";
    for (const d of devices) {
      if (d.id === "auto") continue;
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = shortDeviceLabel(d.label);
      el.mpvDevice.appendChild(opt);
    }
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "跟随系统默认";
    el.mpvDevice.appendChild(auto);
    mpvDevicesLoaded = true;
    mpvDevicesAt = Date.now();
  } catch {
    /* 桥没起来就先不填，下次再说 */
  }
}

function syncMpvRow(st) {
  const on = st.backend === "mpv";
  if (el.mpvRow) el.mpvRow.hidden = !on;
  if (!on) return;
  loadMpvDevices();
  const cfg = st.mpv;
  if (cfg && el.mpvDevice) {
    const want = cfg.device || "";
    // 配置里那台不在选项里（被拔掉 / 列表还没取到）也要如实显示，别悄悄显示成别的
    if (want && !Array.from(el.mpvDevice.options).some((o) => o.value === want)) {
      const ph = document.createElement("option");
      ph.value = want;
      ph.textContent = "（当前不可用）";
      el.mpvDevice.insertBefore(ph, el.mpvDevice.firstChild);
    }
    if (!el.mpvDevice.dataset.touched) el.mpvDevice.value = want;
  }
  // 不支持独占的输出（FxSound 这类虚拟设备）：把那个勾变灰 + 取消勾选，并说清原因。
  // 后端也真的不接受这个组合（见桥的 /config），灰只是顺手。
  // 这段必须放在“回填设备”之后：否则拿的是上一次的值，变灰会慢一拍。
  const sel = el.mpvDevice ? el.mpvDevice.value : "";
  const info = mpvDeviceList.find((d) => d.id === sel);
  // 框子再宽也未必装得下整台设备名，悬停给全名
  if (el.mpvDevice) el.mpvDevice.title = info ? info.label : "";
  const noEx = !!(info && info.noExclusive);
  mpvExclusiveBlocked = noEx;
  if (el.mpvExclusive) {
    el.mpvExclusive.disabled = noEx;
    const label = el.mpvExclusive.closest("label") || el.mpvExclusive;
    label.classList.toggle("off", noEx);
    label.title = noEx ? "这台输出不支持独占（虚拟设备），已自动关掉" : "";
    if (noEx) el.mpvExclusive.checked = false;
    else if (!el.mpvExclusive.dataset.touched) el.mpvExclusive.checked = !!cfg.exclusive;
  }
  // 音量回填已挪到 applyState（读 /state.volume）：两个后端共用一条路，这里不再各填各的
}

if (el.mpvDevice) {
  el.mpvDevice.addEventListener("change", async () => {
    el.mpvDevice.dataset.touched = "1";
    const r = await post("mpv/config", { audioDevice: el.mpvDevice.value });
    if (r && r.error) setNotice(r.error, 8000);
    else setNotice(r.changed ? "MPV 输出设备已改，下一首生效" : "设备未变", 5000);
    await refreshState();
  });
}

if (el.mpvExclusive) {
  el.mpvExclusive.addEventListener("change", async () => {
    el.mpvExclusive.dataset.touched = "1";
    const r = await post("mpv/config", { exclusive: el.mpvExclusive.checked });
    if (r && r.error) setNotice(r.error, 8000);
    else setNotice(r.changed ? "独占已" + (el.mpvExclusive.checked ? "开" : "关") + "，下一首生效" : "独占设置未变", 5000);
    await refreshState();
  });
}

/* 进度条拖动 */
function barRatio(event) {
  const rect = el.barwrap.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}
el.barwrap.addEventListener("pointerdown", (event) => {
  if (!view.clock.duration) return;
  view.dragging = true;
  el.barwrap.setPointerCapture(event.pointerId);
  el.cur.textContent = mmss(barRatio(event) * view.clock.duration);
});
el.barwrap.addEventListener("pointermove", (event) => {
  if (!view.dragging) return;
  el.fill.style.width = `${barRatio(event) * 100}%`;
  el.cur.textContent = mmss(barRatio(event) * view.clock.duration);
});
el.barwrap.addEventListener("pointerup", async (event) => {
  if (!view.dragging) return;
  view.dragging = false;
  const seconds = Math.round(barRatio(event) * view.clock.duration);
  view.clock.pos = seconds;
  view.clock.at = Date.now();
  await control("seek", { position: seconds });
});

let volumePostTimer = 0;

el.volume.addEventListener("input", () => {
  view.volumeTouched = true;
  el.volLabel.textContent = el.volume.value;
  // 拖的时候先落到本地 <audio>，手感不滞后
  if (!view.state || view.state.backend !== "mpv") audio.volume = Number(el.volume.value) / 100;
  // 再把这一份推给后端：后端持唯一一份（mpv 模式下它顺手推给桥，audio 模式下它负责持久化）
  clearTimeout(volumePostTimer);
  volumePostTimer = setTimeout(async () => {
    try {
      await post("volume", { volume: Number(el.volume.value) });
    } catch {
      /* 推不动就先放着，下一次轮询会把实际值回填 */
    }
    view.volumeTouched = false;
  }, 180);
});

el.tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  const tab = button.dataset.tab;
  for (const node of el.tabs.querySelectorAll("button[data-tab]")) node.classList.toggle("on", node === button);
  for (const pane of document.querySelectorAll(".pane")) pane.classList.remove("on");
  document.querySelector(`#pane-${tab}`).classList.add("on");
  if (tab === "queue") {
    refreshQueue(true);
    post("queue/verify").catch(() => {}); // 顺手核一遍音源（带节流，不会每次都打）
  } else if (tab === "local") {
    loadLocal(true); // 每次打开都重扫，刚下完的歌立刻出现在这里
  }
  if (tab === "playlist" && !view.playlist.loaded) loadPlaylists();
  if (tab === "lyric") alignLyric(true); // 刚显形时直接摆到位，别让用户自己找
  updateJump();
});

/* ---------------- 列表到顶 / 到底 ----------------
 * `.pane` 是滚动容器（overflow-y:auto）。控件只服务「当前激活」的那个面板，
 * 所以队列 / 歌单 / 歌词 / 搜索不用各配一套。
 */
function activePane() {
  return document.querySelector(".pane.on");
}

let jumpRaf = 0;
function updateJump() {
  if (jumpRaf) return; // 同一帧里被多次触发（滚动 + 内容变化）只算一次
  jumpRaf = requestAnimationFrame(() => {
    jumpRaf = 0;
    const pane = activePane();
    const overflow = pane ? pane.scrollHeight - pane.clientHeight : 0;
    const show = overflow > 60;
    el.jump.hidden = !show;
    document.querySelector(".panel").classList.toggle("has-jump", show);
    if (!show) return;
    el.jumpTop.disabled = pane.scrollTop <= 2;
    el.jumpBottom.disabled = pane.scrollTop >= overflow - 2;
    // 「定位当前播放」只在当前面板里真有「当前行」时才出现（队列有，歌单/搜索没有）
    el.jumpCurrent.hidden = !pane.querySelector(".trackrow.current");
  });
}

function jumpToEdge(where) {
  const pane = activePane();
  if (!pane) return;
  pane.scrollTo({ top: where === "top" ? 0 : pane.scrollHeight, behavior: "smooth" });
}

// 把当前播放那行滚到视野中间，再闪一下让眼睛接上。
// 用 rect 差值算偏移，不用 offsetTop：offsetParent 是 .panel（它是 position:relative），不是滚动中的 .pane。
function locateCurrent() {
  const pane = activePane();
  const row = pane && pane.querySelector(".trackrow.current");
  if (!row) return;
  const pr = pane.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  const top = pane.scrollTop + (rr.top - pr.top) - (pane.clientHeight - rr.height) / 2;
  pane.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  row.classList.remove("flash");
  void row.offsetWidth; // 强制重排，让同一行能反复重放动画
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1400);
}

el.jumpTop.addEventListener("click", () => jumpToEdge("top"));
el.jumpBottom.addEventListener("click", () => jumpToEdge("bottom"));
el.jumpCurrent.addEventListener("click", locateCurrent);

for (const pane of document.querySelectorAll(".pane")) {
  pane.addEventListener("scroll", updateJump, { passive: true });
}
window.addEventListener("resize", updateJump);

// 内容长高了（渲染、封面懒加载）也要重算，光等 scroll 事件等不到
if ("ResizeObserver" in window) {
  const ro = new ResizeObserver(updateJump);
  for (const node of document.querySelectorAll(".pane .list, #lyricBody, .searchbar")) ro.observe(node);
}

// Home / End 走同一条路，不占界面；正在输入框里时不抢键
document.addEventListener("keydown", (event) => {
  if (event.key !== "Home" && event.key !== "End") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (!activePane()) return;
  event.preventDefault();
  jumpToEdge(event.key === "Home" ? "top" : "bottom");
});

updateJump();

// 播放器那行：作者名与专辑名都可点（“歌名下的作者 / 专辑”最显眼的一处）
if (el.sub) {
  el.sub.addEventListener("click", (event) => {
    const who = event.target.closest("[data-artist]");
    if (who) return void searchArtist(who.dataset.artist);
    const alb = event.target.closest("[data-album]");
    if (alb) void openAlbum(alb.dataset.album);
  });
}

async function searchArtist(name) {
  const kw = String(name || "").trim();
  if (!kw) return;
  el.kw.value = kw;
  document.querySelector('button[data-tab="search"]')?.click();
  await runSearch();
}

async function runSearch() {
  const keyword = el.kw.value.trim();
  if (!keyword) return;
  el.btnSearch.disabled = true;
  el.searchHint.textContent = "搜索中…";
  try {
    // 要到上游的真上限（100；再高网易云直接回 code 400），后端路由封顶也是 100。
    const result = await api(`search?keyword=${encodeURIComponent(keyword)}&limit=100`);
    view.search = { items: result.ok ? result.items || [] : [], keyword };
    if (!result.ok) el.searchHint.textContent = result.error || "搜索失败";
    else {
      renderSearch();
      void annotate((view.search.items || []).map((s) => s.id));
    }
  } catch (error) {
    el.searchHint.textContent = String((error && error.message) || error);
  } finally {
    el.btnSearch.disabled = false;
  }
}

/* 歌词字体（2026-10-23）：与带子共用同一份设置（lyric-strip/config 里的 family）。
 *  选择器直接插在歌词页那句提示后面 —— 不另改 HTML，两边换字体是同一件事。 */
function applyLyricFamily(id, list) {
  const hit = (list || []).find((f) => f.id === id);
  const css = hit ? String(hit.css || "inherit") : "inherit";
  if (el.lyricBody) el.lyricBody.style.fontFamily = css === "inherit" ? "inherit" : css;
}

function injectFontFaces(list) {
  const rules = (list || [])
    .filter((f) => f && f.src && f.family)
    .map((f) => `@font-face{font-family:"${f.family}";src:url("${f.src}") format("${f.format || "truetype"}");font-display:swap;}`);
  if (!rules.length) return;
  let s = document.getElementById("lyricFontFaces");
  if (!s) {
    s = document.createElement("style");
    s.id = "lyricFontFaces";
    document.head.appendChild(s);
  }
  s.textContent = rules.join("\n");
}

async function initLyricFamily() {
  try {
    const cfg = await api("lyric-strip/config");
    if (!cfg || !Array.isArray(cfg.families) || !cfg.families.length) return;
    /* 自定义字体不在 HANA 的字体表里，页面不认识那个族名 —— 先把 @font-face 注进来（2026-10-23） */
    injectFontFaces(cfg.families);
    const sel = document.createElement("select");
    sel.id = "lyricFamily";
    sel.title = "歌词字体（带子与这里共用）";
    const groups = [
      ["hana", "HANA 字体"],
      ["custom", "自定义字体（HANA 字体库）"],
      ["zh", "系统中文字体"],
      ["en", "系统西文字体"],
    ];
    for (const [g, label] of groups) {
      const og = document.createElement("optgroup");
      og.label = label;
      for (const f of cfg.families.filter((x) => x.group === g)) {
        const o = document.createElement("option");
        o.value = f.id;
        o.textContent = f.label;
        og.appendChild(o);
      }
      if (og.children.length) sel.appendChild(og);
    }
    sel.value = cfg.family || "hana";
    sel.addEventListener("change", async () => {
      applyLyricFamily(sel.value, cfg.families);
      const hit = cfg.families.find((f) => f.id === sel.value);
      try {
        await post("lyric-strip/config", { family: sel.value });
        setNotice("歌词字体已切到「" + ((hit && hit.label) || sel.value) + "」，带子两秒内跟上");
      } catch (error) {
        setNotice(String((error && error.message) || error));
      }
    });
    applyLyricFamily(sel.value, cfg.families);
    if (el.lyricHint && el.lyricHint.parentElement) {
      el.lyricHint.parentElement.insertBefore(sel, el.lyricHint.nextSibling);
    }
  } catch {
    /* 取不到配置就不显示选择器，不影响别的 */
  }
}
void initLyricFamily();

el.btnSearch.addEventListener("click", runSearch);
el.kw.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runSearch();
});
el.searchList.addEventListener("click", (event) => {
  if (event.target.closest("[data-like]")) return;
  const who = event.target.closest("[data-artist]");
  if (who) return void searchArtist(who.dataset.artist);
  const alb = event.target.closest("[data-album]");
  if (alb) return void openAlbum(alb.dataset.album);
  const row = event.target.closest("li[data-i]");
  if (!row) return;
  playFrom(view.search.items, Number(row.dataset.i));
});
function clearDragClasses() {
  for (const r of el.queueList.querySelectorAll("li")) r.classList.remove("dragging", "drop-target");
}

el.queueList.addEventListener("click", (event) => {
  if (event.target.closest("[data-like]")) return;
  const who = event.target.closest("[data-artist]");
  if (who) return void searchArtist(who.dataset.artist);
  const row = event.target.closest("li[data-index]");
  if (!row) return;
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index) || index <= 0) return;
  control("play-index", { index });
});

/* 队列拖拽排序：把一行拖到另一行的位置，交后端的 move 动作重排队列 */
el.queueList.addEventListener("dragstart", (event) => {
  const row = event.target.closest("li[data-index]");
  if (!row) return;
  dragFrom = Number(row.dataset.index);
  row.classList.add("dragging");
  try {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(dragFrom));
  } catch { /* ignore */ }
});
el.queueList.addEventListener("dragover", (event) => {
  if (!dragFrom) return;
  event.preventDefault();
  try { event.dataTransfer.dropEffect = "move"; } catch { /* ignore */ }
  const row = event.target.closest("li[data-index]");
  for (const r of el.queueList.querySelectorAll("li")) {
    r.classList.toggle("drop-target", r === row && !r.classList.contains("dragging"));
  }
});
el.queueList.addEventListener("drop", async (event) => {
  if (!dragFrom) return;
  event.preventDefault();
  const row = event.target.closest("li[data-index]");
  const from = dragFrom;
  const to = row ? Number(row.dataset.index) : 0;
  dragFrom = 0;
  clearDragClasses();
  if (!from || !to || from === to) return;
  await control("move", { from, to });
  setTimeout(() => refreshQueue(true), 300);
});
el.queueList.addEventListener("dragend", () => {
  dragFrom = 0;
  clearDragClasses();
});

/* 列表行上的红心（队列 / 搜索 / 歌单曲目共用一套） */
document.querySelector(".panel").addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-like]");
  if (!btn) return;
  event.stopPropagation();
  const id = String(btn.dataset.like || "");
  if (!id || btn.disabled) return;
  const on = !likeState.has(id);
  btn.disabled = true;
  try {
    const r = await post("like/id", { id, on });
    if (!r || !r.ok) throw new Error((r && r.error) || "红心失败");
    if (on) likeState.add(id);
    else likeState.delete(id);
    if (view.song && String(view.song.id) === id) view.song.liked = on;
    renderQueue();
    renderSearch();
    renderPlaylist();
    renderPlayer();
    // 后端那边已经把这首歌的标记改掉了，从它那儿取一份回来（红心只留一个真相）
    setTimeout(() => refreshQueue(true), 300);
  } catch (error) {
    setNotice(String((error && error.message) || error));
  } finally {
    btn.disabled = false;
  }
});

el.btnDaily.addEventListener("click", async () => {
  setNotice("读取每日推荐…", 4000);
  try {
    const r = await api("daily");
    if (!r.ok || !r.items.length) {
      setNotice(r.error || "没有读到每日推荐（需要登录）");
      return;
    }
    playFrom(r.items, 0);
  } catch (error) {
    setNotice(String((error && error.message) || error));
  }
});
el.btnFavorite.addEventListener("click", () => {  const tab = view.playlist.loaded ? "playlist" : "playlist";
  document.querySelector(`button[data-tab="${tab}"]`)?.click();
  if (!view.playlist.loaded) loadPlaylists();
});

/* ---------------- 账号 / 扫码登录 ---------------- */

let loginTimer = 0;

function stopLoginPoll() {
  if (loginTimer) clearInterval(loginTimer);
  loginTimer = 0;
}

/**
 * 未登录时网易云**只给 128k**（实测：djs 九档的 br/type 一模一样，都是 128k mp3），
 * 所以下载那些高档全都会静默回落 —— 把非标准档灰掉，并把当前值收回「标准」：
 * 「只有一档真生效」这件事得在选单上看得见，而不是等存出一个 128k 才让人发现。
 *
 * 只动下载档，不动播放档：播放那份 select 每 1.5 秒会被后端 state 回写（见 renderPlayer 前的同步），
 * 这里替它切档就会跟后端打架、来回跳。
 */
/**
 * 未登录时网易云**只给 128k**（实测：九档的 br/type 一模一样，都是 128k mp3），
 * 所以播放与下载的高档全都会静默回落 —— 把非标准档灰掉、当前值也收回「标准」：
 * 「只有一档真生效」这件事得在界面上看得见，而不是等存出一个 128k 才让人发现。
 *
 * 两栏的差别：下载那份是「页开时读一次配置」，直接改值就行；
 * **播放那份每 1.5 秒会被后端 state 回写**（见 renderPlayer 里的同步），
 * 所以调用方要在那次同步**之后再调一次**——显示的是“实际能拿到的那档”，
 * 而后端存的偏好不动（登录回来自然恢复）。
 */
function applyLevelAvailability() {
  const loggedIn = !!view.account;
  const rule = (sel, fallback) => {
    if (!sel) return;
    for (const opt of Array.from(sel.options)) {
      const off = !loggedIn && opt.value !== fallback;
      opt.disabled = off;
      opt.title = off ? "未登录时网易云只给 128k，先登录再用这一档" : "";
    }
    if (!loggedIn && sel.value !== fallback) sel.value = fallback;
  };
  rule(el.dlLevel, "standard");
  rule(el.level, "standard");

  /* 说明写在**看得见的一行**上：`<option>` 的 title 在 Chromium 里不弹
   *（尤其是 disabled 的选项，鼠标没机会停在上面）—— 2026-10-15 用户实测指出。 */
  if (el.dlLevel) el.dlLevel.title = loggedIn ? "下载音质" : "未登录：网易云只给 128k";
  if (el.level) el.level.title = loggedIn ? "音质" : "未登录：网易云只给 128k";
  if (el.dlLevelHint) {
    el.dlLevelHint.hidden = loggedIn;
    el.dlLevelHint.textContent = loggedIn
      ? ""
      : "未登录 · 播放与下载都只给 128k，先登录再用高档（320K / 无损 / Hi-Res）";
    el.dlLevelHint.classList.toggle("warn", !loggedIn);
  }
}

function updateAccountButton() {
  if (!el.btnAccount) return;
  const p = view.account;
  el.btnAccount.textContent = p ? p.nickname || "已登录" : "登录";
  el.btnAccount.classList.toggle("on", !!p);
  applyLevelAvailability();
}

async function refreshAccount() {
  try {
    const r = await api("account");
    view.account = r.profile || null;
  } catch {
    view.account = view.account || null;
  }
  updateAccountButton();
  return view.account;
}

function renderAccountPanel(profile) {
  if (!profile) {
    el.loginBody.innerHTML = `
      <p class="login-title">扫码登录网易云</p>
      <div class="qr-box" id="qrBox"><span class="qr-loading">正在获取二维码…</span></div>
      <div class="login-tip" id="loginTip">用「网易云音乐」App 扫码</div>`;
    startQr();
    return;
  }
  const avatar = profile.avatarUrl ? coverSrc(profile.avatarUrl) : "";
  const vip = Number(profile.vipType) > 0 ? "VIP" : "普通账号";
  el.loginBody.innerHTML = `
    <div class="acct">
      ${avatar ? `<img class="acct-avatar" src="${avatar}" alt="" />` : `<span class="acct-avatar"></span>`}
      <div>
        <div class="acct-name">${escapeHtml(profile.nickname || "已登录")}</div>
        <div class="acct-meta">已登录 · ${vip}</div>
      </div>
    </div>
    <button class="mini-btn" id="btnLogout">退出登录</button>`;
  const out = el.loginBody.querySelector("#btnLogout");
  if (out) out.addEventListener("click", doLogout);
}

async function startQr() {
  stopLoginPoll();
  const box = el.loginBody.querySelector("#qrBox");
  const tip = el.loginBody.querySelector("#loginTip");
  try {
    const r = await post("login/qr");
    if (!r.ok || !r.qrimg) throw new Error(r.error || "取二维码失败");
    if (box) box.innerHTML = `<img class="qr" src="${r.qrimg}" alt="登录二维码" />`;
    if (tip) {
      tip.textContent = "等待扫码…";
      tip.classList.remove("clickable");
      tip.onclick = null;
    }
    loginTimer = setInterval(() => checkQr(r.key), 2000);
  } catch (error) {
    if (box) box.innerHTML = `<span class="qr-loading">二维码获取失败</span>`;
    if (tip) tip.textContent = String((error && error.message) || error);
  }
}

async function checkQr(key) {
  const tip = el.loginBody.querySelector("#loginTip");
  try {
    const r = await api(`login/check?key=${encodeURIComponent(key)}`);
    if (!r.ok) return;
    if (r.code === 803) {
      stopLoginPoll();
      view.account = r.profile || null;
      updateAccountButton();
      view.playlist.loaded = false;
      setNotice(`已登录：${(r.profile && r.profile.nickname) || "成功"}`);
      renderAccountPanel(view.account);
      refreshQueue(true);
    } else if (r.code === 802) {
      if (tip) tip.textContent = "已扫码，请在手机上确认";
    } else if (r.code === 800) {
      stopLoginPoll();
      if (tip) {
        tip.textContent = "二维码已过期，点击刷新";
        tip.classList.add("clickable");
        tip.onclick = startQr;
      }
    } else if (tip) {
      tip.textContent = "等待扫码…";
    }
  } catch {
    /* 网络抖动，下一次轮询继续 */
  }
}

async function doLogout() {
  try {
    await post("logout");
  } catch {
    /* ignore */
  }
  view.account = null;
  view.playlist.loaded = false;
  updateAccountButton();
  setNotice("已退出登录");
  renderAccountPanel(null);
}

function closeLogin() {
  el.loginModal.hidden = true;
  stopLoginPoll();
}

el.btnAccount.addEventListener("click", async () => {
  el.loginModal.hidden = false;
  el.loginBody.innerHTML = `<span class="qr-loading">读取账号…</span>`;
  renderAccountPanel(await refreshAccount());
});
el.loginClose.addEventListener("click", closeLogin);
el.loginModal.addEventListener("click", (event) => {
  if (event.target === el.loginModal) closeLogin();
});

/* ---------------- audio 事件 ---------------- */

audio.addEventListener("timeupdate", () => {
  view.clock.pos = audio.currentTime;
  view.clock.at = Date.now();
  view.clock.playing = !audio.paused;
  view.clock.duration = audio.duration || 0;
  if (Date.now() - lastProgressAt > 1000) {
    lastProgressAt = Date.now();
    reportProgress({ position: audio.currentTime, duration: audio.duration, playing: !audio.paused });
  }
});
audio.addEventListener("playing", () => {
  view.clock.playing = true;
  reportProgress({ position: audio.currentTime, duration: audio.duration, playing: true });
});
audio.addEventListener("pause", () => {
  view.clock.playing = false;
  reportProgress({ position: audio.currentTime, playing: false });
});
audio.addEventListener("ended", () => {
  post("control", { action: "ended" }).catch(() => {});
  setTimeout(refreshState, 400);
});
audio.addEventListener("error", () => {
  const code = audio.error && audio.error.code;
  const extra = code === 3 || code === 4 ? "也可能是这台输出被别的程序占着（比如 MPV 独占），先去按「停止」再试。" : "";
  setNotice(`音频播放失败（错误码 ${code}）。换一首或换低一档音质试试。${extra}`, 9000);
});

/* ---------------- 环境自检与引导安装（v0.16.0） ----------------
 * 包里带不了的两个外部依赖（取源服务 api-enhanced / mpv.exe）由应用自己说清楚：
 * 顶上一条引导带 + 一个自检面板。清单文案只在后端 lib/setup.js 的 summarize 里写一次。
 */

let envTimer = null;

function envMarkClass(item) {
  if (item.ok) return "ok";
  return item.level === "required" ? "bad" : "opt";
}

function envFixHtml(item) {
  if (item.action === "install-api-enhanced") {
    return `<span class="env-fix">
      <input id="envSrc" placeholder="另一台机器上 api-enhanced 的目录" />
      <button class="mini-btn" data-env-act="copy">从本机拷</button>
      <button class="mini-btn" data-env-act="git">在线装</button>
    </span>`;
  }
  if (item.action === "set-mpv-path") {
    return `<span class="env-fix">
      <input id="envMpv" placeholder="mpv.exe 的完整路径" />
      <button class="mini-btn" data-env-act="mpv">记下它</button>
    </span>`;
  }
  return "";
}

function renderEnvList(st) {
  const sum = st.summary || { items: [] };
  el.envList.innerHTML = (sum.items || [])
    .map(
      (item) => `<li class="env-item ${envMarkClass(item)}">
      <span class="mark">${item.ok ? "✓" : item.level === "required" ? "✗" : "·"}</span>
      <span class="body">
        <span class="t">${escapeHtml(item.title)}</span>
        <span class="d">${escapeHtml(item.detail)}</span>
        ${envFixHtml(item)}
      </span>
    </li>`,
    )
    .join("");
  el.envSub.textContent = `${sum.headline || "环境自检"}${sum.helperError ? "（" + sum.helperError + "）" : ""}`;
}

function renderEnvBar(st) {
  const sum = st.summary || {};
  const need = st.needs || {};
  const bad = need.apiEnhanced || !(st.service && st.service.ready);
  el.envBar.hidden = !bad;
  el.envBarText.textContent = bad ? `${sum.headline || "环境未就绪"} —— 点右边的「环境自检」` : "";
}

async function refreshEnv() {
  try {
    const st = await api("setup/status");
    renderEnvBar(st);
    if (!el.envModal.hidden) renderEnvList(st);
    if (st.job && st.job.running) startEnvPoll();
    return st;
  } catch (error) {
    el.envBar.hidden = false;
    el.envBarText.textContent = "环境自检读不到：" + String((error && error.message) || error).slice(0, 80);
    return null;
  }
}

function stopEnvPoll() {
  if (envTimer) {
    clearInterval(envTimer);
    envTimer = null;
  }
}

function startEnvPoll() {
  el.envLog.hidden = false;
  if (envTimer) return;
  const step = async () => {
    let job = null;
    try {
      job = await api("setup/progress");
    } catch {
      /* 读不到就等下一轮 */
    }
    if (job) {
      const pct = job.percent === null || job.percent === undefined ? "" : ` ${job.percent}%`;
      el.envSub.textContent = `进行中：${job.stage}${pct}${job.detail ? " · " + job.detail : ""}`;
      const log = (job.log || []).join("\n");
      if (el.envLogBody.textContent !== log) el.envLogBody.textContent = log;
      el.envLogBody.scrollTop = el.envLogBody.scrollHeight;
    }
    if (!job || !job.running) {
      stopEnvPoll();
      const st = await refreshEnv();
      const done = (st && st.job) || job || {};
      el.envNote.textContent = done.error ? `没成：${done.error}` : done.stage === "done" ? "做完了。" : "";
      // 装完等取源服务起来，再自动核一次
      setTimeout(() => void refreshEnv(), 3000);
    }
  };
  envTimer = setInterval(step, 1500);
  void step();
}

function openEnv() {
  el.envModal.hidden = false;
  el.envNote.textContent = "";
  void refreshEnv();
}

function closeEnv() {
  el.envModal.hidden = true;
  stopEnvPoll();
}

el.envBarBtn.addEventListener("click", openEnv);
if (el.btnEnv) el.btnEnv.addEventListener("click", openEnv);
if (el.envClose) el.envClose.addEventListener("click", closeEnv);
el.envModal.addEventListener("click", (event) => {
  if (event.target === el.envModal) closeEnv();
});
el.envRescan.addEventListener("click", () => {
  el.envNote.textContent = "";
  void refreshEnv();
});

el.envList.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-env-act]");
  if (!btn) return;
  const act = btn.dataset.envAct;
  btn.disabled = true;
  try {
    if (act === "copy" || act === "git") {
      const input = el.envList.querySelector("#envSrc");
      const src = input ? String(input.value || "").trim() : "";
      if (act === "copy" && !src) {
        el.envNote.textContent = "「从本机拷」要先填那份 api-enhanced 的目录";
        return;
      }
      const r = await post("setup/api-enhanced", act === "git" ? { mode: "git" } : { mode: "copy", srcDir: src });
      if (!r || r.ok !== true) throw new Error((r && r.error) || "发起失败");
      el.envNote.textContent = `已开始（${r.mode || act}）。日志在下面。`;
      el.envLog.hidden = false;
      startEnvPoll();
    } else if (act === "mpv") {
      const input = el.envList.querySelector("#envMpv");
      const path = input ? String(input.value || "").trim() : "";
      if (!path) {
        el.envNote.textContent = "先填 mpv.exe 的完整路径";
        return;
      }
      const r = await post("setup/mpv", { path });
      if (!r || r.ok !== true) throw new Error((r && r.error) || "没记上");
      el.envNote.textContent = `已记下：${r.exePath}${r.bridgeRestarted ? "（桥已重起）" : "（下次重开 mpv 生效）"}`;
      await refreshEnv();
    }
  } catch (error) {
    el.envNote.textContent = String((error && error.message) || error);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 启动 ---------------- */

(async () => {
  const sdk = await initHana();
  // 整页不在场（被切走/隐藏）时让位给面板：靠宿主的生命周期快照判断，
  // 拿不到就按“一直活跃”处理，行为跟以前一样。
  try {
    if (sdk && sdk.lifecycle && sdk.lifecycle.subscribe) {
      sdk.lifecycle.subscribe((snap) => {
        lifecycleActive = !(snap && snap.active === false);
      });
    }
  } catch {
    /* 拿不到就按一直活跃处理（还有布局盒那道刷子兜底） */
  }
  // 先抢一次执行器：整页优先级最高，报到了才能立刻出声（否则第一轮 /state 里还没有自己）
  beat();
  await refreshState();
  // 下载音质档：按后端存的那档回来（没存过就按 HTML 的默认）
  try {
    const cfg = await api("download/config");
    const saved = cfg && String(cfg.level || "");
    if (saved && Array.from(el.dlLevel.options).some((option) => option.value === saved)) el.dlLevel.value = saved;
  } catch {
    /* 拿不到就按 HTML 默认 */
  }
  refreshAccount().then((p) => {
    // 取源服务刚起来时可能读到空，再核一次（也免得把下载档误判成「未登录」而全灰掉）
    if (!p) setTimeout(() => void refreshAccount(), 3000);
  });
  refreshQueue(true);
  // 环境自检：缺依赖时顶上那条引导带要尽早显形（首屏之后，别抢首帧）
  setTimeout(() => void refreshEnv(), 700);
  // 首屏之后核一遍队列音源（服务此时通常已就绪）；失败不占地，下次再试
  setTimeout(() => post("queue/verify").catch(() => {}), 4000);
  setInterval(refreshState, 1500);
  setInterval(tick, 250);
  setInterval(() => refreshQueue(false), 4000);
  // 心跳：告诉后端「整页还开着」。1.5 秒一次（后端租约 3 秒，留一次卡顿的余量）。
  setInterval(beat, 1500);
})();
