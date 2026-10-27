/**
 * lib/api.js — 取源层：api-enhanced（网易云 Node API 服务）的 HTTP 客户端。
 *
 * 背景：ncm-cli 那条路已退役（daemon 握手超时、自退、起播是概率事件，全是它自己的架构问题）。
 * 现在改成本机一个 api-enhanced 服务 + 这个薄客户端。服务无状态，登录态由本客户端持有。
 *
 * 两条硬约束（都踩过）：
 *  1. cookie 走 **Cookie 请求头**，不要走 query 参数：MUSIC_U 的取值里有 `+` 和 `/`，
 *     经 URL decode 会被破坏（api-enhanced 自己的 util/ncbl.js 里也写了这条）。
 *  2. 宿主出站闸门默认只放行 HTTPS；调本机回环 HTTP 需要在清单声明 allowLocalhost。
 */

export const DEFAULT_BASE = "http://127.0.0.1:3300";

/** 网易云音质档位：数值越高越吃会员。App 里开放 exhigh / lossless / hires 三档。 */
export const LEVELS = ["standard", "higher", "exhigh", "lossless", "hires"];

/** 把接口返回的原始 song 归一化成 App 内部用的扁平结构。 */
export function normalizeSong(raw) {
  if (!raw || typeof raw !== "object") return null;
  const artists = Array.isArray(raw.ar)
    ? raw.ar.map((a) => a && a.name).filter(Boolean).join(" / ")
    : Array.isArray(raw.artists)
      ? raw.artists.map((a) => a && a.name).filter(Boolean).join(" / ")
      : "";
  const album = (raw.al && raw.al.name) || (raw.album && raw.album.name) || "";
  const cover = (raw.al && raw.al.picUrl) || (raw.album && raw.album.picUrl) || "";
  const duration = Number(raw.dt || raw.duration || 0) || 0;
  const fee = Number(raw.fee);
  return {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    artist: artists,
    album,
    coverUrl: cover,
    duration,
    // fee: 0 免费 / 1 会员 / 4 数字专辑 / 8 低音质免费。界面据此标"不可播/需会员"，不再盲目过滤。
    fee: Number.isFinite(fee) ? fee : null,
  };
}

/** api-enhanced 在 803 时把整段 Set-Cookie（含 Max-Age / Expires / Path 等属性）拼成一个
 *  cookie 字符串（还带 `;;`），直接当 Cookie 头发出去网易认不出登录态（实测 profile 变 null）。
 *  这里只保留 name=value 对、按名去重，拼成合法的 Cookie 头。 */
export function sanitizeCookie(raw) {
  const ATTR = /^(max-age|expires|path|domain|secure|httponly|samesite|comment|version)$/i;
  const jar = new Map();
  for (const part of String(raw || "").split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (!name || ATTR.test(name)) continue;
    jar.set(name, value);
  }
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
}

/** 接口的 freeTrialInfo 只在“未登录 / 无权限”时给：{start, end} 秒，表示只能听这一段。
 *  2026-10-15 实测：未登录时每日推荐 30 首里 24 首（全是 fee=1 的 VIP 曲）带这个字段，
 *  end 多为 20 / 30 / 35 / 60——所以“听起来像试听”不是错觉，得把它标出来。 */
function trialOf(d) {
  const t = d && d.freeTrialInfo;
  if (!t || typeof t !== "object") return null;
  const start = Number(t.start) || 0;
  const end = Number(t.end) || 0;
  return end > start ? { start, end, seconds: end - start } : null;
}

