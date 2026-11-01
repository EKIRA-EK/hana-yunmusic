/**
 * lib/player.js — 播放内核（v0.2，audio 后端）。
 *
 * 与旧版的根本区别：不再有 ncm-cli daemon + mpv 那套外部进程。取源走 api-enhanced，
 * 播放交给前端页面里的 HTML5 <audio>。
 *
 * 状态模型（这是双后端能共用的骨架）：
 *   后端持"真相"——队列 / 当前曲目 / 期望播放态 / 位置；前端宿主页面持"执行器"——audio 元素。
 *   前端轮询 /state 同步，把真实进度经 /progress 回报。mpv 后端（第二阶段）只是把执行器
 *   从"页面"换成"后端自己拉的进程"，这套状态语义不变。
 */

import { LEVELS } from "./api.js";

const STORAGE_KEY = "player-v2";
const URL_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LEVEL = "exhigh";

export function createPlayer({ api, logger, storage, mpv, ensureLocal }) {
  /** 切歌时的外部钩子（2026-10-30）：拿来做「播放时自动缓存」。失败不影响播放。 */
  let onPlay = null;
  function setOnPlay(fn) {
    onPlay = typeof fn === "function" ? fn : null;
  }
  const s = {
    queue: [],
    index: -1,
    level: DEFAULT_LEVEL,
    // 默认走界面播放（用户偏好）。要 bit-perfect、或想绕开「系统默认被虚拟设备接管」，自己切 MPV。
    // 界面播放随系统默认输出走，未 README 的边界说明。
    backend: "audio",
    wantPlaying: false,
    playing: false,
    position: 0,
    duration: 0,
    seekTo: null,
    seekNonce: 0,
    notice: "",
    error: "",
    busy: false,
    repeat: "off", // off | all | one
    shuffle: false,
    // 音量（0-100）。volumeSet 记「用户是否显式调过」：没调过时 mpv 模式下沿用桥的值
    // （mpv.json 是桥自己的持久化）；调过就以这里为准，并推给桥对齐。
    volume: 70,
    volumeSet: false,
    // mpv 后端专用：已经交给桥的那首曲目 id
    mpvLoadedId: "",
  };
  // 音频执行器的租约表：execId -> { at, rank }。整页、功能面板、同伴卡都可能来抢这个位置，
  // 谁心跳还在谁是执行器（整页优先；同级按 id 字典序定，保证只有一个赢家）。
  const execClaims = new Map();
  let lastExecId = "";
  // 3 秒租约（心跳 1.5 秒一次，给一次卡顿留余量）。TTL 再短就容易把一次抖动误判成「对方走了」、
  // 声音在两边来回跳；要更快的交接得同时把心跳也调快。
  const EXEC_TTL_MS = 3000;
  const EXEC_RANK = { page: 0, mini: 1 };
  // 「刚下过的控制」在这么长时间内不被执行器自报的播放态覆盖（见 progress）
  const CONTROL_GUARD_MS = 800;
  const urlCache = new Map();
  let syncInFlight = null;
  let lastControlAt = 0;
  // 队列里「当前音质档取不到音源」的 id（由 verifyQueue 填），以及检查的令牌与节流
  const unplayable = new Set();
  /* 队列里「只能试听片段」的 id → 可听秒数（未登录时 VIP 曲目常见）：也由 verifyQueue 填。
   * 与 unplayable 分开：试听的歌**有 url、能放**，只是只有 20~60 秒。 */
  const trialOnly = new Map();
  let verifyToken = 0;
  let verifyAt = 0;

  function log(levelfn, ...args) {
    try {
      if (logger && typeof logger[levelfn] === "function") logger[levelfn](...args);
    } catch {
      /* ignore */
    }
  }

  function persist() {
    try {
      storage.set(STORAGE_KEY, {
        queue: s.queue,
        index: s.index,
        level: s.level,
        backend: s.backend,
        repeat: s.repeat,
        shuffle: s.shuffle,
        volume: s.volume,
        volumeSet: s.volumeSet,
      });
    } catch (error) {
      log("warn", "music: 写本地状态失败", String((error && error.message) || error));
    }
  }

  async function init(saved) {
    try {
      if (saved && typeof saved === "object") {
        if (Array.isArray(saved.queue)) s.queue = saved.queue.slice(0, 500);
        if (Number.isFinite(saved.index)) s.index = saved.index;
        if (LEVELS.includes(saved.level)) s.level = saved.level;
        if (saved.backend === "audio" || saved.backend === "mpv") s.backend = saved.backend;
        if (saved.repeat === "off" || saved.repeat === "all" || saved.repeat === "one") s.repeat = saved.repeat;
        if (typeof saved.shuffle === "boolean") s.shuffle = saved.shuffle;
        if (Number.isFinite(saved.volume)) s.volume = Math.min(100, Math.max(0, Math.round(saved.volume)));
        if (typeof saved.volumeSet === "boolean") s.volumeSet = saved.volumeSet;
        // 恢复的队列不上报为"在播"，用户按播放才起播
        s.playing = false;
        s.wantPlaying = false;
        s.position = 0;
        s.mpvLoadedId = "";
      }
    } catch (error) {
      log("warn", "music: 读本地状态失败", String((error && error.message) || error));
    }
  }

  function currentSong() {
    return s.index >= 0 && s.index < s.queue.length ? s.queue[s.index] : null;
  }

  /**
   * 解析当前曲目在当前档的 URL。
   * allowStale：重新解析失败时，若缓存里有一条同曲同档的过期记录，就沿用它兜底。
   * 这是给「已经加载好、正在响」的那条流准备的：15 分钟 TTL 到期后的重解析若赶上上游
   * 抽风，旧 URL 多半仍然有效，不该让正在响的声音被误报成「取不到音源」而中断。
   * 首次就没成功过的（缓存里没有）照旧返回 null，走取不到音源那套。
   */
  async function resolveUrl(song, { allowStale = false } = {}) {
    if (!song || !song.id) return null;
    // 本地曲目自带地址，不去问网易云。但下载器那个小服务得先醒着，否则拉不动。
    if (song.local && song.url) {
      try {
        if (ensureLocal) await ensureLocal();
      } catch {
        /* 起不来就让播放器自己报错 */
      }
      return { at: Date.now(), url: song.url, br: 0, type: "", local: true };
    }
    const key = song.id + "@" + s.level;
    const hit = urlCache.get(key);
    if (hit && Date.now() - hit.at < URL_TTL_MS) return hit;
    // 异常继续往上抛：网络/接口错误是「取源失败」，与「这首歌没有音源」是两回事
    const r = await api.songUrl(song.id, s.level);
    if (!r || !r.url) {
      if (allowStale && hit && hit.url) return Object.assign({}, hit, { stale: true });
      return null;
    }
    const record = Object.assign({ at: Date.now() }, r);
    urlCache.set(key, record);
    return record;
  }

  /** 队列里第 i 首在当前音质档取不到音源吗（由 verifyQueue 填的 unplayable）。 */
  function isUnplayable(i) {
    const song = s.queue[i];
    return !!song && unplayable.has(String(song.id));
  }

  /* ---------------- 随机：按「一轮」来 ----------------
   * 开随机不再是「每次纯随机抽一个」（那样会重复抽到放过的，而且永不停），
   * 而是把队列当成一副洗好的牌：一轮里每首只放一次；一轮走完按循环模式决定：
   *   列表循环 → 重新洗一轮接着放；顺序播放 → 停。
   * 一轮进度记的是**歌曲 id**（不是下标），所以队列被重排（无音源沉底 / 手动拖拽）也不会错位。 */
  let shuffleRound = new Set();

  /* ---------------- 播放历史：随机模式下「上一首」走这里 ----------------
   * 随机是「洗好的牌」，077 有顺序意义上的前一首可退。标准做法是沿本轮实际走过的
   * 曲目往回走，所以单独记一条历史。存的是歌曲 id（不是下标）——队列会被无音源沉底/
   * 手动重排，存下标会错位。 */
  let playHistory = [];
  let historyAt = -1;

  /** 把一首歌记进历史并前移游标；被手动跳转打断的分支丢掉，重新从当前位置往后写。 */
  function noteHistory(song) {
    if (!song || !song.id) return;
    const id = String(song.id);
    playHistory = playHistory.slice(0, historyAt + 1);
    if (playHistory[playHistory.length - 1] !== id) playHistory.push(id);
    historyAt = playHistory.length - 1;
    if (playHistory.length > 300) {
      playHistory = playHistory.slice(-150);
      historyAt = playHistory.length - 1;
    }
  }

  /** 沿历史往回找上一首（跳过已经不在队列里的）；找不到返回 null，交给顺序逻辑兜底。 */
  function prevFromHistory() {
    for (let k = historyAt - 1; k >= 0; k -= 1) {
      const i = s.queue.findIndex((x) => x && String(x.id) === playHistory[k]);
      if (i < 0 || i === s.index) continue;
      historyAt = k;
      return i;
    }
    return null;
  }

  function resetShuffleRound(keepCurrent) {
    shuffleRound = new Set();
    if (!keepCurrent) return;
    const cur = currentSong();
    if (cur && cur.id) shuffleRound.add(String(cur.id));
  }

  /**
   * 随机抽一首。allowRollover 决定「一轮放完之后怎么办」：
   *   false（顺序播放的**自动**推进）→ 返回 null，交给调用方停住；
   *   true（列表循环的自动推进 / 用户**手动**按下一首）→ 重新洗一轮，接着放。
   *   ——手动按下一首不能变成「按了不动」，所以它总是 allowRollover。
   */
  function shuffledPick(allowRollover) {
    const n = s.queue.length;
    if (n < 2) return null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pool = [];
      for (let i = 0; i < n; i += 1) {
        if (i === s.index) continue;
        if (isUnplayable(i)) continue;
        const id = s.queue[i] && s.queue[i].id;
        if (id && shuffleRound.has(String(id))) continue; // 这一轮已经放过
        pool.push(i);
      }
      if (pool.length) {
        const pick = pool[Math.floor(Math.random() * pool.length)];
        // 关键：抽中的这首要记进「这一轮已放过」，否则下一拍又会把它放进候选，来回跳
        const id = s.queue[pick] && s.queue[pick].id;
        if (id) shuffleRound.add(String(id));
        return pick;
      }
      if (!allowRollover) return null;
      resetShuffleRound(true); // 重开一轮（当前这首算新一轮的第一首）
      if (!shuffleRound.size) return null; // 兑底，防空转
    }
    return null;
  }

  /**
   * 下一首/上一首的目标下标。
   * wrap 为真时（列表循环）到头回头；随机模式只影响往后跳（避开当前这首）。
   * 取不到音源的那些**不参与选中**：顺序就沿方向跳过，随机只在能放的里挑
   * ——否则会选中一首注定加载失败的歌，播放卡在那里只报错（§17.4）。
   * 实在没得放（整队都取不到音源、或随机一轮已放完且不循环）返回 null。
   */
  function adjacentIndex(delta, wrap) {
    const n = s.queue.length;
    if (!n) return null;

    // 随机：交给「洗好的牌」那套（一轮内不重复）。
    // wrap 同时充当「一轮放完能不能重洗」的开关：自动推进时 wrap 只在列表循环下为真，
    // 而手动按下一首时 wrap 因为 shuffle 为真——所以手动总找得到去处，不会「按了不动」。
    if (s.shuffle && delta > 0 && n > 1) return shuffledPick(!!wrap);

    let i = s.index;
    for (let step = 0; step < n; step += 1) {
      i += delta;
      if (i < 0) {
        if (!wrap) return null;
        i = n - 1;
      } else if (i >= n) {
        if (!wrap) return null;
        i = 0;
      }
      if (i === s.index) return n === 1 ? i : null; // 绕回自己：只有一首就是它，否则没别的可放
      if (!isUnplayable(i)) return i;
    }
    return null;
  }

  /**
   * 一首歌真的取不到音源（拿不到 URL；不是播放器报错）：把它标灰，并顺手跳到下一首能放的。
   * 标灰之后 adjacentIndex 就不再选中它了。返回是否真的换了曲目。
   * 只在「拿不到 URL」这一支上调用——设备被占、格式不支持这类播放器自身的问题不算无音源，
   * 标错了会把好歌误伤成灰的。
   */
  function autoSkipUnplayable(song) {
    if (!song) return false;
    const key = String(song.id);
    if (unplayable.has(key)) return false; // 已经知道它放不了：这次多半是用户点名要放的，不硬跳
    unplayable.add(key);
    verifyAt = 0; // 下一次自然触发时重核队列，让它归位到队尾
    const next = adjacentIndex(1, s.repeat === "all" || s.shuffle);
    if (next == null || next === s.index) {
      // null：整队都取不到音源；next === s.index：只有这一首。两种都没地方可去。
      s.wantPlaying = false;
      s.playing = false;
      s.position = 0;
      s.error = "队列里没有还能放的曲目了";
      return false;
    }
    jumpTo(next);
    s.error = `「${song.name || "这一首"}」取不到音源，已自动跳过`;
    return true;
  }

  function jumpTo(i) {
    s.index = i;
    s.position = 0;
    s.duration = 0;
    s.wantPlaying = true;
    s.playing = true;
    noteHistory(s.queue[i]);
    const picked = s.queue[i];
    if (picked && typeof onPlay === "function") {
      try {
        void onPlay(picked);
      } catch {
        /* 缓存出问题不能把切歌带倒 */
      }
    }
  }

  /** 队列重排：把 from 位置的曲目搬到 to 位置（0 基），并跟住当前播的那首。 */
  function moveQueueItem(from, to) {
    const n = s.queue.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const cur = s.index;
    const [item] = s.queue.splice(from, 1);
    s.queue.splice(to, 0, item);
    if (cur === from) s.index = to;
    else if (from < cur && to >= cur) s.index = cur - 1;
    else if (from > cur && to <= cur) s.index = cur + 1;
    persist();
    return true;
  }

  /** 一首放完后的推进（audio 的 ended 与 mpv 的 eof 共用）。 */
  /* 2026-10-22（用户）：「点播放不了的歌曲…还留在播放列表报错，等待点下一首，不用返回」。
     所以「用户点名要放的这一首」失败时不再自动跳过；只有自动推进 / 手动上下一首才跳。 */
  let pickByUser = false;

  function advanceAfterEnd() {
    pickByUser = false; // 自动推进不算点名
    if (!s.queue.length) {
      s.wantPlaying = false;
      s.playing = false;
      return;
    }
    if (s.repeat === "one") {
      // 单曲循环：原地重来（mpv 侧靠清掉 loadedId 让它重载同一首）
      s.position = 0;
      s.duration = 0;
      s.wantPlaying = true;
      s.playing = true;
      persist();
      return;
    }
    const next = adjacentIndex(1, s.repeat === "all");
    if (next == null) {
      s.wantPlaying = false;
      s.playing = false;
      s.position = 0;
      s.seekTo = null;
    } else {
      jumpTo(next);
    }
    persist();
  }

  /**
   * 把一首歌交给 mpv（取 URL → play）。取源失败 / 播放失败都落到 s.error。
   * 单独提出来，是为了让「一首放完接着下一首」能在同一次收敛里就把新曲目加载上，
   * 而不是等下一次 /state 轮询。
   */
  async function loadCurrentForMpv(song) {
    let record = null;
    try {
      record = await resolveUrl(song);
    } catch (error) {
      s.error = "取音源失败：" + String((error && error.message) || error);
    }
    if (!record || !record.url) {
      /* 2026-10-22：提示要说准。用户把档位降到“标准”后仍拿不到音源，实测直接问取源：
         /song/url/v1 三个档位全部 code=200 但 url 空、br=0，/song/detail 里 privilege.st=-200、pl=0
         → 是**版权/地区限制**，不是档位问题。所以：已经是最低档时不能再叫人“换低一档”。 */
      const lowest = s.level === "standard" || s.level === "higher";
      s.error = lowest
        ? "这首在取源那边没有可用音源（版权或地区限制）"
        : s.level === "exhigh"
          ? "这首歌暂时拿不到音源（可能需要会员或已下架）"
          : "这个音质档拿不到音源，换低一档试试";
      s.playing = false;
      s.wantPlaying = false; // 不追着这首每 1.5 秒重试一次
      /* ⚠ 2026-10-22 用户报「点了新歌，封面与歌词都换了，声音还是上一首」：
         切歌失败时 mpv 手里还留着**上一首的流** —— 它不会因为我们换了 index 就停。
         所以这里必须主动把执行器停掉、并清掉「已加载」标记，让状态和实施对齐。
         （如果 autoSkipUnplayable 找到下一首能放的，它会用 jumpTo 把 wantPlaying 重新打开） */
      s.mpvLoadedId = "";
      if (mpv) void mpv.stop().catch(() => null);
      /* 用户点名要放的这首放不了：留在它身上报错、等他点下一首（2026-10-22 用户要求）。
         自动推进 / 手动上下首碰到坏的才自动跳过 —— 那时不该让他一句句点过去。 */
      if (pickByUser) {
        pickByUser = false;
      } else {
        // 真的拿不到音源：标灰 + 跳到下一首能放的（下一次收敛会把它加载上）
        autoSkipUnplayable(song);
      }
      return false;
    }
    const r = await mpv
      .play({ url: record.url, position: s.position > 0 ? s.position : 0, pause: false })
      .catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
    if (r && r.ok === false) {
      s.error = "mpv 播放失败：" + (r.error || "未知");
      s.playing = false;
      // 同理：播放失败也不能让上一首接着响（否则又会「画面换了、声音没换」）
      s.wantPlaying = false;
      s.mpvLoadedId = "";
      if (mpv) void mpv.stop().catch(() => null);
      return false;
    }
    s.error = "";
    s.mpvLoadedId = song.id;
    s.playing = true;
    return true;
  }

  /**
   * mpv 模式下的执行器：后端直接驱动桥。
   * 与 audio 模式的区别只在于「执行器在哪」：audio 是页面的 <audio>，mpv 是后端自己。
   * 收敛逻辑（换曲 / 播停对齐 / EOF 推进）都在这里，/state 每次被拉都会走一遍。
   */
  async function mpvSync() {
    if (!mpv || s.backend !== "mpv") return null;
    let st;
    try {
      st = await mpv.status();
    } catch (error) {
      s.playing = false;
      if (!s.error) s.error = "连不上 mpv 桥：" + String((error && error.message) || error);
      return null;
    }
    if (!st || st.ok !== true) {
      s.playing = false;
      if (!s.error) s.error = "mpv 桥没起来";
      return null;
    }
    // 连上了就把之前留下的“连不上/没起来”清掉（切后端那一瞬的抢跑很常见）
    if (s.error && (s.error.startsWith("连不上 mpv 桥") || s.error.startsWith("mpv 桥没起来") || s.error.startsWith("mpv 播放失败"))) {
      s.error = "";
    }

    // 音量：没显式调过就沿用桥的值（mpv.json 是桥的持久化）；调过就以我们为准，推给它对齐
    if (Number.isFinite(st.volume)) {
      const bridgeVol = Math.min(100, Math.max(0, Math.round(st.volume)));
      if (!s.volumeSet) s.volume = bridgeVol;
      else if (bridgeVol !== s.volume) void mpv.volume(s.volume).catch(() => null);
    }
    // 真的又在播了，就把「中断」提示撤掉
    if (!st.idleActive && !st.paused && s.error && s.error.indexOf("中断") >= 0) s.error = "";

    // 桥重启过（它那边已经没有加载的 url 了），App 却还以为这首在 mpv 手里：清掉标记让它重载
    if (s.mpvLoadedId && s.wantPlaying && !st.url) {
      s.mpvLoadedId = "";
      s.playing = false;
      return st;
    }

    // mpv 明明空闲、我们却以为在播（输出设备中途没了 / AO 崩了）：不能继续假装在播。
    // 真正的恢复由桥自己做（它看得见失败事件并有级联），这里只负责说实话、把原因透出来。
    if (st.idleActive && s.mpvLoadedId && s.wantPlaying && st.error) {
      s.playing = false;
      if (!s.error) s.error = "MPV 播放中断：" + String(st.error).replace(/^mpv 播放失败：/, "");
      return st;
    }

    let song = currentSong();
    if (!song) {
      if (st.spawned && !st.idleActive) await mpv.stop().catch(() => null);
      s.mpvLoadedId = "";
      s.playing = false;
      s.position = 0;
      s.duration = 0;
      return st;
    }

    // 一首放完：用 mpvLoadedId 当「这次 eof 属于我们加载的那首」的凭据。
    // mpv 空闲时 eof 会一直为真，若不加这道闸，每次 /state 轮询都会再推进一次、把队列连跳。
    if (st.eof && s.mpvLoadedId) {
      s.mpvLoadedId = "";
      advanceAfterEnd();
      song = currentSong();
      if (!song || !s.wantPlaying) {
        s.playing = false;
        return st;
      }
    }

    if (s.mpvLoadedId !== song.id) {
      if (!s.wantPlaying) {
        s.playing = false;
        return st;
      }
      await loadCurrentForMpv(song);
      return st;
    }

    // 同一首：对齐播放/暂停，并跟上真实进度。
    // 命令下发后直接承认新状态（桥读一次要几毫秒，但前端每 1.5s 才拉一次，
    // 若在这里等桥的回复再改，用户会看到明显的延迟感）；下一次读到真实状态时自然会校正。
    if (s.wantPlaying && st.paused) {
      await mpv.resume().catch(() => null);
      s.playing = true;
    } else if (!s.wantPlaying && !st.paused) {
      await mpv.pause().catch(() => null);
      s.playing = false;
    }
    if (Number.isFinite(st.position)) s.position = st.position;
    if (Number.isFinite(st.duration) && st.duration > 0) s.duration = st.duration;
    s.playing = s.wantPlaying && !st.eof;
    return st;
  }

  /**
   * 收敛入口。并发的调用共享同一次收敛（也共享同一次桥读取）：
   * 以前重入时直接返回 null，调用方会误以为“桥没起来”，界面上就会闪一下错误。
   */
  async function pump() {
    if (s.backend !== "mpv" || !mpv) return null;
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
      try {
        return await mpvSync();
      } catch (error) {
        try {
          if (logger && typeof logger.warn === "function") logger.warn("music: mpv 收敛失败", String((error && error.message) || error));
        } catch {
          /* ignore */
        }
        return null;
      } finally {
        syncInFlight = null;
      }
    })();
    return syncInFlight;
  }

  function songView(song) {
    return song
      ? {
          id: song.id,
          name: song.name,
          artist: song.artist,
          album: song.album,
          coverUrl: song.coverUrl,
          local: song.local === true,
          duration: song.duration,
          liked: song.liked === true,
        }
      : null;
  }

  function pack(extra) {
    const song = currentSong();
    return Object.assign(
      {
        // 约定：应用自己的路由都带 ok（面板/整页都按它判成败）
        ok: true,
        song: songView(song),
        level: s.level,
        levels: LEVELS,
        backend: s.backend,
        wantPlaying: s.wantPlaying,
        playing: s.playing,
        position: s.position,
        duration: s.duration || (song ? Math.round((song.duration || 0) / 1000) : 0),
        seek: s.seekTo == null ? null : { position: s.seekTo, nonce: s.seekNonce },
        index: s.index,
        total: s.queue.length,
        repeat: s.repeat,
        shuffle: s.shuffle,
        // 音量：整页与侧栏面板都从这里读，两边才一致
        volume: s.volume,
        execId: currentExecutor(),
        executorAlive: executorAlive(),
        busy: s.busy,
        notice: s.notice,
        error: s.error,
      },
      extra || {},
    );
  }

  /** "/state" 的载荷：前端据此驱动 audio 元素；mpv 模式下 url 为空、由后端自己出声。 */
  async function state() {
    if (s.backend === "mpv" && mpv) {
      let st = await pump();
      if (!st) {
        // pump 只在“不是 mpv 模式”或“收敛仍在进行”时给 null，这里再直接问一次桥，
        // 避免把“跳过”误报成“桥没起来”。
        try {
          st = await mpv.status();
        } catch {
          st = null;
        }
      }
      const live = st && st.ok === true;
      if (live) {
        if (Number.isFinite(st.position)) s.position = st.position;
        if (Number.isFinite(st.duration) && st.duration > 0) s.duration = st.duration;
        s.playing = s.wantPlaying && !st.paused && !st.eof && !!s.mpvLoadedId;
      } else {
        s.playing = false;
        if (!s.error) s.error = "mpv 桥没起来（可切回界面播放，或点重启桥）";
      }
      s.seekTo = null; // mpv 模式下 seek 由后端直接落到桥上，不走 nonce 回路
      /* mpv 那一路也得报“是不是试听片段”：URL 是 App 解析好交给桥的（在 urlCache 里），
       * 这里取一次缓存即可（命中就不打接口）。 */
      const rec = await resolveUrl(currentSong(), { allowStale: true }).catch(() => null);
      return pack({
        url: "",
        br: 0,
        type: "",
        trial: (rec && rec.trial) || null,
        executor: "mpv",
        mpv: live
          ? {
              connected: st.connected === true,
              paused: st.paused === true,
              // config 是用户选的（下拉框据此回填），effective 是 mpv 实际在用的
              exclusive: !!(st.config && st.config.exclusive),
              device: (st.config && st.config.audioDevice) || "",
              effectiveExclusive: !!(st.effective && st.effective.exclusive),
              effectiveDevice: (st.effective && st.effective.device) || "",
              // 设备拔掉/独占打不开时的自动回退记录（没有就是 null）
              fallback: st.fallback || null,
              // mpv 的实际音量（页面在 mpv 模式下用它回填滑块）
              volume: Number.isFinite(st.volume) ? st.volume : null,
              loaded: !!s.mpvLoadedId,
            }
          : null,
      });
    }

    let song = currentSong();
    let url = "";
    let br = 0;
    let type = "";
    let trial = null;
    // 最多两轮：第二轮就是「这一首也拿不到 → 自动跳过 → 直接解析新的那一首」，
    // 免得页面先看到一首空的、要等下一次轮询（1.5s）才有声。
    for (let round = 0; round < 2 && song; round += 1) {
      let r = null;
      try {
        r = await resolveUrl(song, { allowStale: true });
      } catch (error) {
        s.error = "取音源失败：" + String((error && error.message) || error);
        break;
      }
      if (r) {
        url = r.url;
        br = r.br;
        type = r.type;
        trial = r.trial || null;
        s.error = "";
        break;
      }
      // 拿不到 URL＝这首在当前音质档确实放不了
      s.error = s.level === "exhigh" ? "这首歌暂时拿不到音源（可能需要会员或已下架）" : "这个音质档拿不到音源，换低一档试试";
      if (!autoSkipUnplayable(song)) {
        // 已标过（多半是用户点名的）或已无处可跳：就停在这。
        // 手上没有可用的流就不能还自称在播，否则 /state 会给出「url 空＋playing 真」
        // 这种自相矛盾的组合（面板会一边显示在放、一边一点声音也没有）。
        // wantPlaying 一并收：否则面板那颗键会“显示播放、点下去却发暂停”。
        s.playing = false;
        s.wantPlaying = false;
        break;
      }
      song = currentSong();
      url = "";
      br = 0;
      type = "";
    }
    // 执行器换人了（整页开了/关了）：把进度交接过去，别让新执行器从头唱
    const active = currentExecutor();
    if (active !== lastExecId) {
      lastExecId = active;
      if (active && s.position > 3) {
        s.seekTo = s.position;
        s.seekNonce += 1;
      }
    }
    return pack({ url, br, type, trial, executor: "audio", mpv: null });
  }

  function queueView() {
    return {
      items: s.queue.map((song, i) => ({
        index: i + 1,
        id: song.id,
        name: song.name,
        artist: song.artist,
        coverUrl: song.coverUrl,
        duration: Math.round((song.duration || 0) / 1000),
        // 队列行也要显示专辑（并可点）；歌单/搜索那几路本来就带 album，这里把它一并透出去
        album: song.album || "",
        current: i === s.index,
        unplayable: unplayable.has(String(song.id)),
        trial: trialOnly.has(String(song.id)),
        trialSeconds: trialOnly.get(String(song.id)) || 0,
        liked: song.liked === true,
      })),
      current: s.index + 1,
      total: s.queue.length,
    };
  }

  /**
   * 批量问一遍队列里哪些歌在当前音质档取不到音源，标成 unplayable，并把它们挪到队尾（保持原序）。
   * 代价是一次（或几次）批量接口调用，所以带节流；队列中途变了就丢掉过期结果。
   */
  async function verifyQueue({ force = false } = {}) {
    if (!s.queue.length) return { ok: true, total: 0, marked: 0 };
    if (!force && Date.now() - verifyAt < 5 * 60 * 1000) return { ok: true, skipped: "throttled" };
    verifyAt = Date.now();
    // 本地曲目不参与「取不到音源」核验（它们不走网易云，也换不来直链）
    const ids = s.queue.filter((x) => x && x.id && !x.local).map((x) => x.id);
    if (!ids.length) return { ok: true, total: 0, marked: 0 };
    const token = (verifyToken += 1);
    let map = null;
    try {
      map = await api.songUrls(ids, s.level);
    } catch (error) {
      log("warn", "music: 队列音源检查失败", String((error && error.message) || error));
      verifyAt = 0; // 失败不占掉节流窗，下次有机会重试
      return { ok: false, error: String((error && error.message) || error) };
    }
    if (token !== verifyToken) return { ok: true, stale: true };
    unplayable.clear();
    trialOnly.clear();
    for (const id of ids) {
      const r = map[String(id)];
      if (!r || !r.url) unplayable.add(String(id));
      else if (r.trial) trialOnly.set(String(id), Number(r.trial.seconds) || 0);
    }
    // 顺手把「谁已红心」也核一遍：队列行和播放器那颗心都从后端取，保证同源，
    // 不再让页面为了列表红心另开一次批量查询（那会造成几秒的“播放器已亮、列表还空”）。
    try {
      const likedIds = await api.likeCheck(ids);
      const likedSet = new Set((Array.isArray(likedIds) ? likedIds : []).map(String));
      for (const song of s.queue) song.liked = likedSet.has(String(song.id));
    } catch (error) {
      log("warn", "music: 队列红心检查失败", String((error && error.message) || error));
    }
    persist();
    if (unplayable.size) {
      const cur = currentSong();
      const keep = s.queue.filter((x) => !unplayable.has(String(x.id)));
      const bad = s.queue.filter((x) => unplayable.has(String(x.id)));
      if (keep.length !== s.queue.length) {
        s.queue = keep.concat(bad);
        if (cur) {
          const i = s.queue.indexOf(cur);
          if (i >= 0) s.index = i;
        }
        persist();
      }
    }
    return { ok: true, total: ids.length, marked: unplayable.size };
  }

  function startList(list, index) {
    const clean = (Array.isArray(list) ? list : []).filter((x) => x && x.id);
    if (!clean.length) return { ok: false, error: "没有可播放的曲目" };
    pickByUser = true; // 从列表里点名要这一首
    const at = Math.min(Math.max(0, Number(index) || 0), clean.length - 1);
    s.queue = clean;
    s.index = at;
    s.position = 0;
    s.duration = 0;
    s.error = "";
    s.wantPlaying = true;
    s.playing = true;
    /* 从搜索/歌单/每日推荐起播也走一次缓存钩子（2026-10-31）：
       以前只在 jumpTo 里调，从这几处打开的“正在播的歌”不会被缓存，
       异羽就碰到了“在播放的歌怎么没有下载”。 */
    const picked = s.queue[at];
    if (picked && typeof onPlay === "function") {
      try {
        void onPlay(picked);
      } catch {
        /* 缓存问题不能把起播带倒 */
      }
    }
    persist();
    // 换队列了：上一轮的核验结论作废，节流窗也归零，让新队列这次一定被核到。
    // 不归零的话，5 分钟内的换队列会被节流挡掉，出现「只标灰、不挪队尾」的半截态。
    unplayable.clear();
    trialOnly.clear();
    verifyAt = 0;
    // 随机的一轮也从头开始（当前这首算新一轮的第一首）；播放历史同理，换队列＝换一副牌。
    // （verifyQueue 可能把无音源沉底、后面还会重排，所以历史存 id 不存下标。）
    resetShuffleRound(true);
    playHistory = [];
    historyAt = -1;
    noteHistory(currentSong());
    // 后台核一遍队列里哪些歌取不到音源（会标灰并挪到队尾），不挡起播
    void verifyQueue();
    return { ok: true, index: s.index, total: s.queue.length };
  }

  function setLevel(level) {
    if (!LEVELS.includes(level)) return { ok: false, error: "未知音质档" };
    if (level === s.level) return { ok: true, level };
    s.level = level;
    urlCache.clear();
    persist();
    // 换音质档＝可播性可能整批变，旧结论作废并重新核一遍（同样把节流窗归零）
    unplayable.clear();
    trialOnly.clear();
    verifyAt = 0;
    void verifyQueue();
    return { ok: true, level };
  }

  /** 设音量（0-100）。后端持这一份：mpv 模式下顺手推给桥（桥再落盘 mpv.json），
   *  audio 模式下这一份就是下次重载后要用的值（以前 audio 音量只存在页面内存里，重载就回 70）。 */
  function setVolume(value) {
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) return { ok: false, error: "volume 不是数字" };
    s.volume = Math.min(100, Math.max(0, v));
    s.volumeSet = true;
    persist();
    if (s.backend === "mpv" && mpv) void mpv.volume(s.volume).catch(() => null);
    return { ok: true, volume: s.volume };
  }

  function setBackend(backend) {
    if (backend !== "audio" && backend !== "mpv") return { ok: false, error: "未知播放后端" };
    if (backend === s.backend) return { ok: true, backend };
    s.backend = backend;
    s.mpvLoadedId = "";
    s.error = "";
    s.seekTo = null;
    if (backend === "audio" && mpv) {
      // 必须真停：mpv 若在独占模式下，暂停也不会放手设备（§13.2），
      // 页面的 <audio> 拿不到设备，会直接报「音频播放失败（错误码 3）」。
      // （v0.5.4 曾改成暂停想保住蓝牙链路，既没解决当时的问题，又添了这个故障，已撤回。）
      void mpv.stop().catch(() => null);
    }
    persist();
    return { ok: true, backend };
  }

  async function control(action, payload = {}) {
    const a = String(action || "").toLowerCase();
    lastControlAt = Date.now();
    switch (a) {
      case "play":
      case "resume":
        if (s.index < 0 && s.queue.length) s.index = 0;
        s.wantPlaying = true;
        s.playing = true;
        break;
      case "pause":
        s.wantPlaying = false;
        s.playing = false;
        break;
      case "toggle":
        if (s.playing) {
          s.wantPlaying = false;
          s.playing = false;
        } else {
          if (s.index < 0 && s.queue.length) s.index = 0;
          s.wantPlaying = true;
          s.playing = true;
        }
        break;
      case "next": {
        pickByUser = false; // 手动上下首不算“点名要这一首”，撞到放不了的可以自动跳
        const i = adjacentIndex(1, s.repeat === "all" || s.shuffle);
        if (i != null) jumpTo(i);
        break;
      }
      case "prev": {
        pickByUser = false;
        // 随机模式下没有「顺序意义上的前一首」（一轮是洗好的牌），标准做法是沿本轮
        // 实际走过的曲目往回退。历史里没得退（例如刚开始），再走顺序逻辑兜底。
        const back = s.shuffle ? prevFromHistory() : null;
        if (back != null) {
          jumpTo(back);
          break;
        }
        const i = adjacentIndex(-1, s.repeat === "all");
        if (i != null) jumpTo(i);
        break;
      }
      case "repeat": {
        const mode = String(payload.mode || "");
        if (mode !== "off" && mode !== "all" && mode !== "one") return { ok: false, error: "未知循环模式" };
        s.repeat = mode;
        break;
      }
      case "cycle-repeat":
        s.repeat = s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off";
        break;
      case "shuffle":
        s.shuffle = payload.on === undefined ? !s.shuffle : payload.on === true;
        // 开随机就洗一轮（当前这首算第一首）；关随机就把这一轮丢掉
        resetShuffleRound(s.shuffle);
        break;
      case "move": {
        if (!moveQueueItem(Number(payload.from) - 1, Number(payload.to) - 1)) {
          return { ok: false, error: "重排参数不对" };
        }
        break;
      }
      case "stop":
        s.wantPlaying = false;
        s.playing = false;
        s.position = 0;
        s.mpvLoadedId = "";
        // 位置归零也要推给执行器，否则它手里那条流还停在半截，下次播就从那里接上
        s.seekTo = 0;
        s.seekNonce += 1;
        if (mpv) {
          // 无论哪个后端都真停 mpv：音频模式下它是被「暂停保链路」留着的，
          // 按停止就该把设备真正放开（不然声卡一直被握着，别的程序出不了声）。
          void mpv.stop().catch(() => null);
        }
        break;
      case "seek":
        s.seekTo = Math.max(0, Number(payload.position) || 0);
        s.seekNonce += 1;
        s.position = s.seekTo;
        if (s.backend === "mpv" && mpv) {
          // mpv 模式：直接落桥，不走 nonce 让前端执行
          const pos = s.seekTo;
          s.seekTo = null;
          void mpv.seek(pos).catch(() => null);
        }
        break;
      case "seek-done":
        if (Number(payload.nonce) === s.seekNonce) s.seekTo = null;
        break;
      case "play-index": {
        pickByUser = true; // 用户点了列表里的这一首
        const i = Number(payload.index) - 1;
        if (i >= 0 && i < s.queue.length) jumpTo(i);
        break;
      }
      case "ended":
        advanceAfterEnd();
        break;
      default:
        return { ok: false, error: `未知动作 ${action}` };
    }
    persist();
    // 起播/续播时把当前这首补进历史：重启后从本地恢复的队列，playHistory 是空的，
    // 不补一下的话，随机模式下第一下「上一首」会退到顺序前一首，而不是本轮听过的。
    if (s.playing && (a === "play" || a === "resume" || a === "toggle")) noteHistory(currentSong());
    if (s.backend === "mpv") await pump();
    return { ok: true };
  }

  function touchExecutor(id, role) {
    const key = String(id || "");
    if (!key) return;
    execClaims.set(key, { at: Date.now(), rank: EXEC_RANK[String(role || "")] ?? 9 });
    // 顺手清掉早就没人续的，别让表一直长
    const now = Date.now();
    for (const [k, v] of execClaims) if (now - v.at > EXEC_TTL_MS * 4) execClaims.delete(k);
  }

  /** 当前该由谁出声：心跳还新鲜的那些里 rank 最小者；同级按 id 字典序。没有就是空串。 */
  function currentExecutor() {
    const now = Date.now();
    let best = "";
    let bestRank = Infinity;
    for (const [id, v] of execClaims) {
      if (now - v.at > EXEC_TTL_MS) continue;
      if (v.rank < bestRank || (v.rank === bestRank && id < best)) {
        best = id;
        bestRank = v.rank;
      }
    }
    return best;
  }

  /** 还有任何执行器在吗（心跳 6 秒内）。mpv 后端下执行器在后端自己身上，恒为真。 */
  function executorAlive() {
    if (s.backend === "mpv") return true;
    return !!currentExecutor();
  }

  /** 前端回报播放进度 / 心跳。mpv 模式下不采信进度（真相在后端手里）。
   *  进度只认「当前执行器」那一份，免得多方在交接时来回改位置。 */
  function progress(payload = {}) {
    if (payload.beat) {
      touchExecutor(payload.execId, payload.role);
      return { ok: true, execId: currentExecutor() };
    }
    if (s.backend === "mpv") return { ok: true, ignored: "mpv" };
    if (payload.execId) touchExecutor(payload.execId, payload.role);
    const active = currentExecutor();
    if (active && payload.execId && String(payload.execId) !== active) {
      return { ok: true, ignored: "not-executor", execId: active };
    }
    const pos = Number(payload.position);
    const dur = Number(payload.duration);
    if (Number.isFinite(pos)) s.position = Math.max(0, pos);
    if (Number.isFinite(dur) && dur > 0) s.duration = dur;
    if (typeof payload.playing === "boolean") {
      // 刚下过明确定意的控制（暂停/播放/停止）之后的短窗内，不采信执行器自报的播放态：
      // 那份回报可能是控制到达之前发出的，会把刚设下的意图又掰回去
      //（表现就是「按了暂停，它自己又开播」）。位置/时长照收，只是窗口内不改写意图。
      if (Date.now() - lastControlAt > CONTROL_GUARD_MS) {
        s.playing = payload.playing;
        // 用户在前端手动暂停/播放时，把期望态一并拉齐，避免后端状态和实际声音脱节
        s.wantPlaying = payload.playing;
      }
    }
    return { ok: true, execId: active };
  }

  /** 某首歌的红心变了：把队列里同 id 的项一起改掉（后端持真相，页面只负责显示）。 */
  function markLiked(id, on) {
    const key = String(id || "");
    if (!key) return { ok: false, error: "缺少歌曲 id" };
    let hit = 0;
    for (const song of s.queue) {
      if (String(song.id) === key) {
        song.liked = on === true;
        hit += 1;
      }
    }
    persist();
    return { ok: true, changed: hit };
  }

  function setNotice(text) {
    s.notice = String(text || "");
    return { ok: true };
  }

  async function like(on) {
    const song = currentSong();
    if (!song) return { ok: false, error: "没有在播放的曲目" };
    if (song.local) return { ok: false, error: "本地曲目没有红心" };
    try {
      await api.like(song.id, on !== false);
      song.liked = on !== false;
      persist();
      return { ok: true, liked: song.liked };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  /** 执行器换了参数（如 mpv 输出设备/独占改了）：清掉已加载标记，让它重上一遍。 */
  async function reloadExecutor() {
    s.mpvLoadedId = "";
    s.error = "";
    return pump();
  }

  return {
    init,
    setOnPlay,
    state,
    queueView,
    startList,
    control,
    progress,
    setLevel,
    setBackend,
    setVolume,
    setNotice,
    like,
    markLiked,
    pump,
    verifyQueue,
    reloadExecutor,
    get level() {
      return s.level;
    },
    get queue() {
      return s.queue;
    },
  };
}
