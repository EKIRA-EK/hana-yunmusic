/**
 * runtime/_app-token.cjs — 本机小服务的入口校验（下载器与 mpv 桥共用）。
 *
 * App 侧把令牌写在 `<hanaHome>/app-data/<appId>/runtime-token`，本进程启动时读它。
 * 读不到就拒绝提供服务：宁可这个进程起不来（App 会报服务未就绪），也不要在无凭据的
 * 状态下开放「读任意文件」「启动任意程序」这类端点。
 *
 * 两个服务都在 apps/<appId>/runtime/ 下，往上三级是 .hanako。
 */
const fs = require("node:fs");
const path = require("node:path");

const APP_IDS = ["hana-yunmusic", "hana-music163"]; // 新 id 优先，旧 id 兜底（改名前的用户）

function candidates() {
  const home = path.join(__dirname, "..", "..", "..");
  return APP_IDS.map((id) => path.join(home, "app-data", id, "runtime-token"));
}

function loadToken() {
  for (const p of candidates()) {
    try {
      const raw = String(fs.readFileSync(p, "utf8")).trim();
      if (/^[a-f0-9]{64}$/.test(raw)) return { token: raw, path: p };
    } catch {
      /* 试下一个 */
    }
  }
  return { token: "", path: "" };
}

const loaded = loadToken();

/** 令牌本身；空串表示没读到。 */
const TOKEN = loaded.token;

/** dataDir（能读令牌的那个应用数据目录）。 */
const DATA_DIR = loaded.path ? path.dirname(loaded.path) : "";

/** 允许的来源根：只放行回环页面，其余不给 CORS 头。 */
function originAllowed(origin) {
  const value = String(origin || "").trim();
  if (!value) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(value);
}

/**
 * 从请求里取令牌：先看头，再看查询串（img/audio 带不了头）。
 * 用长度固定比较，避免时序差异带来的信息泄漏。
 */
function tokenFrom(req, url) {
  const header = req.headers["x-hana-app-token"];
  if (header) return String(header).trim();
  if (url) {
    const q = url.searchParams.get("t");
    if (q) return String(q).trim();
  }
  return "";
}

function isAuthorized(req, url) {
  if (!TOKEN) return false;
  const got = tokenFrom(req, url);
  if (!got || got.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

/** 统一的 CORS 头：只在来源是回环时回显，不再用 "*"。 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "content-type,x-hana-app-token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

module.exports = { TOKEN, DATA_DIR, isAuthorized, corsHeaders, tokenFrom, originAllowed };
