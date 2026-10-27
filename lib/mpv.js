/**
 * lib/mpv.js — mpv 桥（runtime/mpv-bridge.cjs）的 HTTP 客户端。
 *
 * 桥跑在 127.0.0.1:3310，由宿主托管运行时拉起（见 lib/service.js）。
 * 桥自己 spawn mpv、自己走命名管道 IPC；App 这一侧只看见 HTTP。
 */

export const MPV_BASE = "http://127.0.0.1:3310";

export function createMpvClient(ctx, { baseUrl = MPV_BASE, logger } = {}) {
  function log(level, ...args) {
    try {
      if (logger && typeof logger[level] === "function") logger[level](...args);
    } catch {
      /* ignore */
    }
  }

  async function call(path, init = {}) {
    const headers = {};
    let body;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await ctx.network.fetch(baseUrl + path, {
      method: init.method || (body ? "POST" : "GET"),
      timeoutMs: init.timeoutMs || 10000,
      maxResponseBytes: 512 * 1024,
      headers,
      body,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: `mpv 桥返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` };
    }
  }

  /** 桥是否活着（用它自己的 /status）。 */
  async function ping() {
    try {
      const r = await call("/status", { timeoutMs: 3000 });
      return !!r && r.ok === true;
    } catch {
      return false;
    }
  }

  return {
    baseUrl,
    ping,
    status: () => call("/status", { timeoutMs: 4000 }),
    play: (payload) => call("/play", { body: payload, timeoutMs: 20000 }),
    pause: () => call("/pause", { body: {}, timeoutMs: 8000 }),
    resume: () => call("/resume", { body: {}, timeoutMs: 8000 }),
    seek: (position) => call("/seek", { body: { position }, timeoutMs: 8000 }),
    stop: () => call("/stop", { body: {}, timeoutMs: 8000 }),
    volume: (volume) => call("/volume", { body: { volume }, timeoutMs: 8000 }),
    devices: () => call("/devices", { timeoutMs: 10000 }),
    getConfig: () => call("/config", { timeoutMs: 5000 }),
    setConfig: (patch) => call("/config", { body: patch, timeoutMs: 15000 }),
    quit: () => call("/quit", { body: {}, timeoutMs: 8000 }),
    log: () => call("/log", { timeoutMs: 5000 }),
  };
}
