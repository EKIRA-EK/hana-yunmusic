/**
 * lib/lyric-strip.js — 把歌词放到会话输入框上方（app/input.panels）。
 *
 * 宿主允许一块 App 自己的 ui 文档挂在某个会话的输入框上方
 * （contract 原话：「run a trusted App's custom UI above a session's composer」）。
 * 这个文件只管四件事：
 *
 *   1. 认会话：面板按会话存在，宿主只认稳定 sessionId；而工具调用那边递过来的
 *      是 sessionPath，所以要换一次（转换办法与踩的坑见 resolveRef）。
 *   2. 开与关：show / dismiss。
 *   3. 记个开关态：让 mini 面板的按钮知道自己该亮还是该暗。
 *   4. 显示方式的偏好（center 中位恒定 / scroll 横向流动），持久化在 storage 里。
 *      **偏好变了以后，已挂载的面板页要自己跟上** —— 页面侧的轮询在
 *      ui/assets/lyric-strip.js 的 syncMode()，那边每 2 秒核一次。
 *
 * 记在内存里就够：面板本身是临时的（App reload / HANA 重启后宿主就不认了），
 * 所以不做「跨重启恢复」的假装 —— 那样只会让按钮亮着而面板不在。
 *
 * 曾试过用宿主的 `ctx.inputBanner` 做第三种「横幅」显示（零权限、一行文本），
 * 2026-10-12 用户看过效果后否掉：太简陋，与面板同一位置还得分时复用。已删。
 */

export const PANEL_ID = "lyric-strip";
const PANEL_TITLE = "歌词条";
const PANEL_MESSAGE = "当前歌词显示在输入框上方";

/** 面板高度：默认值、可调区间、收起高度（宿主允许 24–4096）。
 *  2026-10-12：由 104 降到 76（用户说“有点高”），并做成可在线上调（setHeight 走 updatePanel，
 *  改分配而不重挂，所以调高度不用 reload、不断歌）。
 *  2026-10-14：下限由 40 降到 32 —— 因为字号联动给 20px 配的高度是 36，
 *  而 36 < 40，读回时被自己的下限校验拒掉，表现为「改完字号高度又变回 76」。
 *  所以下限必须小于联动表里最小的那个值。 */
const PANEL_HEIGHT_DEFAULT = 76;
const PANEL_HEIGHT_MIN = 32;
const PANEL_HEIGHT_MAX = 240;
const PANEL_COLLAPSED_HEIGHT = 28;
/** 散雪那一档要往字下面留出「落下去」的距离，而那个距离在 40px 高的面板里只有几像素。
 *  所以这一档临时把面板撑到「字号 × 2.6」：20→52、24→62、30→78、36→94。
 *  切回其它模式就回到用户原来的高度（持久化的一直是原来那份，不被这档污染）。
 *  做法是用户 0.18.0 带来的（他那边想到的），合并时保留。 */
const SHATTER_HEIGHT_RATIO = 2.6;

/** 四种显示方式，都由面板页自己画：center **居盈**（居中盈满，中位恒定）；shatter **傲雪**（傲雪随风，唱完胀一下再碎成雪粒被风吹散）；
 *  scroll **行云**（行云流水，横向流动）；karaoke **尽染**（层云尽染，逐字上色）。
 *  名字沿革：2026-10-20 定名「居庭 / 行云 / 层染 / 散雪」；2026-10-25 异羽要求
 *  居庭→**居盈**、层染→**尽染**，并把顺序改成「散雪 - 居盈 - 行云 - 尽染」；
 *  2026-10-28 再把散雪→**傲雪**（顺序不变）。四档意境：傲雪随风 / 居中盈满 / 行云流水 / 层云尽染。
 *  ⚠ 只换了**显示名与顺序**，**id 一个都没改** —— 偏好里存的是 center/scroll/karaoke/shatter，
 *    老用户重载后不会掉档。改这个数组要同步 ui/assets/mini.js 的 NEXT_MODE 与 index.js 的工具描述。 */
