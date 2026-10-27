import { ICON, api, coverSrc, escapeHtml, initHana, mmss, post, svg } from "./client.js";

const $ = (id) => document.getElementById(id);
const el = {
  coverBox: $("coverBox"),
  cover: $("cover"),
  title: $("title"),
  sub: $("sub"),
  bar: $("bar"),
  fill: $("fill"),
  cur: $("cur"),
  dur: $("dur"),
  btnRepeat: $("btnRepeat"),
  btnShuffle: $("btnShuffle"),
  btnPrev: $("btnPrev"),
  btnPlay: $("btnPlay"),
  btnNext: $("btnNext"),
  btnStop: $("btnStop"),
  btnLike: $("btnLike"),
  count: $("count"),
  who: $("who"),
  note: $("note"),
  volume: $("volume"),
  volLabel: $("volLabel"),
  listBox: $("listBox"),
  listRows: $("listRows"),
  listTitle: $("listTitle"),
  listBack: $("listBack"),
  btnPlaylists: $("btnPlaylists"),
  btnLyric: $("btnLyric"),
  jump: $("jump"),
  jumpTop: $("jumpTop"),
  jumpBottom: $("jumpBottom"),
  jumpCurrent: $("jumpCurrent"),
};

/** 宿主 SDK 句柄（initHana 后拿到）；面板靠它叫出完整页面。 */
let sdk = null;

el.btnRepeat.innerHTML = svg(ICON.repeat, "icon");
el.btnShuffle.innerHTML = svg(ICON.shuffle, "icon");
el.btnPrev.innerHTML = svg(ICON.prev);
el.btnPlay.innerHTML = svg(ICON.play, "icon big");
el.btnNext.innerHTML = svg(ICON.next);
el.btnStop.innerHTML = svg(ICON.stop);
el.btnLike.innerHTML = svg(ICON.heartOutline, "icon");

/* 侧栏面板/小卡不自己出声：它是整页播放器的遥控与镜像。
 * 声音由整页（页面的 <audio>，或后端驱动的 mpv）出，这里只读 /state、发 /control。
 * 音量、循环、红心都走同一份后端真相，所以面板与整页永远一致。 */
const view = {
  state: null,
  song: null,
  clock: { pos: 0, at: Date.now(), playing: false, duration: 0 },
  coverKey: null,
  volumeTouched: false,
};

function artistSpan(artist) {
  const name = String(artist || "").trim();
  if (!name) return "";
  return `<span data-artist="${escapeHtml(name)}" title="看 ${escapeHtml(name)} 的歌">${escapeHtml(name)}</span>`;
}

function albumSpan(song) {
  const name = String((song && song.album) || "").trim();
  if (!name || !song || !song.id) return "";
  return `<span data-album="${escapeHtml(String(song.id))}" title="打开专辑《${escapeHtml(name)}》">${escapeHtml(name)}</span>`;
}

/* ---------------- 音频执行器 ----------------
 * 后端持真相；「当前执行器」由后端在整页与面板/卡片之间选（整页优先，同级按 id 字典序）。
 * 面板被选中时自己出声，整页一开就自动交还；mpv 后端下这里不出声。 */
const EXEC_ID = "mini-" + Math.random().toString(36).slice(2, 10);
const audio = new Audio();
audio.preload = "none";
let appliedUrl = "";
let appliedSongId = "";
let pendingSeek = null;

/* mini 面也可能有多个：同事卡一个，整页的「功能面板」又一个，两者同 rank。
 * 不在场的那个必须让位，否则两个 mini 会来回抢租约，谁也放不出声。
 * 靠宿主的生命周期快照认「我在不在场」（跟 console.js 同一套）。 */
