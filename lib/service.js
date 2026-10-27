/**
 * lib/service.js — App 自带的两个托管外部服务。
 *
 *   1. 取源服务 api-enhanced（127.0.0.1:3300）—— 随 App 载入就起。
 *   2. mpv 桥（127.0.0.1:3310）—— 用到 mpv 后端时才起（懒启动）。
 *
 * 两者都走宿主的托管运行时（profile: "local-machine"）：
 *   sdk.runtime.start({ runtime:"node", entry, profile:"local-machine", network:"external", service:{port, readyMarker, id} })
 *
 * 为什么是 local-machine：Windows 上 scoped 档拿不到读/网隔离（宿主直接拒绝），native 档
 * 要给每个运行时新建本地身份、需要管理员初始化过 helper；local-machine 是「用户已批准的
 * 本地应用」档，无文件系统隔离，正好够用。它需要清单里三个能力：
 * app/runtime.execute + app/runtime.local-machine + app/runtime.network。
 *
 * 一个重要事实（从 HANA 0.1059.0 bundle 里读到的）：托管运行时的子进程 env 是一份白名单，
 * 不带 NODE_OPTIONS，所以 v0.1 那套「NODE_OPTIONS 垫片」在这里完全不需要；反过来，
 * start() 没有 env 字段，服务的端口/绑定地址只能由入口脚本自己写进 process.env。
 */

export const SERVICE_PORT = 3300;
export const SERVICE_ID = "api-enhanced";
export const SERVICE_READY_MARKER = "Server started successfully";
export const SERVICE_ENTRY = "runtime/api-enhanced-boot.cjs";

export const MPV_PORT = 3310;
export const MPV_ID = "mpv-bridge";
export const MPV_READY_MARKER = "MPV_BRIDGE_READY";
export const MPV_ENTRY = "runtime/mpv-bridge.cjs";

export const DL_PORT = 3320;
export const DL_ID = "music-downloader";
export const DL_READY_MARKER = "MUSIC_DL_READY";
export const DL_ENTRY = "runtime/downloader.cjs";

const LIVE_STATES = new Set(["starting", "ready"]);
const BUSY_STATES = new Set(["stopping"]);
const START_THROTTLE_MS = 30 * 1000;

/**
 * 通用托管服务控制器：起、巡检自愈、查状态。
 * port 既是 runtime.start 里声明的端口，也是识别「是不是我这一份」的钥匙。
 */
export function createManagedService({ runtime, logger, name, port, id, entry, readyMarker, lazy = false }) {
  let lastError = "";
  let lastInfo = null;
  let lastAttempt = 0;
  let inFlight = null;

  function log(level, ...args) {
    try {
      if (logger && typeof logger[level] === "function") logger[level](...args);
    } catch {
      /* ignore */
    }
  }

  async function findRuntime() {
    let list = [];
    try {
      list = await runtime.list();
    } catch (error) {
      lastError = "读取运行时列表失败：" + String((error && error.message) || error);
      return null;
    }
    const mine = (Array.isArray(list) ? list : []).filter(
      (r) => r && r.service && Number(r.service.port) === port,
    );
    const live = mine.find((r) => LIVE_STATES.has(r.state));
    if (live) return live;
    return mine.find((r) => BUSY_STATES.has(r.state)) || null;
  }

  async function waitTerminal(runtimeId, budgetMs) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let info = null;
      try {
        info = await runtime.get(runtimeId);
      } catch {
        return;
      }
      if (!info || !BUSY_STATES.has(info.state)) return;
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function ensure() {
    if (!runtime || typeof runtime.start !== "function") {
      lastError = "宿主未提供 sdk.runtime（需要较新的 HANA 与 app/runtime.* 授权）";
      return null;
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const found = await findRuntime();
        if (found && LIVE_STATES.has(found.state)) {
          lastInfo = found;
          return found;
        }
        if (found) await waitTerminal(found.runtimeId, 15000);
        if (Date.now() - lastAttempt < START_THROTTLE_MS) return lastInfo;
        lastAttempt = Date.now();
        const info = await runtime.start({
          runtime: "node",
          entry,
          profile: "local-machine",
          network: "external",
          service: { port, readyMarker, id },
        });
        lastInfo = info;
        lastError = "";
        log("info", `hana-music163: ${name} 已拉起`, JSON.stringify({ runtimeId: info && info.runtimeId, state: info && info.state, port }));
        return info;
      } catch (error) {
        lastError = String((error && error.message) || error);
        log("warn", `hana-music163: ${name} 启动失败`, lastError);
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function watch() {
    const found = await findRuntime();
    if (found && LIVE_STATES.has(found.state)) {
      lastInfo = found;
      return found;
    }
    // 懒启动服务：没被明确要求过就别主动拉（巡检也不拉）
    if (lazy && !lastAttempt) return null;
    return ensure();
  }

  /** 先停掉再起（改配置、桥卡死时用）。 */
  async function restart() {
    const found = await findRuntime();
    if (found) {
      try {
        await runtime.stop(found.runtimeId);
      } catch (error) {
        lastError = "停止失败：" + String((error && error.message) || error);
      }
      await waitTerminal(found.runtimeId, 15000);
    }
    lastAttempt = 0;
    return ensure();
  }

  function startWatchdog(intervalMs = 60 * 1000, { auto = true } = {}) {
    const timer = setInterval(() => {
      if (!auto) return;
      watch().catch(() => null);
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  async function status() {
    const found = (await findRuntime()) || lastInfo;
    return {
      port,
      ready: !!found && found.state === "ready",
      state: (found && found.state) || "none",
      runtimeId: (found && found.runtimeId) || null,
      enforcement: (found && found.enforcement) || null,
      error: lastError,
    };
  }

  return { ensure, watch, restart, startWatchdog, status };
}

/** 取源服务：随 App 载入常驻。 */
export function createSourceService({ runtime, logger }) {
  return createManagedService({
    runtime,
    logger,
    name: "取源服务 api-enhanced",
    port: SERVICE_PORT,
    id: SERVICE_ID,
    entry: SERVICE_ENTRY,
    readyMarker: SERVICE_READY_MARKER,
  });
}

/** mpv 桥：只在使用 mpv 后端时按需拉起，但一旦起来也参与巡检。 */
export function createBridgeService({ runtime, logger }) {
  return createManagedService({
    runtime,
    logger,
    name: "mpv 桥",
    port: MPV_PORT,
    id: MPV_ID,
    entry: MPV_ENTRY,
    readyMarker: MPV_READY_MARKER,
    lazy: true,
  });
}

/** 下载器：懒启动，第一次真要下载时才拉（下载要去写用户选的目录，不在应用自己的沙箱里）。
 *  v0.16.0 起它还兼了「环境自检与引导安装」（/setup/*）：逻辑在 runtime/setup-helper.cjs，
 *  挂这里是为了省一个常驻进程（下载器本来就干本机的活），与 fetch 策略无关。 */
export function createDownloaderService({ runtime, logger }) {
  return createManagedService({
    runtime,
    logger,
    name: "下载器",
    port: DL_PORT,
    id: DL_ID,
    entry: DL_ENTRY,
    readyMarker: DL_READY_MARKER,
    lazy: true,
  });
}