export const STRIP_MODES = ["shatter", "center", "scroll", "karaoke"];
/** 配色档：theme 跟随界面主题（默认，从宿主的 --accent / --text-muted 取），
 *  其余是面板页里写死的固定色。改这个列表要同步 `ui/lyric-strip-2.html` 的
 *  `html[data-palette=…]` 规则与 `ui/assets/lyric-strip.js` 的 PALETTES。
 *  2026-10-14 用户要求：在字号钮旁边加一颗钮循环切它。
 *  **顺序就是点击循环的顺序**（2026-10-14 用户定）：跟随主题 → 陶土 → 苔青 → 藏青 → 松绿 → 鲸蓝。
 *  改顺序要两边一起改，别只改一处。 */
export const STRIP_PALETTES = ["theme", "clay", "teal", "ink", "sage", "whale"];
/** 可选的当前句字号（px）。面板上那颗钮循环切。
 *  2026-10-13 用户要求改成四档 20 / 24 / 30 / 36（原 17 / 20 / 24）。 */
export const STRIP_FONTS = [20, 24, 30, 36];

/** 字号 → 配套高度（用户 2026-10-13 要求：改字号时高度自动跟上，免得记对照表）。
 *  算式是「字号 × 1.2（行盒）+ 10px（滚动/上色模式底部留的缓冲）」，再留一点余量。
 *  实测吻合：24 → 40 正好是用户原本手调的满意值。 */
const FONT_HEIGHT = { 20: 36, 24: 40, 30: 48, 36: 56 };
const MODE_KEY = "lyric-strip-v1";

/** 一次挂几个会话（用户 2026-10-16 定）。
 *  以前只挂在「点开它的那个会话」上，切到别的会话歌词就没了；现在挂到**最近活跃的前 N 个**
 *  会话上，在几个会话之间来回工作时切到哪个都能看到。
 *  口径与 session-stats 那套一致：sessions.list(scope=all, lifecycle=active) 按 modified 倒序。
 *  想多挂几个就改这一个数。 */
const RECENT_SESSIONS = 5;