let lifecycleActive = true;
function beatExecutor() {
  const st = view.state;
  const held = st && st.execId ? String(st.execId) : "";
  // 不在场就不占着执行器——哪怕现在占着的就是我自己；让租约自然过期，让在场的那位接手。
  // 只有「根本没人接手」时才继续报，免得彻底没声。
  if (!lifecycleActive && held) return;
  post("progress", { beat: true, execId: EXEC_ID, role: "mini" }).catch(() => {});
}
let seekNonce = 0;
let lastProgressAt = 0;

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
audio.addEventListener("timeupdate", () => {
  view.clock.pos = audio.currentTime;
  view.clock.at = Date.now();
  view.clock.playing = !audio.paused;
  view.clock.duration = audio.duration || 0;
  if (Date.now() - lastProgressAt > 1000) {
    lastProgressAt = Date.now();
    post("progress", {
      execId: EXEC_ID,
      position: audio.currentTime,
      duration: audio.duration,
      playing: !audio.paused,
    }).catch(() => {});
  }
});
audio.addEventListener("playing", () => {
  view.clock.playing = true;
  post("progress", { execId: EXEC_ID, position: audio.currentTime, duration: audio.duration, playing: true }).catch(() => {});
});
audio.addEventListener("pause", () => {
  view.clock.playing = false;
  post("progress", { execId: EXEC_ID, position: audio.currentTime, playing: false }).catch(() => {});
});
audio.addEventListener("ended", () => {
  post("control", { action: "ended" }).catch(() => {});
  setTimeout(refresh, 400);
});
audio.addEventListener("error", () => {
  el.note.textContent = "音频播放失败（错误码 " + (audio.error ? audio.error.code : "?") + "）";
  el.note.className = "warn";
});

function syncAudio(st) {
  if (st.backend === "mpv") {
    // mpv 后端：声音在后端那边，这里彻底停掉
    if (appliedUrl) {
      appliedUrl = "";
      appliedSongId = "";
      try { audio.pause(); } catch { /* ignore */ }
      audio.removeAttribute("src");
    }
    return;
  }
  if (st.execId !== EXEC_ID) {
    // 不是当前执行器（整页在）：安静让位
    if (!audio.paused) {
      try { audio.pause(); } catch { /* ignore */ }
    }
    return;
  }
  if (!st.song) return;
  if (!st.url) {
    // 当前曲目取不到音源（后端给了空 url）：别让上一首的残留流接着响，
    // 否则会听到 A、面板上却写着 B。同一首的流则留着——它多半还好好的。
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
    if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.05)) {
      try { audio.currentTime = 0; } catch { /* ignore */ }
    }
    audio.play().catch((error) => {
      el.note.textContent = "播放被浏览器拒绝：" + (error && error.message ? error.message : error);
      el.note.className = "warn";
    });
  } else if (!st.wantPlaying && !audio.paused) {
    audio.pause();
  }
}