export function createApi(ctx, { baseUrl = DEFAULT_BASE, logger } = {}) {
  let cookie = "";
  // 歌曲 id → 专辑 id 的小缓存。旧数据里只存了专辑名，点专辑时要现反查，缓存一下不重复问。
  const albumIdCache = new Map();

  function setCookie(value) {
    cookie = sanitizeCookie(value);
    return cookie;
  }
  function getCookie() {
    return cookie;
  }

  async function call(path, init = {}) {
    const headers = Object.assign({}, init.headers);
    if (cookie) headers.Cookie = cookie;
    const res = await ctx.network.fetch(baseUrl + path, {
      method: init.method || "GET",
      timeoutMs: init.timeoutMs || 20000,
      maxResponseBytes: init.maxResponseBytes || 8 * 1024 * 1024,
      headers,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    }
    return json;
  }

  /** 服务是否活着。用于界面显示"取源服务未启动"。 */
  async function ping() {
    try {
      const res = await ctx.network.fetch(baseUrl + "/", {
        method: "GET",
        timeoutMs: 4000,
        maxResponseBytes: 64 * 1024,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    baseUrl,
    setCookie,
    getCookie,
    ping,

    async search(keyword, limit = 30) {
      // 用 /cloudsearch（新版）：/search 那版返回的 album 只有 picId 没有 picUrl，
      // 而归一化读的是 picUrl，会让搜索结果全缺封面（实测：旧接口 picUrl 根本不存在）。
      const json = await call(`/cloudsearch?keywords=${encodeURIComponent(keyword)}&limit=${limit}&type=1`);
      const songs = (json.result && json.result.songs) || [];
      return songs.map(normalizeSong).filter(Boolean);
    },

    /** 拿可播放 URL。
     *  ⚠ 没登录时**所有档都静默回落成 128k mp3**（实测 br=128018、type=mp3，九档一模一样）。
     *  所以调用方要看 `type`/`br`，别拿请求的档位当真（下载那边靠这两个字段定后缀）。 */
    async songUrl(id, level = "exhigh") {
      const json = await call(`/song/url/v1?id=${encodeURIComponent(id)}&level=${encodeURIComponent(level)}`);
      const d = Array.isArray(json.data) ? json.data[0] : json.data;
      if (!d) return null;
      return { url: d.url || "", br: Number(d.br) || 0, type: d.type || "", size: Number(d.size) || 0, fee: Number(d.fee), trial: trialOf(d) };
    },

    /** 批量拿可播放 URL（网易云允许 id 用逗号串）。返回 { id: { url, br, type, size, fee } }。 */
    async songUrls(ids, level = "exhigh") {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String).slice(0, 500);
      const out = {};
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const json = await call(`/song/url/v1?id=${encodeURIComponent(chunk.join(","))}&level=${encodeURIComponent(level)}`);
        const rows = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
        for (const d of rows) {
          if (!d || d.id === undefined) continue;
          out[String(d.id)] = { url: d.url || "", br: Number(d.br) || 0, type: d.type || "", size: Number(d.size) || 0, fee: Number(d.fee), trial: trialOf(d) };
        }
      }
      return out;
    },

    async songDetail(ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).join(",");
      const json = await call(`/song/detail?ids=${encodeURIComponent(list)}`);
      return (json.songs || []).map(normalizeSong).filter(Boolean);
    },

    /** 专辑：基本信息 + 全部曲目。 */
    async album(id) {
      const json = await call(`/album?id=${encodeURIComponent(id)}`);
      const a = json.album || {};
      return {
        id: String(a.id || id),
        name: String(a.name || ""),
        coverUrl: a.picUrl || "",
        artist: Array.isArray(a.artists) ? a.artists.map((x) => x && x.name).filter(Boolean).join(" / ") : "",
        songs: (json.songs || []).map(normalizeSong).filter(Boolean),
      };
    },

    /** 由一首歌反查它所属的专辑 id。旧数据（比如上次持久化下来的队列）里只有专辑名没有 id，
     *  所以点专辑统一拿歌曲 id 来问，这里做一次反查，顺手缓存。 */
    async albumIdOf(songId) {
      const key = String(songId || "");
      if (!key) return "";
      if (albumIdCache.has(key)) return albumIdCache.get(key);
      const json = await call(`/song/detail?ids=${encodeURIComponent(key)}`);
      const s = (json.songs || [])[0];
      const id = s && s.al && s.al.id ? String(s.al.id) : "";
      if (id) {
        if (albumIdCache.size > 500) albumIdCache.clear();
        albumIdCache.set(key, id);
      }
      return id;
    },

    async lyric(id) {
      // 首选 /lyric/new：它多给一条 yrc（**逐字**时间轴，卡拉OK 逐字上色就用它）。
      //   yrc 形如：[41160,4760](41160,320,0)就(41480,430,0)算…（行开始/时长 + 每个字的开始/时长）
      // 拿不到（或这首没有）就退回 /lyric —— 只有行级时间，面板那边会退回按字数均分的近似。
      let json = null;
      try {
        json = await call(`/lyric/new?id=${encodeURIComponent(id)}`);
      } catch {
        json = null;
      }
      if (!json || (!json.lrc && !json.yrc)) {
        json = await call(`/lyric?id=${encodeURIComponent(id)}`);
      }
      return {
        lyric: (json.lrc && json.lrc.lyric) || "",
        translated: (json.tlyric && json.tlyric.lyric) || "",
        yrc: (json.yrc && json.yrc.lyric) || "",
      };
    },

    async playlistTracks(id, limit = 100) {
      const json = await call(`/playlist/track/all?id=${encodeURIComponent(id)}&limit=${limit}`);
      return (json.songs || []).map(normalizeSong).filter(Boolean);
    },

    async userPlaylists(uid, limit = 50) {
      const json = await call(`/user/playlist?uid=${encodeURIComponent(uid)}&limit=${limit}`);
      return (json.playlist || []).map((p) => ({
        id: String(p.id || ""),
        name: String(p.name || ""),
        count: Number(p.trackCount) || 0,
        coverUrl: p.coverImgUrl || "",
      }));
    },

    async daily() {
      const json = await call(`/recommend/songs`);
      const list = (json.data && json.data.dailySongs) || [];
      return list.map(normalizeSong).filter(Boolean);
    },

    async like(id, on) {
      return call(`/like?id=${encodeURIComponent(id)}&like=${on ? "true" : "false"}`);
    },

    /** 批量查这些歌是不是已红心（网易云要求 ids 是 JSON 数组字串）。返回已红心的 id。 */
    async likeCheck(ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
      if (!list.length) return [];
      const json = await call(`/song/like/check?ids=${encodeURIComponent(JSON.stringify(list))}`);
      return Array.isArray(json.ids) ? json.ids.map(String) : [];
    },

    async account() {
      const json = await call(`/user/account`);
      return json.profile || null;
    },

    async qrKey() {
      const json = await call(`/login/qr/key?timestamp=${Date.now()}`);
      return (json.data && json.data.unikey) || "";
    },
    async qrCreate(key) {
      const json = await call(`/login/qr/create?key=${encodeURIComponent(key)}&qrimg=true&timestamp=${Date.now()}`);
      return (json.data && json.data.qrimg) || "";
    },
    async qrCheck(key) {
      const json = await call(`/login/qr/check?key=${encodeURIComponent(key)}&timestamp=${Date.now()}`);
      if (json.code === 803) setCookie(json.cookie || "");
      return { code: Number(json.code) || 0, message: json.message || "", cookie: json.cookie || "" };
    },
  };
}