export function createLyricStrip({ sdk, logger }) {
  /** 想在输入框上方看到歌词的会话（sessionId）。 */
  const wantShow = new Set();
  /** sessionId → sessionPath（只是留个记录，将来要用时不必再换一次）。 */
  const pathOf = new Map();
  /** 字体档位（2026-10-23）：hana = 跟随 HANA（inherit），其余是系统字体。
   *  两边（带子 / 整页歌词）共用这一份设置，免得一首歌两个地方长得不一样。 */
  const STRIP_FAMILIES = [
    /* “跟随 HANA”已删（2026-10-23）：它写的是 inherit，但带子/整页都是独立文档，
       inherit 只能继承本页默认字体，跟不到 HANA 的设置 —— 名字具有误导性，异羽定的去掉。 */
    { id: "serif", label: "衬线", css: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif', group: "hana" },
    { id: "sans", label: "非衬线", css: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif', group: "hana" },
    /* 霞鹜新致宋不再写死：HANA 里的真实族名是 HanaLXGWNeoZhiSong（我早先写的
       "LXGW New Zhi Song" / "霞鹜新致宋" 都匹配不上，于是退回宋体），现在由字体库统一提供。 */
    { id: "yahei", label: "微软雅黑", css: '"Microsoft YaHei", "PingFang SC", sans-serif', group: "zh" },
    { id: "simsun", label: "宋体", css: "SimSun, serif", group: "zh" },
    { id: "kaiti", label: "楷体", css: "KaiTi, STKaiti, serif", group: "zh" },
    { id: "dengxian", label: "等线", css: "DengXian, sans-serif", group: "zh" },
    { id: "heiti", label: "黑体", css: "SimHei, sans-serif", group: "zh" },
    { id: "fangsong", label: "仿宋", css: "FangSong, STFangsong, serif", group: "zh" },
    { id: "georgia", label: "Georgia", css: "Georgia, serif", group: "en" },
    { id: "segoe", label: "Segoe UI", css: '"Segoe UI", sans-serif', group: "en" },
    { id: "times", label: "Times New Roman", css: '"Times New Roman", serif', group: "en" },
  ];
  /** 当前显示方式、字号、配色与面板高度；首次用到时从 storage 读一次。 */
  let mode = "center";
  let font = 20;
  let palette = "theme";
  let family = "serif";
  /** 用户/字号联动定下的高度（**持久化的是这份**）。 */
  let userHeight = PANEL_HEIGHT_DEFAULT;
  /** 实际用在面板上的高度：散雪那一档会被临时撑高（见 syncHeightForMode）。 */
  let height = PANEL_HEIGHT_DEFAULT;
  /** 偏好只读一次，但**后续调用等的是同一个 promise**；
   *  读成功后才置 prefsLoaded，读失败会把 promise 清掉以便重试。 */
  let prefsLoaded = false;
  let prefsPromise = null;
  /** sessionId → 宿主给的 panelId（改高度要用它调 updatePanel）。 */
  const panelIdOf = new Map();

  function log(level, ...args) {
    try {
      if (logger && typeof logger[level] === "function") logger[level](...args);
    } catch {
      /* ignore */
    }
  }

  /**
   * 把「一个会话引用」补全成 { sessionId, sessionPath }。
   *
   * 实测坑（2026-10-12）：工具上下文（HanaPluginToolExecuteContextV2）只有 sessionPath，
   * 而面板只认 sessionId；session:get 与 session:entries 对 sessionPath 一律拒绝
   * （「Session manifest resolution requires sessionId or legacy sessionPath.」，
   * 显式传 legacySessionPath 也一样）。能走的是 session:list：它返回的字段是
   * **path**（不是 sessionPath）+ sessionId，拿文件名尾巴对一次即可。
   */
  async function resolveRef(ref) {
    const sessionId = String((ref && ref.sessionId) || "").trim();
    const sessionPath = String((ref && ref.sessionPath) || "").trim();
    if (sessionId) {
      if (sessionPath) pathOf.set(sessionId, sessionPath);
      return { sessionId, sessionPath: sessionPath || pathOf.get(sessionId) || "" };
    }
    if (!sessionPath) return { sessionId: "", sessionPath: "" };

    const errors = [];
    try {
      const listed = await sdk.sessions.list({ scope: "all", lifecycle: "active" });
      const sessions = (listed && listed.sessions) || [];
      const tail = sessionPath.split(/[\\/]/).pop();
      const hit = sessions.find((s) => s && s.sessionId && (
        s.path === sessionPath
        || String(s.path || "").endsWith(tail)
        || String(s.sessionPath || "").endsWith(tail)
      ));
      if (hit) {
        pathOf.set(String(hit.sessionId), sessionPath);
        return { sessionId: String(hit.sessionId), sessionPath };
      }
      errors.push(`session:list 里没对上（共 ${sessions.length} 个）`);
    } catch (error) {
      errors.push(`session:list: ${String((error && error.message) || error)}`);
    }

    // 备用：万一将来宿主认了 sessionPath / legacySessionPath，这两条能接住。
    for (const target of [{ sessionPath, scope: "all" }, { legacySessionPath: sessionPath, scope: "all" }]) {
      const label = `${Object.keys(target)[0]}@${target.scope}`;
      try {
        const result = await sdk.sessions.get(target);
        const found = result && result.session && result.session.sessionId;
        if (found) {
          pathOf.set(String(found), sessionPath);
          return { sessionId: String(found), sessionPath };
        }
        errors.push(`${label}: 没返回 sessionId`);
      } catch (error) {
        errors.push(`${label}: ${String((error && error.message) || error)}`);
      }
    }

    log("warn", `hana-yunmusic: 换 sessionId 失败（${errors.join(" | ")}）`);
    return { sessionId: "", sessionPath };
  }

  async function showPanel(sessionId) {
    try {
      const shown = await sdk.userInteraction.show({
        sessionId,
        id: PANEL_ID,
        title: PANEL_TITLE,
        message: PANEL_MESSAGE,
        contentFrame: { route: "/lyric-strip-2.html" },
        presentation: { height, collapsedHeight: PANEL_COLLAPSED_HEIGHT, expanded: true },
      });
      const panelId = (shown && shown.panelId) || "";
      if (panelId) panelIdOf.set(sessionId, panelId);
      return { ok: true, on: true, mode, height, sessionId, panelId };
    } catch (error) {
      const message = String((error && error.message) || error);
      log("warn", "hana-yunmusic: 挂歌词面板失败", message);
      return { ok: false, error: message };
    }
  }

  async function dismissPanel(sessionId) {
    try {
      await sdk.userInteraction.dismiss({ sessionId, id: PANEL_ID });
    } catch (error) {
      // 宿主那边本来就没有这块面板时会报错，按「已经摘掉」处理，不打扰用户。
      log("info", "hana-yunmusic: 摘歌词面板时宿主报错（按已摘处理）", String((error && error.message) || error));
    }
    panelIdOf.delete(sessionId);
    return { ok: true, on: false, sessionId };
  }

  function ensureLoaded() {
    if (prefsLoaded) return Promise.resolve();
    if (!prefsPromise) prefsPromise = readPrefs();
    return prefsPromise;
  }

  async function readPrefs() {
    try {
      const saved = await sdk.storage.global.get(MODE_KEY, null);
      if (saved && STRIP_MODES.includes(saved.mode)) mode = saved.mode;
      if (saved && STRIP_PALETTES.includes(saved.palette)) palette = saved.palette;
      if (saved && STRIP_FONTS.includes(Number(saved.font))) font = Number(saved.font);
      const savedHeight = Number(saved && saved.height);
      const savedFamily = String((saved && saved.family) || "");
      /* 关键：字体库里的自定义字体存的是 hfont: 开头，列表是动态的 ——
         这里必须和 setFamily 用同一套口径放行，否则每次冷启动都会退回默认值（2026-10-23 异羽报的“不保存”）。 */
      if (STRIP_FAMILIES.some((f) => f.id === savedFamily) || /^hfont:/.test(savedFamily)) family = savedFamily;
      if (Number.isFinite(savedHeight) && savedHeight >= PANEL_HEIGHT_MIN && savedHeight <= PANEL_HEIGHT_MAX) {
        userHeight = Math.round(savedHeight);
      }
      syncHeightForMode();
      prefsLoaded = true;
    } catch (error) {
      // 读失败**不能**把 prefsPromise 留着（否则之后永远用默认值），也不能让调用方接着写回 ——
      // 那会用默认值覆盖用户真实的偏好。2026-10-13 抓到：reload 后冷启时机太早读不到，
      // 紧接着一次写入把 mode/font/height 全洗成了默认值（用户看到的是「高度莫名回了 76」）。
      log("warn", "hana-yunmusic: 读歌词条偏好失败，稍后重试", String((error && error.message) || error));
      prefsPromise = null;
    }
  }

  /** 实际高度 = 用户定的，但散雪那一档要撑高（不然雪粒没有下落的空间）。 */
  function syncHeightForMode() {
    const want = mode === "shatter"
      ? Math.max(userHeight, Math.round(font * SHATTER_HEIGHT_RATIO))
      : userHeight;
    height = Math.max(PANEL_HEIGHT_MIN, Math.min(PANEL_HEIGHT_MAX, want));
  }

  async function persistPrefs() {
    // 偏好还没读到就**不写**：否则默认值会盖掉用户真实的设置（上面那个 bug 的另一半）。
    if (!prefsLoaded) {
      log("warn", "hana-yunmusic: 偏好尚未读到，跳过写入（免得用默认值覆盖）");
      return;
    }
    try {
      // 写的是 userHeight：散雪那一档临时撑高的那几像素不落到偏好里
      await sdk.storage.global.set(MODE_KEY, { mode, font, height: userHeight, palette, family });
    } catch (error) {
      log("warn", "hana-yunmusic: 存歌词条偏好失败", String((error && error.message) || error));
    }
  }

  async function getHeight() {
    await ensureLoaded();
    return height;
  }

  /**
   * 把当前高度应用到所有已在场的面板上（改分配，**不重挂** —— 所以不用 reload、不断歌）。
   * 调高度与调字号都走它。
   */
  async function applyHeight() {
    for (const sessionId of Array.from(wantShow)) {
      const panelId = panelIdOf.get(sessionId);
      if (!panelId) continue;
      try {
        await sdk.userInteraction.updatePanel({ sessionId, panelId, presentation: { height } });
      } catch (error) {
        log("warn", "hana-yunmusic: 改面板高度失败", String((error && error.message) || error));
      }
    }
  }

  /**
   * 改面板高度。已经在场上的面板直接 updatePanel 改分配，**不重挂** ——
   * 所以调高度不必 reload App，也不会把正在放的歌切断。
   */
  async function setHeight(next) {
    await ensureLoaded();
    const value = Math.round(Number(next));
    if (!Number.isFinite(value) || value < PANEL_HEIGHT_MIN || value > PANEL_HEIGHT_MAX) {
      return { ok: false, error: `高度要在 ${PANEL_HEIGHT_MIN}–${PANEL_HEIGHT_MAX} 之间` };
    }
    userHeight = value;
    syncHeightForMode();
    await persistPrefs();
    await applyHeight();
    log("info", "hana-yunmusic: 歌词条高度已切到 " + height + "px", JSON.stringify({ sessions: wantShow.size }));
    return { ok: true, height };
  }

  async function getMode() {
    await ensureLoaded();
    return mode;
  }

  async function getFont() {
    await ensureLoaded();
    return font;
  }

  async function getFamily() {
    await ensureLoaded();
    return family;
  }

  async function setFamily(next) {
    await ensureLoaded();
    const value = String(next || "");
    /* hfont: 开头的是 HANA 字体库里用户导入的 —— 列表是动态的，不硬校验名字 */
    if (!STRIP_FAMILIES.some((f) => f.id === value) && !/^hfont:/.test(value)) {
      return { ok: false, error: "字体档不合法：" + value };
    }
    if (value === family) return { ok: true, family };
    family = value;
    await persistPrefs();
    log("info", "hana-yunmusic: 字体已切到 " + value);
    return { ok: true, family };
  }

  async function getPalette() {
    await ensureLoaded();
    return palette;
  }

  /** 切配色。面板页每 2 秒核一次偏好（syncConfig），所以这里不重挂面板。 */
  async function setPalette(next) {
    await ensureLoaded();
    const value = String(next || "");
    if (!STRIP_PALETTES.includes(value)) return { ok: false, error: "配色不合法：" + value };
    if (value === palette) return { ok: true, palette };
    palette = value;
    await persistPrefs();
    log("info", "hana-yunmusic: 歌词配色已切到 " + palette, JSON.stringify({ sessions: wantShow.size }));
    return { ok: true, palette };
  }

  async function setMode(next) {
    await ensureLoaded();
    const value = String(next || "");
    if (!STRIP_MODES.includes(value)) return { ok: false, error: "显示模式不合法：" + value };
    if (value === mode) return { ok: true, mode };
    mode = value;
    // 散雪那档要把面板撑高才看得见雪粒下落，切回其它档再收回用户原来的高度
    syncHeightForMode();
    await persistPrefs();
    await applyHeight();
    // 面板页不在这里重挂：它自己每 2 秒核一次偏好就会跟上（见 ui/assets/lyric-strip.js 的 syncConfig）。
    log("info", "hana-yunmusic: 歌词显示方式已切到 " + mode, JSON.stringify({ sessions: wantShow.size, height }));
    return { ok: true, mode, height };
  }

  async function setFont(next) {
    await ensureLoaded();
    const value = Number(next);
    if (!STRIP_FONTS.includes(value)) return { ok: false, error: "字号不合法：" + next };
    font = value;
    // 高度跟着字号走（用户 2026-10-13 要求）：省得记那张对照表。
    const paired = FONT_HEIGHT[value];
    if (paired) userHeight = paired;
    syncHeightForMode();
    await persistPrefs();
    await applyHeight();
    log("info", `hana-yunmusic: 歌词字号 ${font}px（高度自动 → ${height}px）`, JSON.stringify({ sessions: wantShow.size }));
    return { ok: true, font, height };
  }

  /**
   * 最近活跃的若干个会话（含发起这次操作的那个）。按 modified 倒序取前 RECENT_SESSIONS 个。
   * 当前会话一定要在里面 —— 用户就是在它上面点的钮，名单里把它漏掉说不通。
   * 会话列表拿不到（权限没批 / 宿主报错）时退回「只挂当前这一个」，功能不至于整块失效。
   */
  async function recentTargets(current) {
    const picked = [];
    const seen = new Set();
    const push = (id, path) => {
      const key = String(id || "").trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      picked.push(key);
      if (path && !pathOf.has(key)) pathOf.set(key, path);
    };

    push(current && current.sessionId, current && current.sessionPath);
    try {
      const listed = await sdk.sessions.list({ scope: "all", lifecycle: "active" });
      const sessions = ((listed && listed.sessions) || [])
        .filter((s) => s && s.sessionId)
        .slice()
        .sort((a, b) => new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime());
      for (const s of sessions) {
        if (picked.length >= RECENT_SESSIONS) break;
        push(s.sessionId, s.path);
      }
    } catch (error) {
      log("warn", "hana-yunmusic: 列会话失败，歌词条只挂当前会话", String((error && error.message) || error));
    }
    return picked;
  }

  /** 打开：一次挂到最近活跃的几个会话上（不再只挂当前这一个）。 */
  async function turnOn(ref) {
    const { sessionId, sessionPath } = await resolveRef(ref);
    if (!sessionId) return { ok: false, error: "定位不到会话（需要 app/sessions.read）" };
    if (sessionPath) pathOf.set(sessionId, sessionPath);
    await ensureLoaded();
    syncHeightForMode();

    const targets = await recentTargets({ sessionId, sessionPath });
    const failed = [];
    let mounted = 0;
    for (const id of targets) {
      wantShow.add(id);
      const r = await showPanel(id);
      if (r.ok) mounted += 1;
      else {
        wantShow.delete(id);
        failed.push(`${id}: ${r.error}`);
      }
    }
    if (!mounted) return { ok: false, error: failed[0] || "挂面板失败" };
    log("info", `hana-yunmusic: 歌词条挂上 ${mounted}/${targets.length} 个会话`, JSON.stringify({ targets, failed }));
    return { ok: true, on: true, mode, height, sessionId, sessions: mounted, targets };
  }

  /**
   * 收起：这是「全局一个开关」的东西，所以一次把挂过的会话全摘掉。
   * 只摘当前那个会留下几个半开的面板，用户在别的会话里按收起也收不干净。
   */
  async function turnOff(ref) {
    const targets = Array.from(wantShow);
    wantShow.clear();
    if (targets.length) {
      for (const id of targets) await dismissPanel(id);
      return { ok: true, on: false, sessions: 0 };
    }
    // 内存里没记（App 刚 reload，或用户直接点了面板上那颗宿主的「关闭面板」），
    // 也按点名人摘一次。宿主那边本来就没有会报错，dismissPanel 已按「已摘」处理。
    const { sessionId } = await resolveRef(ref);
    if (!sessionId) return { ok: false, error: "定位不到会话" };
    return dismissPanel(sessionId);
  }

  async function status(ref) {
    const { sessionId } = await resolveRef(ref);
    await ensureLoaded();
    return {
      sessionId,
      on: !!sessionId && wantShow.has(sessionId),
      mode,
      font,
      palette,
      height,
      family,
      sessions: wantShow.size,
      modes: STRIP_MODES,
      palettes: STRIP_PALETTES,
      fonts: STRIP_FONTS,
      heightRange: [PANEL_HEIGHT_MIN, PANEL_HEIGHT_MAX],
    };
  }

  return {
    turnOn,
    turnOff,
    status,
    getMode,
    getFont,
    getFamily,
    getPalette,
    getHeight,
    setMode,
    setFont,
    setFamily,
    setPalette,
    setHeight,
    modes: STRIP_MODES,
    palettes: STRIP_PALETTES,
    fonts: STRIP_FONTS,
    families: STRIP_FAMILIES,
    heightRange: [PANEL_HEIGHT_MIN, PANEL_HEIGHT_MAX],
  };
}