function render() {
  const st = view.state || {};
  const song = view.song || {};
  el.title.textContent = song.name || "未在播放";
  const sub = [artistSpan(song.artist), albumSpan(song)].filter(Boolean).join(" · ");
  el.sub.innerHTML = sub || (st.playing ? "正在播放" : "—");
  el.btnPlay.innerHTML = svg(st.playing ? ICON.pause : ICON.play, "icon big");

  // 循环：顺序用普通图标，列表循环/单曲循环换图并点亮
  el.btnRepeat.innerHTML = svg(st.repeat === "one" ? ICON.repeatOne : ICON.repeat, "icon");
  el.btnRepeat.classList.toggle("on", st.repeat === "all" || st.repeat === "one");
  el.btnShuffle.classList.toggle("on", !!st.shuffle);
  const liked = !!(song && song.liked);
  el.btnLike.innerHTML = svg(liked ? ICON.heart : ICON.heartOutline, "icon");
  el.btnLike.classList.toggle("on", liked);

  const key = song.coverUrl || "";
  if (key !== view.coverKey) {
    view.coverKey = key;
    if (!key) el.cover.removeAttribute("src");
    else {
      el.cover.onerror = () => el.cover.removeAttribute("src");
      el.cover.src = coverSrc(key);
    }
  }

  el.dur.textContent = mmss(song.duration ? song.duration / 1000 : view.clock.duration);

  if (st.total) el.count.textContent = `第 ${(st.index || 0) + 1} / ${st.total} 首`;
  else el.count.textContent = song.name ? "不在队列中" : "";

  // 播放模式后缀：三种都写出来，“顺序”也要有名字，不然它在这种小面板里是隐形的
  const mode = [];
  if (st.repeat === "one") mode.push("单曲循环");
  else if (st.repeat === "all") mode.push("列表循环");
  else mode.push("顺序播放");
  if (st.shuffle) mode.push("随机播放");

  const isMpv = st.backend === "mpv";
  // 「谁在出声」单独拎出来，放在第一行「第 N / M 首」后面（用户要的）。
  // 它不再拼进下面那句，所以不会留下多出来的分隔符。告警几支也不进第一行，
  // 免得把「谁在出声」跟故障混在一起。
  let who = "";
  let text = "";
  let warn = false;
  if (st.error) {
    // 2026-10-22：原来这里被压成“MPV 出错”/“取源失败”，把**取源问题**说成了播放器问题
    // （实测报的是「这首歌暂时拿不到音源（可能需要会员或已下架）」，mpv 本身是好的）。
    // 直接给真话；面板窄就让它省，完整句子同时在 title 里。
    text = st.error;
    warn = true;
  } else if (isMpv && st.mpv && st.mpv.fallback) {
    // 设备被拔/独占打不开时的自动回退，面板上要能看出来
    text = st.mpv.fallback.droppedExclusive ? "MPV 已回退到共享输出" : "MPV 已回退到系统默认";
    warn = true;
  } else if (!isMpv && st.song && st.wantPlaying && st.executorAlive === false) {
    // 一个执行器都不在：没人能出声（面板也没开的话）
    text = "没有执行器在场，声音不会出";
    warn = true;
  } else if (song.name) {
    // 谁在出声：mpv 在后端那边；audio 模式下由后端选举（整页优先，面板/卡片顶替）
    who = isMpv ? "MPV 出声" : st.execId === EXEC_ID ? "本面板出声" : "整页出声";
  }
  // 第二行只剩播放态与循环 / 随机；**告警时不拼循环模式** —— 那句话更重要，而且面板窄，
  // 拼上去会把真正的原因挤成省略号（用户 2026-10-22 报的就是只看到“MPV 出错”）。
  if (!warn) text = st.playing ? "播放中" : song.name ? "已暂停" : "";
  if (mode.length && !warn) text = text ? `${text} · ${mode.join(" · ")}` : mode.join(" · ");
  el.who.textContent = who ? `· ${who}` : "";
  el.note.textContent = text;
  el.note.title = st.error || "";
  el.note.className = warn ? "warn" : "";

  // 音量：后端持唯一一份（/state.volume），没在拖就按它回填；同时落到本地 <audio> 上——
  // 面板自己出声时，这一下才真正决定响度（漏了它面板就是满音量，跟整页差一截）
  const v = Number(st.volume);
  if (Number.isFinite(v) && !view.volumeTouched) {
    const shown = String(Math.round(v));
    if (el.volume.value !== shown) el.volume.value = shown;
    el.volLabel.textContent = shown;
    audio.volume = Math.min(1, Math.max(0, v / 100));
  }

  markListCurrent();
}

function tick() {
  const clock = view.clock;
  const duration = clock.duration || 0;
  const pos = Math.min(duration || Infinity, clock.playing ? clock.pos + (Date.now() - clock.at) / 1000 : clock.pos);
  el.cur.textContent = mmss(pos);
  el.fill.style.width = duration ? `${Math.min(100, (pos / duration) * 100)}%` : "0%";
}

async function refresh() {
  try {
    const st = await api("state");
    view.state = st;
    view.song = st.song;
    // 播放中由 timeupdate 校准本地时钟；这里只在明显跳变时校正，
    // 免得用滞后的后端位置盖掉实时位置
    const target = Number(st.position) || 0;
    const expected = view.clock.playing ? view.clock.pos + (Date.now() - view.clock.at) / 1000 : view.clock.pos;
    if (!st.playing || Math.abs(target - expected) > 2) {
      view.clock.pos = target;
      view.clock.at = Date.now();
    }
    view.clock.playing = !!st.playing;
    view.clock.duration = Number(st.duration) || 0;
    render();
    tick();
    syncAudio(st);
  } catch {
    el.note.textContent = "连不上后端";
    el.note.className = "warn";
  }
}

async function control(action, payload) {
  try {
    const result = await post("control", Object.assign({ action }, payload || {}));
    if (!result.ok) {
      el.note.textContent = result.error || "操作失败";
      el.note.className = "warn";
    }
    await refresh();
    // 把结果一并交回，让调用方知道成败（2026-10-22：队列里点一行要“播了就收起抽屉”）
    return result;
  } catch (error) {
    el.note.textContent = String((error && error.message) || error);
    el.note.className = "warn";
    return null;
  }
}

