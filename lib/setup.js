/**
 * lib/setup.js — 环境自检与引导安装（应用侧的门面）。
 *
 * 真正的检查与安装都在 runtime/setup-helper.cjs（托管运行时，没有文件系统沙箱）：
 * 应用的路由进程读不到 Program Files，也不能 spawn robocopy / git / npm，而这些正是
 * 「这台机器缺什么、能不能装」要问的事。
 *
 * 这一层只做三件：
 *   1. 把助手拉起来（懒启动，用户点开自检才拉）；
 *   2. 调它，并把两边信息（取源服务运行态、登录态）合并成一份**给人看的清单**；
 *   3. 把「一键铺上取源服务」这件事转发过去（拷 / 在线装）。
 *
 * 清单的文案只在这里写一次：UI 与 Agent 工具都读它，免得两处说法不一致。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DL_PORT } from "./service.js";

/** 两个外部依赖（包里带不了），也是这份自检的主角。 */
export const REQUIRED_DEPS = ["api-enhanced", "mpv"];

export function createSetup({ logger, helper, source, api, dataDir, net }) {
  /* 端点在**下载器**那个服务里（它挂 /setup/*，见 runtime/setup-helper.cjs）。
   * ⚠ 必须走 `net`（宿主仲裁的 network.fetch），不能用全局 fetch：
   * 应用进程跑在 Node 权限模型下，裸 fetch 一律 ERR_ACCESS_DENIED（踩过）。 */
  const base = `http://127.0.0.1:${DL_PORT}/setup`;

  function log(level, ...args) {
    try {
      if (logger && typeof logger[level] === "function") logger[level](...args);
    } catch {
      /* ignore */
    }
  }

  async function call(pathname, init) {
    const url = base + pathname;
    let res;
    try {
      res = await net.fetch(url, {
        method: (init && init.method) || "GET",
        headers: init && init.body ? { "Content-Type": "application/json" } : undefined,
        body: init && init.body,
        timeoutMs: 30000,
        maxResponseBytes: 2 * 1024 * 1024,
      });
    } catch (error) {
      const cause = error && error.cause ? error.cause.code || error.cause.message || error.cause : "";
      throw new Error(`fetch ${url} 失败：${String((error && error.message) || error)}${cause ? "（" + String(cause) + "）" : ""}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: `助手返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` };
    }
  }

  /** 取源服务的运行态（助手不管这个，是应用自己的托管服务）。 */
  async function serviceInfo() {
    try {
      const st = await source.status();
      return { ready: !!st.ready, state: st.state || "none", port: st.port, error: st.error || "" };
    } catch (error) {
      return { ready: false, state: "unknown", port: 0, error: String((error && error.message) || error) };
    }
  }

  /**
   * 把助手拉起来并**等它真的能应答**。
   * 踩过：helper.ensure() 只等到进程起来（宿主的 runtime.start 返回），此刻 HTTP 还没
   * 开始监听，紧接着 fetch 就是 “fetch failed”。所以要等托管服务的 state 变成 ready
   * （宿主看到子进程 stdout 里的 READY_MARKER 才会置 ready）。
   */
  async function ensureHelper() {
    try {
      await helper.ensure();
    } catch (error) {
      log("warn", "hana-music163: 环境助手没起来", String((error && error.message) || error));
      return false;
    }
    for (let i = 0; i < 25; i += 1) {
      try {
        const st = await helper.status();
        if (st && st.ready) return true;
      } catch {
        /* 还没起好，继续等 */
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    log("warn", "hana-music163: 环境助手等了 10 秒还没就绪");
    return false;
  }

  /**
   * 一份完整的环境报告。助手起不来时也给一份「能说的部分」，
   * 而不是抛出去 —— 自检本身不该因为自检工具坏了而变瞎。
   */
  async function status() {
    const up = await ensureHelper();
    let report = null;
    let error = "";
    if (up) {
      try {
        report = await call("/status");
        if (!report || report.ok === false) error = (report && report.error) || "助手回了异常内容";
      } catch (err) {
        error = String((err && err.message) || err);
      }
    } else {
      error = "环境助手所在的服务没起来（它是懒启动的：下载器服务）";
    }
    const service = await serviceInfo();
    const loggedIn = (() => {
      try {
        return !!api.getCookie();
      } catch {
        return false;
      }
    })();

    const apiEnhanced =
      (report && report.apiEnhanced) ||
      localApiProbe(dataDir || "") ||
      { found: false, dir: "", appJs: false, nodeModules: false, files: 0, sizeMB: 0 };
    /* 助手起不来时 mpv 真的问不到（Program Files / PATH 都在沙箱外），标成 unknown，
     * 别硬说“没找到”——那是撒谎。 */
    const mpv = (report && report.mpv) || { found: false, path: "", from: "", candidates: [], unknown: true };
    const toolchain = (report && report.toolchain) || { unknown: true, node: { ok: true, version: "" }, git: { ok: false }, npm: { ok: false } };
    const apiReady = !!(apiEnhanced.found && apiEnhanced.appJs && apiEnhanced.nodeModules);

    return {
      ok: true,
      helperOk: !!report,
      helperError: error,
      dirs: (report && report.dirs) || {},
      apiEnhanced,
      mpv,
      toolchain,
      service,
      loggedIn,
      /** 哪些还没到位。apiEnhanced 是硬依赖，其余是「可选但建议」。 */
      needs: {
        apiEnhanced: !apiReady,
        mpv: !mpv.found,
        login: !loggedIn,
      },
      /** 能走哪条安装路：拷要有人给出源目录，在线装要这台机器有 git + npm。 */
      canInstall: {
        copy: true,
        git: !!(toolchain.git && toolchain.git.ok && toolchain.npm && toolchain.npm.ok),
      },
      job: (report && report.job) || null,
    };
  }

  /** 一键铺取源服务。mode: "copy"（要有 srcDir）/ "git"（在线装）。 */
  async function installApiEnhanced({ mode, srcDir }) {
    if (!(await ensureHelper())) return { ok: false, error: "环境助手没起来，装不了" };
    const body = JSON.stringify({ mode: mode === "git" ? "git" : "copy", srcDir: srcDir || "" });
    try {
      const r = await call("/install/api-enhanced", { method: "POST", body });
      log("info", "hana-music163: 取源服务安装已发起", JSON.stringify({ mode, srcDir, ok: r && r.ok }));
      return r;
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  /** 记下一个 mpv.exe 的路径（写进 mpv.json，桥下次重起就用它）。 */
  async function setMpvPath(exePath) {
    if (!(await ensureHelper())) return { ok: false, error: "环境助手没起来，记不了" };
    try {
      return await call("/install/mpv", { method: "POST", body: JSON.stringify({ path: exePath || "" }) });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  async function progress() {
    if (!(await ensureHelper())) return { ok: false, error: "环境助手没起来" };
    try {
      const r = await call("/progress");
      return (r && r.job) || { running: false, stage: "idle" };
    } catch (error) {
      return { running: false, stage: "idle", error: String((error && error.message) || error) };
    }
  }

  async function cancel() {
    if (!(await ensureHelper())) return { ok: false, error: "环境助手没起来" };
    try {
      return await call("/cancel", { method: "POST", body: "{}" });
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  return { status, installApiEnhanced, setMpvPath, progress, cancel, summarize };
}

/**
 * 助手起不来时的兜底：就查自己数据目录里的那一份。
 * 应用进程的文件权限覆盖自己的 dataDir，所以这一条读得到；Program Files / PATH 读不到。
 */
function localApiProbe(dir) {
  if (!dir) return null;
  try {
    const target = join(dir, "api-enhanced");
    const appJs = existsSync(join(target, "app.js"));
    return {
      found: appJs,
      dir: target,
      candidates: [target],
      appJs,
      nodeModules: existsSync(join(target, "node_modules")),
      gitDir: existsSync(join(target, ".git")),
      files: 0,
      sizeMB: 0,
      truncated: false,
      localProbe: true,
    };
  } catch {
    return null;
  }
}

/**
 * 把报告说成人话。**文案只在这里写一次**（UI 与 Agent 工具共用）。
 * 返回 { ok, headline, items: [{ id, level, ok, title, detail, action }] }
 */
export function summarize(st) {
  if (!st || st.ok === false) return { ok: false, headline: "读不到环境信息", items: [] };
  const api = st.apiEnhanced || {};
  const mpv = st.mpv || {};
  const tc = st.toolchain || {};
  const svc = st.service || {};
  const apiReady = !!(api.found && api.appJs && api.nodeModules);
  const sizeText = api.found && api.files ? `${api.files} 个文件 / ${api.sizeMB}MB` : "";

  const items = [
    {
      id: "api-enhanced",
      level: "required",
      ok: apiReady,
      title: "取源服务 api-enhanced",
      detail: apiReady
        ? `已就位（${sizeText}）· ${api.dir}`
        : api.found && api.appJs
          ? `目录在（${api.dir}）但没装依赖：缺 node_modules，起不来`
          : `缺失。包里带不了它（约 130MB、1.7 万个文件），要单独铺到 ${api.dir || "<数据目录>\\api-enhanced"}`,
      action: apiReady ? "" : "install-api-enhanced",
    },
    {
      id: "source-service",
      level: "required",
      ok: !!svc.ready,
      title: "取源服务运行",
      detail: svc.ready ? `已就绪（127.0.0.1:${svc.port}）` : `当前状态：${svc.state}${svc.error ? " · " + svc.error : ""}`,
      action: "",
    },
    {
      id: "mpv",
      level: "optional",
      ok: !!mpv.found,
      title: "mpv.exe（高保真后端）",
      detail: mpv.found
        ? `找到：${mpv.path}（来源：${mpv.from}）`
        : mpv.unknown
          ? "这轮读不到（环境助手没起来）。它是可选后端，先用「界面播放」就行"
          : "没找到。不影响「界面播放」后端；要用 MPV 独占才需要它",
      action: mpv.found || mpv.unknown ? "" : "set-mpv-path",
    },
    {
      id: "login",
      level: "optional",
      ok: !!st.loggedIn,
      title: "网易云登录",
      detail: st.loggedIn ? "已登录" : "未登录 —— 点右上角「登录」扫码",
      action: "",
    },
    {
      id: "toolchain",
      level: "info",
      ok: !!(tc.git && tc.git.ok && tc.npm && tc.npm.ok),
      title: "本机工具链（决定能不能在线装）",
      detail: tc.unknown
        ? "这轮读不到（环境助手没起来）"
        : `node ${tc.node && tc.node.version ? tc.node.version : "?"} · ` +
          `git ${tc.git && tc.git.ok ? tc.git.version : "无"} · ` +
          `npm ${tc.npm && tc.npm.ok ? tc.npm.version : "无"}` +
          (tc.git && tc.git.ok && tc.npm && tc.npm.ok ? "" : " —— 缺 git/npm 就只能「从另一台机器拷」"),
      action: "",
    },
  ];

  const missing = items.filter((i) => i.level === "required" && !i.ok);
  const headline = missing.length
    ? `环境没就绪：${missing.map((i) => i.title).join("、")}`
    : "环境就绪，可以直接用";
  return { ok: true, headline, items, helperOk: !!st.helperOk, helperError: st.helperError || "" };
}
