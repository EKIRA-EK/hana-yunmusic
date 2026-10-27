/**
 * lib/cover.js — 封面本地缓存。
 *
 * 卡片方案踩过的坑：网络图片在 iframe 里要么被 CSP 拦、要么要宿主逐张授权。
 * 应用自己有一块可写目录，所以这里把封面拉到本地，再由自己的后端路由发出去
 * （同源，不受 CSP 限制，也不依赖宿主的图片授权）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ALLOWED_HOST = [/(^|\.)music\.126\.net$/i, /(^|\.)126\.net$/i];
/** 下载器发出来的本地封面（http://127.0.0.1:3320/file?p=...）。
 *  它必须同样走 /cover 代理 —— 直连的话浏览器 CSP 不放行（2026-10-22 试错：
 *  绕过代理后列表小图全变裂图标）。但代理里要单独处理：
 *   ① 不能把 http 升成 https（环回地址没证书）；
 *   ② 不走 ctx.network.fetch 那个出站闸门，用普通 fetch 直连本机。 */
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//i;
const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** http 一律提到 https：宿主出站闸门默认只放行 HTTPS。 */
export function normalizeCoverUrl(url) {
  return String(url || "").trim().replace(/^http:\/\//i, "https://");
}

export function coverHostAllowed(url) {
  try {
    const host = new URL(url).hostname;
    return ALLOWED_HOST.some((re) => re.test(host));
  } catch {
    return false;
  }
}

export function createCoverCache({ ctx, dataDir, logger }) {
  const dir = path.join(dataDir, "covers");
  let dirReady = null;

  function ensureDir() {
    if (!dirReady) dirReady = fs.mkdir(dir, { recursive: true }).catch(() => {});
    return dirReady;
  }

  async function readCached(key) {
    for (const [mime, ext] of Object.entries(EXT_BY_MIME)) {
      try {
        const buffer = await fs.readFile(path.join(dir, `${key}.${ext}`));
        if (buffer && buffer.length) return { buffer, contentType: mime };
      } catch {
        /* 未命中 */
      }
    }
    return null;
  }

  async function get(rawUrl) {
    const raw = String(rawUrl || "").trim();
    if (!raw) throw new Error("缺少封面地址");
    const isLocal = LOCAL_URL.test(raw);
    const url = isLocal ? raw : normalizeCoverUrl(raw);
    if (!isLocal && !coverHostAllowed(url)) throw new Error("封面主机不在允许名单内");

    await ensureDir();
    const key = crypto.createHash("sha1").update(url).digest("hex");
    const cached = await readCached(key);
    if (cached) return cached;

    /* 本地图同样走 ctx.network.fetch：宿主只放行它这一道闸门，
       Node 的原生 fetch 在这里会直接“fetch failed”（实测）。区别只在上面不升 https。 */
    const response = await ctx.network.fetch(url, {
      method: "GET",
      timeoutMs: 15000,
      maxResponseBytes: 8 * 1024 * 1024,
    });
    if (!response || !response.ok) throw new Error(`封面拉取失败（HTTP ${response ? response.status : "?"}）`);

    const buffer = Buffer.from(await response.arrayBuffer());
    let contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!EXT_BY_MIME[contentType]) contentType = "image/jpeg";
    try {
      await fs.writeFile(path.join(dir, `${key}.${EXT_BY_MIME[contentType]}`), buffer);
    } catch (error) {
      if (logger) await logger.debug("cover cache write failed", String((error && error.message) || error));
    }
    return { buffer, contentType };
  }

  return { get, dir };
}