/** 先把本地这条按住：执行器的 timeupdate 每秒会回报一次 playing:true，
 *  它若比这次的 /control 晚到，就会把后端刚设下的「暂停」又掰回「在播」。
 *  只往「停」这一侧动手，绝不在本地擅自起播。 */
function holdLocal() {
  if (!audio.paused) {
    try { audio.pause(); } catch { /* ignore */ }
  }
  if (view.state) {
    view.state.playing = false;
    view.state.wantPlaying = false;
  }
  view.clock.playing = false;
  view.clock.at = Date.now();
}

el.btnPlay.addEventListener("click", () => {
  const playing = !!(view.state && view.state.wantPlaying);
  if (playing) {
    holdLocal();
    render();
    tick();
  }
  control(playing ? "pause" : "play");
});
el.btnPrev.addEventListener("click", () => control("prev"));
el.btnNext.addEventListener("click", () => control("next"));
el.btnStop.addEventListener("click", () => {
  holdLocal();
  // 停止要把位置也归零：不然下次按播放会从半截接上（后端那边一并设了 seekTo=0）
  try { audio.currentTime = 0; } catch { /* ignore */ }
  view.clock = { pos: 0, at: Date.now(), playing: false, duration: view.clock.duration || 0 };
  render();
  tick();
  control("stop");
});
el.btnRepeat.addEventListener("click", () => control("cycle-repeat"));
el.btnShuffle.addEventListener("click", () => control("shuffle", { on: !(view.state && view.state.shuffle) }));
el.btnLike.addEventListener("click", async () => {
  const song = view.song;
  if (!song || !song.id) return;
  const on = !song.liked;
  song.liked = on; // 乐观更新，跟整页一个手感
  render();
  try {
    await post("like/id", { id: song.id, on });
  } catch {
    song.liked = !on;
    render();
  }
  await refresh();
});

/* 音量：走后端那一个入口（/volume）。mpv 模式下后端会顺手推给桥，audio 模式下后端负责持久化。 */
let volTimer = 0;
el.volume.addEventListener("input", () => {
  view.volumeTouched = true;
  el.volLabel.textContent = String(Math.round(Number(el.volume.value) || 0));
  // 先落到本地 <audio>（自己出声时这一下就是实际响度），再推给后端
  audio.volume = Math.min(1, Math.max(0, Number(el.volume.value) / 100));
  clearTimeout(volTimer);
  volTimer = setTimeout(async () => {
    try {
      await post("volume", { volume: Number(el.volume.value) });
    } catch {
      /* 推不动就等下一次轮询回填 */
    }
    view.volumeTouched = false;
  }, 180);
});

/* ---------------- 就地列表：搜歌手 / 开专辑 ----------------
 * 宿主没有给 App 面板「把整页叫到前面」的能力（SDK 里查过：`ui.js` 里没有 openCard/openSurface，
 * `focus-card` 只存在于输入面板的描述符协议里）。所以不跳页了——结果就在这个面板里出，
 * 点一行直接起播（队列交给后端；谁出声由后端决定）。 */
const list = { kind: "", items: [], bad: new Set(), req: 0 };

function showList(on) {
  document.body.classList.toggle("list-open", on);
  el.listBox.hidden = !on;
  updateJump();
}

/** 列表的显示顺序：能放的在前、无音源的在后，各自保持原相对顺序。
 *  data-i 写的仍是 list.items 里的**真实下标**，所以点击播哪首、标当前行都不会错位。 */
function displayOrder() {
  const items = list.items || [];
  if (!list.bad || !list.bad.size) return items.map((_, i) => i);
  const playable = [];
  const blocked = [];
  items.forEach((s, i) => {
    (s && list.bad.has(String(s.id)) ? blocked : playable).push(i);
  });
  return playable.concat(blocked);
}

