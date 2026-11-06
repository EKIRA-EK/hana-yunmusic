/**
 * lib/routes.js — 应用自带后端路由（v0.2）。
 * 页面与侧栏面板都打这里：/api/apps/hana-yunmusic/routes/<name>
 * 取源经 lib/api.js 打到本机 api-enhanced 服务；播放状态由 lib/player.js 持有。
 */

async function body(c) {
  try {
    const raw = await c.req.text();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function guard(handler) {
  return async (c) => {
    try {
      const value = await handler(c);
      if (value instanceof Response) return value;
      return c.json(value);
    } catch (error) {
      return c.json({ ok: false, error: String((error && error.message) || error) }, 200);
    }
  };
}

export function registerRoutes(sdk, player, api, covers, session, source, mpvBridge, mpv, downloader, lyricStrip, setup, amll) {
  sdk.routes.register((app) => {
    /* ---------- 播放状态与控制 ---------- */

    app.get("/state", guard(async () => player.state()));

    // 约定：应用自己的路由都带 ok；以前这条（还有 /state）漏了，
    // 面板按 ok 判成败就会报出「读取失败」这种误导性的错。
    app.get("/queue", guard(async () => Object.assign({ ok: true }, player.queueView())));

    // 核一遍队列里哪些歌取不到音源（标灰 + 挪队尾）；带节流，不传 force
    app.post("/queue/verify", guard(async () => player.verifyQueue()));

    app.post(
      "/play",
      guard(async (c) => {
        const payload = await body(c);
        let list = Array.isArray(payload.list) ? payload.list.filter((s) => s && s.id) : [];
        /* 本地曲目的直链（url）不进持久化队列 —— 应用重启后队列里只剩 id，
           mpv 拿不到地址就会静默失败（2026-10-22 改封面时踩到：reload 后点本地歌不响）。
           所以每次起播都拿当前本地列表把本地曲目补一遍。 */
        if (list.some((s) => String(s.id).startsWith("local:"))) {
          try {
            const local = await downloader.listLocal();
            if (local && local.ok && Array.isArray(local.items)) {
              const byId = new Map(local.items.map((s) => [s.id, s]));
              list = list.map((s) =>
                String(s.id).startsWith("local:") && byId.has(s.id) ? Object.assign({}, s, byId.get(s.id)) : s,
              );
            }
          } catch {
            /* 补不上就按原样走，播放器会照常报错 */
          }
        }
        return player.startList(list, payload.index);
      }),
    );

    app.post(
      "/control",
      guard(async (c) => {
        const payload = await body(c);
        return player.control(payload.action, payload);
      }),
    );

    app.post(
      "/progress",
      guard(async (c) => {
        const payload = await body(c);
        return player.progress(payload);
      }),
    );

    app.post(
      "/level",
      guard(async (c) => {
        const payload = await body(c);
        return player.setLevel(String(payload.level || ""));
      }),
    );

    // 音量：整页与侧栏面板共用这一个入口，后端持唯一一份（mpv 模式下它会顺手推给桥）
    app.post(
      "/volume",
      guard(async (c) => {
        const payload = await body(c);
        return player.setVolume(payload.volume);
      }),
    );

    app.post(
      "/backend",
      guard(async (c) => {
        const payload = await body(c);
        const r = player.setBackend(String(payload.backend || ""));
        // 切到 mpv 后端时先把桥拉起来（懒启动），再看望一次播放状态
        if (r.ok && r.backend === "mpv" && mpvBridge) {
          const info = await mpvBridge.ensure();
          r.bridge = await mpvBridge.status();
          r.bridgeStarted = !!info;
          await player.pump();
        }
        return r;
      }),
    );

    /* ---------- mpv 后端 ---------- */

    app.get(
      "/mpv",
      guard(async () => {
        const bridge = mpvBridge ? await mpvBridge.status() : null;
        let live = null;
        let config = null;
        try {
          live = await mpv.status();
        } catch {
          live = null;
        }
        try {
          const cfg = await mpv.getConfig();
          config = (cfg && cfg.config) || null;
        } catch {
          config = null;
        }
        return { ok: true, bridge, mpv: live, config };
      }),
    );

    app.get(
      "/mpv/devices",
      guard(async () => {
        if (mpvBridge) await mpvBridge.ensure();
        return mpv.devices();
      }),
    );

    app.post(
      "/mpv/config",
      guard(async (c) => {
        const payload = await body(c);
        const patch = {};
        if (payload.exclusive !== undefined) patch.exclusive = payload.exclusive === true || payload.exclusive === "true";
        if (payload.audioDevice !== undefined) patch.audioDevice = String(payload.audioDevice || "");
        if (payload.volume !== undefined && Number.isFinite(Number(payload.volume))) patch.volume = Number(payload.volume);
        if (mpvBridge) await mpvBridge.ensure();
        const r = await mpv.setConfig(patch);
        if (r && r.changed) await player.reloadExecutor();
        return { ok: !r || r.ok !== false, changed: !!(r && r.changed), config: (r && r.config) || null, error: r && r.error };
      }),
    );

    app.post(
      "/mpv/volume",
      guard(async (c) => {
        const payload = await body(c);
        const v = Math.max(0, Math.min(100, Number(payload.volume)));
        if (!Number.isFinite(v)) return { ok: false, error: "volume 不是数字" };
        if (mpvBridge) await mpvBridge.ensure();
        const r = await mpv.volume(v);
        return { ok: !r || r.ok !== false, volume: v, error: r && r.error };
      }),
    );

    app.post(
      "/mpv/restart",      guard(async () => {
        if (!mpvBridge) return { ok: false, error: "本版没有托管运行时" };
        const info = await mpvBridge.restart();
        return { ok: !!info, bridge: await mpvBridge.status() };
      }),
    );

    app.post(
      "/like",
      guard(async (c) => {
        const payload = await body(c);
        return player.like(payload.like !== false);
      }),
    );

    // 列表行上的红心：按 id 增/删收藏（与播放中的那首无关）
    app.post(
      "/like/id",
      guard(async (c) => {
        const payload = await body(c);
        const id = String(payload.id || "");
        if (!id) return { ok: false, error: "缺少歌曲 id" };
        const on = payload.on !== false;
        await api.like(id, on);
        player.markLiked(id, on);
        return { ok: true, id, liked: on };
      }),
    );

    app.get(
      "/liked",      guard(async (c) => {
        const ids = String(c.req.query("ids") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!ids.length) return { ok: true, ids: [] };
        return { ok: true, ids: await api.likeCheck(ids.slice(0, 300)) };
      }),
    );

    app.get(
      "/service",
      guard(async () => {
        const ok = await api.ping();
        // 不活着就顺手拉一次（带节流），把 /service 当轻量探活口
        if (!ok && source) source.watch().catch(() => null);
        return { ok, runtime: source ? await source.status() : null };
      }),
    );

    app.post(
      "/service/restart",
      guard(async () => {
        if (!source) return { ok: false, error: "本版没有托管运行时" };
        const info = await source.ensure();
        return { ok: !!info, runtime: await source.status() };
      }),
    );

    /* ---------- 取源 ---------- */

    app.get(
      "/search",
      guard(async (c) => {
        const keyword = c.req.query("keyword") || "";
        // 封顶 100：上游 /cloudsearch 的硬上限就是 100，超过直接回 {"code":400}（实测 101 即拒）。
        const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30));
        if (!keyword.trim()) return { ok: true, items: [] };
        return { ok: true, items: await api.search(keyword, limit) };
      }),
    );

    app.get(
      "/lyric",
      guard(async (c) => {
        const id = c.req.query("id") || "";
        if (!id) return { ok: true, lyric: "", translated: "", yrc: "" };
        const base = await api.lyric(id);
        const out = Object.assign({ ok: true }, base);
        /* 网易云没给逐字时，按需问一次 AMLL（来源、镜像、为何不批量，见 lib/amll.js 文件头）。
           取不到就保持空串，前端自然退回行级 —— 这条支路永不影响播放。 */
        if (amll && !String(out.yrc || "").trim()) {
          try {
            const extra = await amll.getYrc(id);
            if (extra) {
              out.yrc = extra;
              out.yrcSource = "amll";
            }
          } catch {
            /* 静默：没有逐字不是错误 */
          }
        } else if (String(out.yrc || "").trim()) {
          out.yrcSource = "ncm";
        }
        return out;
      }),
    );

    app.get(
      "/daily",
      guard(async () => ({ ok: true, items: await api.daily() })),
    );

    app.get(
      "/playlists",
      guard(async (c) => {
        let uid = c.req.query("uid") || (session.profile && session.profile.userId) || "";
        // 启动时序兜底：服务就绪之前那次 account 会读空，这里自己补一次
        if (!uid && api.getCookie()) {
          try {
            session.profile = await api.account();
            uid = (session.profile && session.profile.userId) || "";
          } catch {
            /* 仍拿不到就按未登录处理 */
          }
        }
        if (!uid) return { ok: false, error: "未登录，无法读取云歌单" };
        return { ok: true, items: await api.userPlaylists(uid, Number(c.req.query("limit")) || 50) };
      }),
    );

    // 一次问清一批歌的「已红心」与「取不到音源」——两个判断都归后端，页面只负责显示。
    // （歌单/搜索的结果里本来不带 liked，也从不判断音源；不给出口的话页面只好自己再查一遍，
    //   那就又是两份真相，跟队列红心踩过的坑一样。）
    app.get(
      "/songs/annotate",
      guard(async (c) => {
        const ids = String(c.req.query("ids") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 300);
        if (!ids.length) return { ok: true, liked: [], unplayable: [] };
        const level = String(c.req.query("level") || "") || player.level || "exhigh";
        const [urls, liked] = await Promise.all([
          api.songUrls(ids, level).catch(() => null),
          api.likeCheck(ids).catch(() => null),
        ]);
        const unplayable = urls
          ? ids.filter((id) => {
              const r = urls[String(id)];
              return !r || !r.url;
            })
          : [];
        return { ok: true, liked: Array.isArray(liked) ? liked.map(String) : [], unplayable };
      }),
    );

    app.get(
      "/playlist-tracks",      guard(async (c) => {
        const id = c.req.query("id") || "";
        if (!id) return { ok: false, error: "缺少云歌单 id" };
        const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 100));
        return { ok: true, items: await api.playlistTracks(id, limit) };
      }),
    );

    // 专辑：?id=<专辑 id> 直接取；?song=<歌曲 id> 先从歌反查专辑
    // （老的持久化队列里只存了专辑名、没存 id，所以点专辑统一走歌曲 id 这条路）
    app.get(
      "/album",
      guard(async (c) => {
        const id = String(c.req.query("id") || "");
        const songId = String(c.req.query("song") || "");
        const albumId = id || (songId ? await api.albumIdOf(songId) : "");
        if (!albumId) return { ok: false, error: "没有专辑 id，也查不到这首歌所属的专辑" };
        const a = await api.album(albumId);
        if (!a.name && !a.songs.length) return { ok: false, error: "这张专辑没读到内容" };
        return Object.assign({ ok: true }, a);
      }),
    );

    app.get(
      "/cover",
      guard(async (c) => {
        const url = c.req.query("u") || "";
        const { buffer, contentType } = await covers.get(url);
        return new Response(buffer, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(buffer.length),
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }),
    );

    /* ---------- 下载到本地 ---------- */
    // 真正的字节由 runtime/downloader.cjs 那个子进程去取（应用进程吃 HTTPS-only
    // 与 8MB 两条限制、也写不到用户选的目录，原因见那个文件的头注释）。

    app.get("/download/status", guard(async () => downloader.status()));

    // 打开下载目录（由下载器子进程叫起资源管理器）
    app.post("/download/open", guard(async () => downloader.openDir()));

    // 弹系统文件夹选择框选下载目录（同样由下载器子进程弹窗）
    app.post("/download/browse", guard(async () => downloader.browseDir()));

    // 暂停 / 继续整单下载（2026-10-23：一按就是一整张歌单，得能中途收住）
    app.post("/download/pause", guard(async (c) => downloader.pauseDownloads((await body(c)).on !== false)));

    // 本地库：扫下载目录（文件与字节都由下载器子进程出手，应用进程读不到那个目录）
    app.get("/local/list", guard(async () => downloader.listLocal()));

    // 本地歌的归档歌词：由后端去取那份 .lrc，别让页面跨端口直连下载器
    app.get("/local/lyric", guard(async (c) => downloader.localLyric(String(c.req.query("id") || ""))));

    app.get(
      "/download/config",
      guard(async () => ({
        ok: true,
        dir: downloader.getDir(),
        level: downloader.getLevel(),
        levels: downloader.levels,
        labels: downloader.labels,
        // 封面选项（2026-10-22）：small 小图 / original 原图 / none 不下载封面
        cover: downloader.getCoverMode(),
        covers: downloader.coverModes,
        // 播放时自动缓存（2026-10-30）：只在登录后能开
        cacheOnPlay: downloader.getCacheOnPlay(),
        cacheLimit: downloader.getCacheLimit(),
        loggedIn: !!(api.getCookie && api.getCookie()),
      })),
    );

    // 目录与下载音质档都在这条上改。两个字段各自可选，只传哪个就动哪个。
    app.post(
      "/download/config",
      guard(async (c) => {
        const payload = await body(c);
        if (payload.dir !== undefined) {
          const r = downloader.setDir(payload.dir);
          if (!r.ok) return r;
        }
        if (payload.level !== undefined) {
          const r = downloader.setLevel(payload.level);
          if (!r.ok) return r;
        }
        if (payload.cover !== undefined) {
          const r = downloader.setCoverMode(payload.cover);
          if (!r.ok) return r;
        }
        if (payload.cacheOnPlay !== undefined) {
          const r = downloader.setCacheOnPlay(payload.cacheOnPlay);
          if (!r.ok) return r;
        }
        if (payload.cacheLimit !== undefined) {
          const r = downloader.setCacheLimit(payload.cacheLimit);
          if (!r.ok) return r;
        }
        return { ok: true, dir: downloader.getDir(), level: downloader.getLevel() };
      }),
    );

    // 单首：{id, name, artist, album, level}
    app.post(
      "/download",
      guard(async (c) => {
        const payload = await body(c);
        return downloader.enqueue(
          { id: payload.id, name: payload.name, artist: payload.artist, album: payload.album },
          { level: payload.level },
        );
      }),
    );

    // 整单：{items:[...], level}
    app.post(
      "/download/list",
      guard(async (c) => {
        const payload = await body(c);
        return downloader.enqueueList(Array.isArray(payload.items) ? payload.items : [], { level: payload.level });
      }),
    );

    /* ---------- 聊天栏上方的歌词条（app/input.panels） ----------
     * 面板按会话挂在输入框上方；mini 的按钮与 Agent 工具都打这里。
     * 位置由宿主定，我们只给会话与尺寸申请。 */

    app.get(
      "/lyric-strip",
      guard(async (c) =>
        Object.assign({ ok: true }, await lyricStrip.status({
          sessionId: c.req.query("sessionId") || "",
          sessionPath: c.req.query("sessionPath") || "",
        })),
      ),
    );

    // body: { sessionId 或 sessionPath, on?, mode? }；on 缺省为 true。
    app.post(
      "/lyric-strip",
      guard(async (c) => {
        const payload = await body(c);
        const ref = { sessionId: payload.sessionId, sessionPath: payload.sessionPath };
        if (payload.mode !== undefined) {
          const set = await lyricStrip.setMode(String(payload.mode));
          if (!set.ok) return set;
        }
        if (payload.on === false) return lyricStrip.turnOff(ref);
        if (payload.on === true) return lyricStrip.turnOn(ref);
        return Object.assign({ ok: true }, await lyricStrip.status(ref));
      }),
    );

    // 显示偏好（全局，不按会话）：mode 居中/滚动；font 当前句字号；height 面板高度；palette 配色
    app.get(
      "/lyric-strip/config",
      guard(async () => {
        /* 自定义字体（2026-10-23）：从 HANA 字体库读用户导入的那批，追加到末尾。
           只多出一组下拉选项；读不到就当没有，不影响其余偏好。 */
        let custom = [];
        try {
          const r = await downloader.listFonts();
          if (!(r && r.ok && Array.isArray(r.fonts))) {
            await sdk.logger.warn("hana-yunmusic: 字体库不可用", JSON.stringify(r));
          }
          if (r && r.ok && Array.isArray(r.fonts)) {
            custom = r.fonts
              .map((f) => ({
                id: "hfont:" + f.id,
                label: f.label,
                css: '"' + f.family + '", ' + f.fallback.join(", "),
                /* 内置（origin=builtin）归到 HANA 组，用户导入的归到“自定义”；
                   两边都带 src，页面才能真的渲染。 */
                group: f.origin === "builtin" ? "hana" : "custom",
                family: f.family,
                src: f.src || "",
                format: f.format || "truetype",
              }));
          }
        } catch (error) {
          /* 字体库读不到不影响别的偏好；但要留下原因，不然界面里只会“字体不见了” */
          try {
            await sdk.logger.warn("hana-yunmusic: 读字体库失败", String((error && error.message) || error));
          } catch {
            /* ignore */
          }
        }
        return {
          ok: true,
          mode: await lyricStrip.getMode(),
          font: await lyricStrip.getFont(),
          family: await lyricStrip.getFamily(),
          palette: await lyricStrip.getPalette(),
          height: await lyricStrip.getHeight(),
          modes: lyricStrip.modes,
          palettes: lyricStrip.palettes,
          fonts: lyricStrip.fonts,
          families: [...lyricStrip.families, ...custom],
          heightRange: lyricStrip.heightRange,
        };
      }),
    );
    app.post(
      "/lyric-strip/config",
      guard(async (c) => {
        const payload = await body(c);
        if (payload.mode !== undefined) {
          const r = await lyricStrip.setMode(String(payload.mode));
          if (!r.ok) return r;
        }
        if (payload.family !== undefined) {
          const r = await lyricStrip.setFamily(String(payload.family));
          if (!r.ok) return r;
        }
        if (payload.font !== undefined) {
          const r = await lyricStrip.setFont(Number(payload.font));
          if (!r.ok) return r;
        }
        if (payload.height !== undefined) {
          const r = await lyricStrip.setHeight(Number(payload.height));
          if (!r.ok) return r;
        }
        if (payload.palette !== undefined) {
          const r = await lyricStrip.setPalette(String(payload.palette));
          if (!r.ok) return r;
        }
        return {
          ok: true,
          mode: await lyricStrip.getMode(),
          font: await lyricStrip.getFont(),
          palette: await lyricStrip.getPalette(),
          height: await lyricStrip.getHeight(),
        };
      }),
    );

    /* ---------- 登录 ---------- */

    app.post(
      "/login/cookie",
      guard(async (c) => {
        const payload = await body(c);
        const value = String(payload.cookie || "").trim();
        if (!value) return { ok: false, error: "缺少 cookie" };
        api.setCookie(value);
        await session.onLogin(value);
        try {
          session.profile = await api.account();
        } catch {
          session.profile = null;
        }
        return { ok: true, loggedIn: !!api.getCookie(), profile: session.profile };
      }),
    );

    app.post(
      "/login/qr",
      guard(async () => {
        const key = await api.qrKey();
        if (!key) return { ok: false, error: "拿不到登录二维码 key" };
        const qrimg = await api.qrCreate(key);
        return { ok: true, key, qrimg };
      }),
    );

    app.get(
      "/login/check",
      guard(async (c) => {
        const key = c.req.query("key") || "";
        if (!key) return { ok: false, error: "缺少 key" };
        const r = await api.qrCheck(key);
        if (r.code === 803) {
          await session.onLogin(api.getCookie());
          try {
            session.profile = await api.account();
          } catch {
            session.profile = null;
          }
        }
        return { ok: true, code: r.code, message: r.message, profile: session.profile };
      }),
    );

    app.post(
      "/logout",
      guard(async () => {
        api.setCookie("");
        await session.onLogin("");
        session.profile = null;
        return { ok: true };
      }),
    );

    app.get("/account", guard(async () => {
      try {
        session.profile = await api.account();
      } catch {
        session.profile = null;
      }
      return { ok: !!session.profile, profile: session.profile };
    }));

    /* ---------- 环境自检与引导安装（v0.16.0） ----------
     * 包里带不了的两个外部依赖（取源服务 api-enhanced / mpv.exe）就看这里。
     * 真正的检查与安装在 runtime/setup-helper.cjs；这一层只转手 + 合并成人类可读的清单。 */

    app.get(
      "/setup/status",
      guard(async () => {
        const st = await setup.status();
        // 自检顺手把自己能救的救一下：取源服务已经铺好却没起来，就把它拉起来。
        // （ensure() 内部有 30 秒节流，所以这里随便调也不会反复起进程。）
        if (st.apiEnhanced && st.apiEnhanced.found && st.apiEnhanced.nodeModules && !(st.service && st.service.ready)) {
          source.ensure().catch(() => null);
        }
        // 附带一份现成的清单（文案只在 lib/setup.js 的 summarize 里写一次）
        return Object.assign({ ok: true }, st, { summary: setup.summarize(st) });
      }),
    );

    app.get(
      "/setup/progress",
      guard(async () => ({ ok: true, job: await setup.progress() })),
    );

    // body: { mode: "copy" | "git", srcDir? }；copy 要给 srcDir（另一台机器上那份 api-enhanced）
    app.post(
      "/setup/api-enhanced",
      guard(async (c) => {
        const payload = await body(c);
        const mode = payload.mode === "git" ? "git" : "copy";
        if (mode === "copy" && !String(payload.srcDir || "").trim()) {
          return { ok: false, error: "copy 模式要给出源目录 srcDir（那份 api-enhanced 在哪）" };
        }
        const r = await setup.installApiEnhanced({ mode, srcDir: payload.srcDir });
        if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "发起失败" };
        return { ok: true, started: true, mode, kind: r.kind || "" };
      }),
    );

    // body: { path }；记下 mpv.exe 的位置，写进 mpv.json，桥下次重起就用它
    app.post(
      "/setup/mpv",
      guard(async (c) => {
        const payload = await body(c);
        const r = await setup.setMpvPath(String(payload.path || ""));
        if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "没记上" };
        const exePath = (r.result && r.result.exePath) || String(payload.path || "");
        // 桥是在自己进程启动时读 mpv.json 的，所以要让新路径真生效得把它重起一次。
        // 只在桥已经在跑时动它（没跑的话下次懒启动自然就读到新值）；重起会断开当前播放，
        // 但“刚指定了 mpv 路径”这个场景本来就意味着它此刻没有能用的 mpv。
        let bridgeRestarted = false;
        try {
          const st = await mpvBridge.status();
          if (st && st.state && st.state !== "none") {
            await mpvBridge.restart();
            bridgeRestarted = true;
          }
        } catch {
          /* 重起失败不影响“记下了”这件事 */
        }
        return { ok: true, exePath, bridgeRestarted };
      }),
    );

    app.post(
      "/setup/cancel",
      guard(async () => setup.cancel()),
    );
  });
}
