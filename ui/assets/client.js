/* HANA云音乐 — 页面共用小工具：后端调用、封面地址、主题跟随、格式化。 */

export const APP_ID = (location.pathname.match(/^\/api\/apps\/([^/]+)\//) || [])[1] || "hana-music163";
export const SESSION = new URLSearchParams(location.search).get("appSurfaceSession") || "";
// 脱离宿主（浏览器直开）时用 URL 里的 token 兜底；真实宿主走上面的 appSurfaceSession，这条不触发。
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const BASE = `/api/apps/${encodeURIComponent(APP_ID)}/routes`;

export async function api(path, init) {
  const headers = new Headers((init && init.headers) || {});
  if (SESSION) headers.set("X-Hana-App-Surface-Session", SESSION);
  if (init && init.body) headers.set("Content-Type", "application/json");
  const method = (init && init.method) || (init && init.body ? "POST" : "GET");
  let url = `${BASE}/${path}`;
  if (!SESSION && TOKEN) url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  const response = await fetch(url, { ...init, method, headers });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json();
}

export function post(path, payload) {
  return api(path, { method: "POST", body: JSON.stringify(payload || {}) });
}

/** 封面地址：**一律走应用自己的 /cover 代理**（同源、可缓存，不受页面 CSP 与宿主的
 *  图片授权限制）。下载器发出来的本地封面也一样 —— 我试过让它直连 127.0.0.1:3320，
 *  结果列表小图全变裂图标（CSP 不放行）。本地图的特殊性改在 lib/cover.js 里处理：
 *  不升 https、不走宿主出站闸门。 */
export function coverSrc(url) {
  if (!url) return "";
  const suffix = SESSION
    ? `&appSurfaceSession=${encodeURIComponent(SESSION)}`
    : TOKEN
      ? `&token=${encodeURIComponent(TOKEN)}`
      : "";
  return `${BASE}/cover?u=${encodeURIComponent(url)}${suffix}`;
}

export function mmss(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

/* ---------- 主题跟随 ---------- */

function applyAppearance(snapshot) {
  if (!snapshot) return;
  const token = String(snapshot.appearance || snapshot.theme || "").toLowerCase();
  if (!token) return;
  const dark = /dark|night|ink|moon|midnight/.test(token);
  document.documentElement.dataset.appearance = dark ? "dark" : "light";
}

let hana = null;

export async function initHana() {
  try {
    const module = await import("./sdk.js");
    hana = module.hana || null;
  } catch (error) {
    console.warn("[HANA云音乐] 宿主 SDK 未加载，界面仍可用", error);
  }
  if (!hana) return null;
  try {
    applyAppearance(hana.theme && hana.theme.getSnapshot && hana.theme.getSnapshot());
    if (hana.theme && hana.theme.subscribe) {
      hana.theme.subscribe((snapshot) => applyAppearance(snapshot));
    }
  } catch (error) {
    console.warn("[HANA云音乐] 主题跟随不可用", error);
  }
  try {
    await hana.ready();
  } catch (error) {
    console.warn("[HANA云音乐] hana.ready 失败", error);
  }
  return hana;
}

/* ---------- 图标 ---------- */

export const ICON = {
  play: '<path d="M7.5 5l11 7-11 7z"/>',
  pause: '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>',
  prev: '<path d="M6 6h2.2v12H6zm12.8 0v12L9.4 12z"/>',
  next: '<path d="M15.8 6H18v12h-2.2zM5.2 6 15 12l-9.8 6z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.4"/>',
  heart: '<path d="M12 20.3 4.9 13.5a4.4 4.4 0 0 1 0-6.3 4.5 4.5 0 0 1 6.3 0l.8.8.8-.8a4.5 4.5 0 0 1 6.3 0 4.4 4.4 0 0 1 0 6.3z"/>',
  heartOutline:
    '<path fill="none" stroke="currentColor" stroke-width="1.8" d="M12 19.2 5.8 13.3a3.7 3.7 0 0 1 0-5.3 3.8 3.8 0 0 1 5.3 0l.9.9.9-.9a3.8 3.8 0 0 1 5.3 0 3.7 3.7 0 0 1 0 5.3z"/>',
  shuffle:
    '<path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  repeat:
    '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
  repeatOne:
    '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/>',
};

export function svg(path, className) {
  return `<svg class="${className || "icon"}" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
}

export function iconButton(attrs, path, className) {
  return `<button ${attrs}>${svg(path, className)}</button>`;
}