function renderList() {
  const isCollection = list.kind === "playlists";
  el.listRows.innerHTML = displayOrder()
    .map((i) => {
      const s = list.items[i] || {};
      if (isCollection) {
        return `<li class="mini-row" data-i="${i}" title="点开看曲目">
        <span class="mini-row-cover">${s.coverUrl ? `<img src="${coverSrc(s.coverUrl)}" alt="" loading="lazy" />` : ""}</span>
        <span class="nm"><span class="t">${escapeHtml(s.name || "")}</span><span class="a">${s.count ? `${s.count} 首` : ""}</span></span>
      </li>`;
      }
      const bad = list.bad.has(String(s.id));
      const who = [artistSpan(s.artist), albumSpan(s)].filter(Boolean).join(" · ");
      return `<li class="mini-row${bad ? " unplayable" : ""}" data-i="${i}" title="${bad ? "当前音质档取不到音源" : "播放"}">
        <span class="mini-row-cover">${s.coverUrl ? `<img src="${coverSrc(s.coverUrl)}" alt="" loading="lazy" />` : ""}</span>
        <span class="nm"><span class="t">${escapeHtml(s.name || "")}</span><span class="a">${who || "—"}${bad ? " · 无音源" : ""}</span></span>
      </li>`;
    })
    .join("");
  markListCurrent();
  updateJump();
}

/** 标出正在播的那一行：按歌曲 id 认，不看下标——这个列表未必就是当前队列。 */
function markListCurrent() {
  if (!el.listBox || el.listBox.hidden) return;
  const curId = view.state && view.state.song ? String(view.state.song.id) : "";
  for (const row of el.listRows.querySelectorAll("li[data-i]")) {
    const s = list.items[Number(row.dataset.i)];
    row.classList.toggle("current", !!s && !!curId && String(s.id) === curId);
  }
}

/* ---------------- 列表的到顶 / 到底 / 定位当前 ----------------
 * 与整页那套同语言（三颗圆钮、定位后闪一下），只是尺寸小一号。
 * 小面板的滚动容器是 #listRows（它才是那个 overflow-y:auto 的盒子），不是 #listBox。 */
let jumpRaf = 0;
function updateJump() {
  if (!el.jump || !el.listRows || !el.listBox) return;
  if (jumpRaf) return; // 同一帧里被滚动 + 内容变化反复触发时只算一次
  jumpRaf = requestAnimationFrame(() => {
    jumpRaf = 0;
    const rows = el.listRows;
    const overflow = rows.scrollHeight - rows.clientHeight;
    const show = !el.listBox.hidden && overflow > 60;
    el.jump.hidden = !show;
    el.listBox.classList.toggle("has-jump", show);
    if (!show) return;
    el.jumpTop.disabled = rows.scrollTop <= 2;
    el.jumpBottom.disabled = rows.scrollTop >= overflow - 2;
    // 「定位当前播放」只在列表里真有当前那行时才出现（队列有；多数歌单/搜索没有）
    el.jumpCurrent.hidden = !rows.querySelector("li.mini-row.current");
  });
}

function jumpToEdge(where) {
  const rows = el.listRows;
  if (!rows) return;
  rows.scrollTo({ top: where === "top" ? 0 : rows.scrollHeight, behavior: "smooth" });
}

// 把当前那行滚到视野中间再闪一下。用 rect 差值算，不用 offsetTop：
// #listBox 是 position:relative，会当 offsetParent，而真正滚的是 #listRows。
function locateCurrent() {
  const rows = el.listRows;
  const row = rows && rows.querySelector("li.mini-row.current");
  if (!row) return;
  const rr = rows.getBoundingClientRect();
  const br = row.getBoundingClientRect();
  const top = rows.scrollTop + (br.top - rr.top) - (rows.clientHeight - br.height) / 2;
  rows.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  row.classList.remove("flash");
  void row.offsetWidth; // 强制重排，让同一行能反复重放动画
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1400);
}

if (el.jumpTop) {
  el.jumpTop.addEventListener("click", () => jumpToEdge("top"));
  el.jumpBottom.addEventListener("click", () => jumpToEdge("bottom"));
  el.jumpCurrent.addEventListener("click", locateCurrent);
  el.listRows.addEventListener("scroll", updateJump, { passive: true });
  window.addEventListener("resize", updateJump);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => updateJump()).observe(el.listRows);
  // Home / End 走同一条路（焦点在音量滑块里时不抢键）
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Home" && event.key !== "End") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (el.listBox.hidden) return;
    event.preventDefault();
    jumpToEdge(event.key === "Home" ? "top" : "bottom");
  });
}

