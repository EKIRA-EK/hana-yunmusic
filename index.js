import { defineApp } from "./sdk/app-contract/server-client.js";

import { DEFAULT_BASE, createApi } from "./lib/api.js";
import { createPlayer } from "./lib/player.js";
import { createCoverCache } from "./lib/cover.js";
import { createSourceService, createBridgeService, createDownloaderService } from "./lib/service.js";
import { createDownloader } from "./lib/download.js";
import { createMpvClient } from "./lib/mpv.js";
import { registerRoutes } from "./lib/routes.js";
import { createLyricStrip } from "./lib/lyric-strip.js";
import { createSetup } from "./lib/setup.js";

export const name = "hana-music163";

const COOKIE_KEY = "netease-cookie";
const STATE_KEY = "player-v2";

export default defineApp(async (sdk) => {
  const storage = sdk.storage.global;

  async function read(key, fallback) {
    try {
      const v = await storage.get(key, fallback);
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  async function write(key, value) {
    try {
      await storage.set(key, value);
    } catch (error) {
      await sdk.logger.warn("hana-music163: 写本地状态失败", String((error && error.message) || error));
    }
  }

  // 取源层：本机 api-enhanced 服务。登录 cookie 持久化在本应用 storage 里。
  const api = createApi(sdk, { baseUrl: DEFAULT_BASE, logger: sdk.logger });
  api.setCookie(String((await read(COOKIE_KEY, "")) || ""));

  // 取源服务：由宿主托管运行时拉起（随 App 起来，不再需要手动 node app.js）。
  // 不 await：启动观察不阻塞 App 载入，失败也只是界面里报取源错误，不会把 App 拖死。
  const source = createSourceService({ runtime: sdk.runtime, logger: sdk.logger });
  const sourceReady = source.ensure().catch(() => null);
  source.startWatchdog();

  // mpv 桥：懒启动（只有切到 mpv 后端才拉）。巡检先挂上，但懒启动服务在接到
  // 明确请求前不会自己起来。
  const mpvBridge = createBridgeService({ runtime: sdk.runtime, logger: sdk.logger });
  mpvBridge.startWatchdog();
  const mpv = createMpvClient(sdk, { logger: sdk.logger });

  // 下载器：懒启动（只有真要下载才拉），跟 mpv 桥同一个套路。
  // 它跑在 local-machine 档，所以能写到用户选的下载目录；任务状态由界面轮 /download/status。
  const downloaderService = createDownloaderService({ runtime: sdk.runtime, logger: sdk.logger });
  downloaderService.startWatchdog();
  const downloader = createDownloader({
    ctx: sdk,
    api,
    service: downloaderService,
    storage: { set: (k, v) => write(k, v) },
    logger: sdk.logger,
  });
  downloader.init(await read("download-v1", null));

  const covers = createCoverCache({ ctx: sdk, dataDir: sdk.dataDir, logger: sdk.logger });

  const session = {
    profile: null,
    async onLogin(cookie) {
      await write(COOKIE_KEY, cookie);
    },
  };

  const player = createPlayer({
    api,
    mpv,
    logger: sdk.logger,
    storage: { set: (k, v) => write(k, v) },
    // 本地曲目播放前先把下载器叫醒（它睡着了就拉不动本地文件）
    ensureLocal: () => downloaderService.ensure(),
  });
  const savedState = await read(STATE_KEY, null);
  await player.init(savedState);
  // 上次退出时停在 mpv 后端，就把桥起回来
  if (savedState && savedState.backend === "mpv") mpvBridge.ensure().catch(() => null);

  // 有 cookie 就顺手读一次账号（此时取源服务可能还没就绪，读空也没关系）
  if (api.getCookie()) {
    try {
      session.profile = await api.account();
    } catch {
      session.profile = null;
    }
  }
  // 服务就绪后补读一次登录态：歌单等接口要用 userId，不能只看启动那一刻的结果
  sourceReady.then(async () => {
    if (!api.getCookie() || session.profile) return;
    try {
      session.profile = await api.account();
    } catch {
      /* 仍失败就算了，页面上的 /account 还会再试一次 */
    }
  });

  // 聊天栏上方的歌词条（app/input.panels）：面板按会话挂在输入框上方，
  // mini 的按钮与 ncm_music 的 action=lyric-strip 都经它开/关。
  const lyricStrip = createLyricStrip({ sdk, logger: sdk.logger });

  // 环境自检与引导安装（v0.16.0）：包里带不了的两个外部依赖（取源服务 / mpv.exe）就看这里。
  // 端点挂在**下载器**那个服务上（/setup/*）——应用进程的 fetch 只到得了已能通的端口，
  // 另开一个新端口会被宿主拦（踩过：ERR_ACCESS_DENIED，详见 runtime/setup-helper.cjs）。
  const setup = createSetup({ logger: sdk.logger, helper: downloaderService, source, api, dataDir: sdk.dataDir, net: sdk.network });

  registerRoutes(sdk, player, api, covers, session, source, mpvBridge, mpv, downloader, lyricStrip, setup);

  await sdk.tools.register({
    name: "ncm_music",
    description:
      "控制 HANA 界面里的网易云音乐播放。action=state 看当前曲目；action=play 用 query 搜索并播放；action=search 只列候选；action=queue 列播放队列；action=level 切换音质（standard/higher/exhigh/lossless/hires）；action=like 红心；action=lyric-strip 在**最近活跃的 5 个会话**的输入框上方开/关歌词条（on=true 开、false 关；mode=shatter 散雪（唱完胀一下再碎成雪粒被风吹散）/ center 居盈（中位固定）/ scroll 行云（横向流动）/ karaoke 尽染（逐字上色）；font 切当前句字号 20/24/30/36；height 调面板高度 32–240；palette 切配色 theme/clay/teal/ink/sage/whale）；action=setup 环境自检（缺什么、怎么补；可带 install/src/mpvPath 直接发起安装）；action=pause/resume/next/prev/stop 播控。画面与侧栏由「HANA云音乐」应用负责，这里只回文本结果。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["state", "play", "search", "queue", "level", "like", "unlike", "lyric-strip", "setup", "pause", "resume", "next", "prev", "stop"],
          description: "要执行的动作。",
        },
        query: { type: "string", description: "action=play 或 search 时的搜索关键词。" },
        level: { type: "string", description: "action=level 时的音质档：standard/higher/exhigh/lossless/hires。" },
        limit: { type: "number", description: "action=search 时的候选数量，默认 10，最大 20。" },
        on: { type: "boolean", description: "action=lyric-strip 时：true 打开输入框上方的歌词条（默认），false 收起。" },
        mode: { type: "string", enum: ["shatter", "center", "scroll", "karaoke"], description: "action=lyric-strip 时：歌词显示方式（也是循环切换的顺序）。shatter=散雪（唱完胀一下再碎成雪粒被风吹散），center=居盈（中位固定），scroll=行云（横向流动），karaoke=尽染（逐字上色）。不传就不改。" },
        font: { type: "number", description: "action=lyric-strip 时：当前句字号（20 / 24 / 30 / 36；会同时把面板高度调到配套值）。不传就不改。" },
        height: { type: "number", description: "action=lyric-strip 时：面板高度（32–240，默认 76）。改它会立即生效，不用重挂面板。" },
        palette: {
          type: "string",
          enum: ["theme", "clay", "teal", "ink", "sage", "whale"],
          description:
            "action=lyric-strip 时：歌词配色。theme=跟随界面主题（默认）；clay=陶土；teal=苔青；ink=藏青；sage=松绿；whale=鲸蓝（#636ae8）。不传就不改。",
        },
        install: {
          type: "string",
          enum: ["copy", "git"],
          description:
            "action=setup 时：真的要装取源服务了。copy=从本机另一份拷（要同时传 src），git=在线装（要这台机器有 git+npm）。不传就只做自检。",
        },
        src: { type: "string", description: "action=setup install=copy 时：那份 api-enhanced 的目录（里面要有 app.js）。" },
        mpvPath: { type: "string", description: "action=setup 时：记下一个 mpv.exe 的路径（写进 mpv.json，影响高保真后端）。" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const a = String((args && args.action) || "").toLowerCase();
      let text = "";
      try {
        if (a === "state") {
          const st = await player.state();
          text = st.song
            ? `正在播放：${st.song.name} - ${st.song.artist}（${st.playing ? "播放中" : "已暂停"}，${st.level}）`
            : "当前没有在播放的曲目。";
        } else if (a === "queue") {
          const q = player.queueView();
          text = q.items.length
            ? q.items.map((i) => `${i.index}. ${i.title} - ${i.artist}${i.current ? "（当前）" : ""}`).join("\n")
            : "播放队列为空。";
        } else if (a === "search") {
          const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
          const items = await api.search(String(args.query || ""), limit);
          text = items.length
            ? items.map((s, i) => `${i + 1}. ${s.name} - ${s.artist}`).join("\n")
            : `「${args.query || ""}」没有结果。`;
        } else if (a === "play") {
          const items = await api.search(String(args.query || ""), 20);
          if (!items.length) {
            text = `「${args.query || ""}」没有可播放的结果。`;
          } else {
            const r = player.startList(items, 0);
            text = r.ok ? `开始播放：${items[0].name} - ${items[0].artist}（候选 ${items.length} 首已入队，可在界面里切换）` : `播放失败：${r.error}`;
          }
        } else if (a === "level") {
          const r = player.setLevel(String(args.level || ""));
          text = r.ok ? `音质已切到 ${r.level}。` : `切换失败：${r.error}`;
        } else if (a === "lyric-strip") {
          if (args.mode !== undefined) {
            const m = await lyricStrip.setMode(String(args.mode));
            if (!m.ok) text = `操作失败：${m.error}`;
          }
          if (!text && args.font !== undefined) {
            const f = await lyricStrip.setFont(Number(args.font));
            if (!f.ok) text = `操作失败：${f.error}`;
          }
          if (!text && args.height !== undefined) {
            const h = await lyricStrip.setHeight(Number(args.height));
            if (!h.ok) text = `操作失败：${h.error}`;
          }
          if (!text && args.palette !== undefined) {
            const p = await lyricStrip.setPalette(String(args.palette));
            if (!p.ok) text = `操作失败：${p.error}`;
          }
          if (!text) {
            // 工具上下文给的是 sessionPath，lyric-strip 模块会换成宿主认的 sessionId。
            const ref = { sessionPath: String((args.context && args.context.sessionPath) || "") };
            const r = args.on === false ? await lyricStrip.turnOff(ref) : await lyricStrip.turnOn(ref);
            text = r.ok ? (r.on ? "歌词条已在输入框上方打开。" : "歌词条已收起。") : `操作失败：${r.error}`;
          }
        } else if (a === "setup") {
          const st = await setup.status();
          const sum = setup.summarize(st);
          const lines = [sum.headline];
          for (const item of sum.items) {
            const mark = item.ok ? "✓" : item.level === "required" ? "✗" : "·";
            lines.push(`${mark} ${item.title}：${item.detail}`);
          }
          if (sum.helperError) lines.push(`（环境助手：${sum.helperError}）`);
          if (st.needs && st.needs.apiEnhanced) {
            lines.push("");
            lines.push(
              st.canInstall && st.canInstall.git
                ? "要装取源服务：跟我说一声（我调 action=setup install=git），或给另一台机器上那份的路径（install=copy src=<目录>）。"
                : "这台机器没有 git/npm，只能从另一台机器拷：把那份 api-enhanced 的目录给我（install=copy src=<目录>）。",
            );
          }
          if (args.install !== undefined) {
            const r = await setup.installApiEnhanced({ mode: String(args.install), srcDir: String(args.src || "") });
            lines.push("");
            lines.push(r && r.ok ? `已开始安装（${r.mode || args.install}）；进度看 GET /setup/progress。` : `发起安装失败：${(r && r.error) || "未知"}`);
          }
          if (args.mpvPath !== undefined) {
            const r = await setup.setMpvPath(String(args.mpvPath));
            lines.push("");
            lines.push(r && r.ok ? `已记下 mpv.exe：${(r.result && r.result.exePath) || args.mpvPath}（下次重开 mpv 生效）。` : `没记上：${(r && r.error) || "未知"}`);
          }
          text = lines.join("\n");
        } else if (a === "like" || a === "unlike") {
          const r = await player.like(a === "like");
          text = r.ok ? (r.liked ? "已红心。" : "已取消红心。") : `操作失败：${r.error}`;
        } else {
          const r = await player.control(a);
          text = r.ok ? `已执行 ${a}。` : `执行失败：${r.error}`;
        }
      } catch (error) {
        text = "操作失败：" + String((error && error.message) || error);
      }
      return { content: [{ type: "text", text }] };
    },
  });

  await sdk.logger.info(
    "hana-music163 v0.4 loaded",
    JSON.stringify({
      base: DEFAULT_BASE,
      loggedIn: !!api.getCookie(),
      queue: player.queue.length,
      managedRuntime: !!(sdk.runtime && typeof sdk.runtime.start === "function"),
    }),
  );
});