async function openList(kind, value, label) {
  const req = (list.req += 1);
  list.kind = kind;
  list.items = [];
  list.bad = new Set();
  showList(true);
  el.listTitle.textContent =
    kind === "playlists" ? "读取云歌单…" : kind === "queue" ? "读取播放列表…" : kind === "album" ? "读取专辑…" : kind === "playlist" ? "读取曲目…" : `搜「${value}」…`;
  el.listRows.innerHTML = "";
  try {
    let items = [];
    let title = "";
    let needAnnotate = true;
    if (kind === "queue") {
      const r = await api("queue");
      if (req !== list.req) return;
      if (!r || r.ok === false || !Array.isArray(r.items)) {
        el.listTitle.textContent = (r && r.error) || "播放列表读取失败";
        return;
      }
      items = r.items || [];
      title = `播放列表 · ${items.length} 首`;
      // 队列的「无音源」后端已经标好了，不用再问一次 annotate
      list.bad = new Set(items.filter((s) => s.unplayable).map((s) => String(s.id)));
      needAnnotate = false;
    } else if (kind === "playlists") {
      const r = await api("playlists?limit=50");
      if (req !== list.req) return;
      if (!r || !r.ok) {
        el.listTitle.textContent = (r && r.error) || "云歌单读取失败";
        return;
      }
      items = r.items || [];
      title = `我收藏的云歌单 · ${items.length} 个`;
      needAnnotate = false;
    } else if (kind === "playlist") {
      const r = await api(`playlist-tracks?id=${encodeURIComponent(value)}&limit=500`);
      if (req !== list.req) return;
      if (!r || !r.ok) {
        el.listTitle.textContent = (r && r.error) || "云歌单曲目读取失败";
        return;
      }
      items = r.items || [];
      title = `${label || "云歌单"} · ${items.length} 首`;
    } else if (kind === "album") {
      const r = await api(`album?song=${encodeURIComponent(value)}`);
      if (req !== list.req) return;
      if (!r || !r.ok) {
        el.listTitle.textContent = (r && r.error) || "专辑读取失败";
        return;
      }
      items = r.songs || [];
      title = `专辑《${r.name || ""}》· ${items.length} 首`;
    } else {
      const r = await api(`search?keyword=${encodeURIComponent(value)}&limit=50`);
      if (req !== list.req) return;
      if (!r || !r.ok) {
        el.listTitle.textContent = (r && r.error) || "搜索失败";
        return;
      }
      items = r.items || [];
      title = `「${value}」· ${items.length} 首`;
    }
    list.items = items;
    el.listTitle.textContent = title;
    renderList();
    if (needAnnotate && items.length) {
      // 取不到音源的标灰：跟整页用同一份后端判断
      const ids = items.map((s) => s.id).join(",");
      api(`songs/annotate?ids=${encodeURIComponent(ids)}`)
        .then((r) => {
          if (req !== list.req || !r || !r.ok) return;
          list.bad = new Set((r.unplayable || []).map(String));
          renderList();
        })
        .catch(() => {});
    }
  } catch (error) {
    if (req === list.req) el.listTitle.textContent = String((error && error.message) || error);
  }
}

el.listBack.addEventListener("click", () => {
  list.req += 1; // 让在途的请求作废
  showList(false);
});

/** 点了一首歌、真的开播了之后自动收起列表（用户 2026-10-22）：
 *  列表是个抽屉，歌一唱起来就不该再盖着封面。
 *  与「← 返回」一样把在途请求作废，免得刚收起又被迟到的一次渲染拉回去。
 *  ⚠ 只在“真的播了”时调：播放失败要留在列表里让他再点；
 *    云歌单里点进去看曲目、点作者/专辑再走一层，都属于浏览，不收。 */
function closeListAfterPlay() {
  list.req += 1;
  showList(false);
}

/** 点完歌**等到真的放起来**再收起抽屉（2026-10-22 用户：放不了的歌要留在列表里报错、等他点下一首）。
 *  取源是异步的：`play-index`/`play` 返回 ok 只说明“命令收到了”，URL 可能几百毫秒后才失败。
 *  所以这里最多等 ~900ms：看到 `st.error` 就**不收**（列表留着，面板上会写真实原因），
 *  看到真在播才收。两个都没等到（还在取源）就按“能放”处理，免得抽屉卡在那里。 */
async function closeIfStarted() {
  for (let k = 0; k < 6; k += 1) {
    await new Promise((r) => setTimeout(r, 150));
    await refresh();
    const st = view.state || {};
    if (st.error) return; // 放不了：列表不收
    if (st.playing) break; // 起来了：可以收
  }
  closeListAfterPlay();
}

el.listRows.addEventListener("click", async (event) => {
  // 行内的作者 / 专辑也能点：接着往里走一层
  const who = event.target.closest("[data-artist]");
  if (who) return void openList("search", who.dataset.artist);
  const alb = event.target.closest("[data-album]");
  if (alb) return void openList("album", alb.dataset.album);
  const row = event.target.closest("li[data-i]");
  if (!row) return;
  const i = Number(row.dataset.i);
  const song = list.items[i];
  if (!song) return;
  try {
    if (list.kind === "playlists") {
      // 歌单列表里点一个 → 就地看它的曲目
      await openList("playlist", song.id, song.name);
      return;
    }
    if (list.kind === "queue") {
      // 队列里点一行＝跳到这首，不用重设队列
      const r = await control("play-index", { index: i + 1 });
      // 真的放起来了才收抽屉；放不了就留在列表里（2026-10-22）
      if (!r || r.ok !== false) await closeIfStarted();
      return;
    }
    const r = await post("play", { list: list.items, index: i });
    if (!r || r.ok !== false) {
      await refresh();
      markListCurrent();
      await closeIfStarted();
    }
  } catch (error) {
    el.note.textContent = String((error && error.message) || error);
    el.note.className = "warn";
  }
});

/* 「打开完整页面」：宿主提供了 hana.cards.open(cardId)（在 ui.js 里），
 * 传本应用声明的卡 id 就能把整页叫出来。封面与底部那颗按钮都走这里。 */
async function openFullPage() {
  try {
    if (!sdk || !sdk.cards || typeof sdk.cards.open !== "function") throw new Error("宿主没提供 cards.open");
    await sdk.cards.open("console");
  } catch (error) {
    el.note.textContent = "打不开完整页面：" + String((error && error.message) || error);
    el.note.className = "warn";
  }
}
if (el.btnPlaylists) el.btnPlaylists.addEventListener("click", () => openList("playlists", ""));

/* ---------------- 输入框上方的歌词条（mini 是主入口） ----------------
 * 一颗钮循环四种显示方式：居盈 → 散雪 → 行云 → 尽染（关不是循环里的一档，是右键）。
 * 会话身份取自宿主的「当前活动会话」；拿不到就报一句，不假装成功。
 * 整页那边的 ncm_music action=lyric-strip 是兜底入口。 */
const STRIP_LABEL = { off: "歌词", center: "居盈", shatter: "散雪", scroll: "行云", karaoke: "尽染" };
/** 钮上的字太少会看不出功能，悬停时补一句老白话。 */
const STRIP_HINT = { center: "中位固定", shatter: "唱完散开", scroll: "横向流动", karaoke: "逐字上色" };
/** 单击时的下一档：四种显示方式循环（不再包含「关」—— 关是右键）。
 *  顺序由异羽 2026-10-25 定：**散雪 → 居盈 → 行云 → 尽染**（与 lib/lyric-strip.js 的 STRIP_MODES 一致）。 */
const NEXT_MODE = { shatter: "center", center: "scroll", scroll: "karaoke", karaoke: "shatter" };
/** 把后端回的 mode 归一成按钮上的状态。**新增显示方式只改这一处**（以前在下面两处各写一遍，
 *  很容易只改一处 —— 2026-10-17 加 shatter 时顺手合并）。 */
const MODE_STATE = (m) =>
  m === "scroll" ? "scroll" : m === "karaoke" ? "karaoke" : m === "shatter" ? "shatter" : "center";
let stripState = "off";

async function activeSessionId() {
  try {
    if (sdk && sdk.sessions && typeof sdk.sessions.getActive === "function") {
      const active = await sdk.sessions.getActive();
      return active && active.sessionId ? String(active.sessionId) : "";
    }
  } catch {
    /* 权限没给、或宿主不支持 */
  }
  return "";
}

function renderLyricButton() {
  if (!el.btnLyric) return;
  const on = stripState !== "off";
  el.btnLyric.classList.toggle("on", on);
  el.btnLyric.textContent = STRIP_LABEL[stripState] || "歌词";
  el.btnLyric.setAttribute("aria-pressed", on ? "true" : "false");
  el.btnLyric.title = on
    ? `${STRIP_LABEL[stripState]}（${STRIP_HINT[stripState] || "歌词条"}）· 点击切换显示方式，右键收起`
    : "显示歌词条（右键可收起）";
}

async function refreshLyricButton() {
  const sessionId = await activeSessionId();
  if (!sessionId) return;
  try {
    const r = await api(`lyric-strip?sessionId=${encodeURIComponent(sessionId)}`);
    if (r && r.ok !== false) {
      stripState = !r.on ? "off" : MODE_STATE(r.mode);
      renderLyricButton();
    }
  } catch {
    /* 后端未就绪时安静跳过 */
  }
}

/* 单击：关着就开（用它上次那一档）；开着就在两种显示方式之间来回切。
 * 右键才是收起 —— 2026-10-12 用户报「滚动之后居中就没了」：
 * 原来是一条 off → center → scroll → off 的循环，他在 scroll 点一下不是回 center，
 * 而是直接进了 off，看起来就像「居中失效」。切显示方式不应该撞上关闭。 */
async function cycleLyricStrip() {
  const sessionId = await activeSessionId();
  if (!sessionId) {
    el.note.textContent = "拿不到当前会话，歌词条开不了";
    el.note.className = "warn";
    return;
  }
  const from = stripState;
  const body = from === "off"
    ? { sessionId, on: true }                                        // 不传 mode：用服务端记着的那一档
    : { sessionId, on: true, mode: NEXT_MODE[from] || "center" };
  try {
    const r = await post("lyric-strip", body);
    if (!r || r.ok !== true) {
      el.note.textContent = (r && r.error) || "歌词条操作失败";
      el.note.className = "warn";
      return;
    }
    stripState = MODE_STATE(r.mode);
    renderLyricButton();
    el.note.textContent = `歌词条：${STRIP_LABEL[stripState]}`;
    el.note.className = "";
  } catch (error) {
    el.note.textContent = String((error && error.message) || error);
    el.note.className = "warn";
  }
}

/** 右键：收起（与单击分开，免得切显示方式时误关）。 */
async function turnOffLyricStrip() {
  const sessionId = await activeSessionId();
  if (!sessionId) return;
  try {
    const r = await post("lyric-strip", { sessionId, on: false });
    if (r && r.ok === true) {
      stripState = "off";
      renderLyricButton();
      el.note.textContent = "歌词条已收起";
      el.note.className = "";
    }
  } catch {
    /* 忽略 */
  }
}

if (el.btnLyric) {
  el.btnLyric.addEventListener("click", () => void cycleLyricStrip());
  el.btnLyric.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void turnOffLyricStrip();
  });
}

/* 面板内的下钻：封面去完整页面（唯一的例外），歌名去播放列表，右下角那颗去歌单；
 * 歌名下那行的作者/专辑则分别去他的歌 / 这张专辑——其余都在面板里换。 */
if (el.coverBox) el.coverBox.addEventListener("click", openFullPage);
if (el.title) el.title.addEventListener("click", () => openList("queue", ""));

/* 歌名下的作者 / 专辑：点了就地出结果（不跳页，见上面的说明） */
if (el.sub) {
  el.sub.addEventListener("click", (event) => {
    const who = event.target.closest("[data-artist]");
    if (who) return void openList("search", who.dataset.artist);
    const alb = event.target.closest("[data-album]");
    if (alb) void openList("album", alb.dataset.album);
  });
}

el.bar.addEventListener("click", (event) => {
  const duration = view.clock.duration;
  if (!duration) return;
  const rect = el.bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  control("seek", { position: Math.round(ratio * duration) });
});

render();
sdk = await initHana();
try {
  if (sdk && sdk.lifecycle && sdk.lifecycle.subscribe) {
    sdk.lifecycle.subscribe((snap) => {
      lifecycleActive = !(snap && snap.active === false);
    });
  }
} catch {
  /* 拿不到就按一直活跃处理 */
}
await refresh(); // 先拿一次 /state，才知道现在是谁占着执行器
// 先抢一次：整页/别的面都不在时，声音就归这块面板出
beatExecutor();
setInterval(tick, 500);
setInterval(refresh, 1500);
// 心跳：告诉后端「我这个执行器还在」（1.5 秒一次，对齐后端 3 秒的租约）
setInterval(beatExecutor, 1500);
// 歌词条开关态：启动对齐一次，之后每 30 秒核一次（面板可能在别处被开/被宿主收走）
void refreshLyricButton();
setInterval(() => void refreshLyricButton(), 30000);
