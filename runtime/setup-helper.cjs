/**
 * runtime/setup-helper.cjs — 环境自检与引导安装的本地助手（托管运行时，端口 3330）。
 *
 * 为什么要单独一个助手进程：
 *   应用的路由进程在沙箱里（读不到 Program Files、也不能随便 spawn 外部程序），
 *   而「这台机器上有没有 mpv.exe」「能不能 git clone」这类问题必须在**没有隔离**的地方问。
 *   所以跟取源服务 / mpv 桥 / 下载器一样，走 local-machine 档案的托管运行时。
 *
 * 它只做三件事：
 *   1. GET  /status                 报告这台机器的环境（缺什么、在哪、能不能装）
 *   2. POST /install/api-enhanced   把取源服务铺上（从本机拷 / 在线装，二选一）
 *   3. POST /install/mpv            记下一个 mpv.exe 的路径，写进 mpv.json
 *   以及 GET /progress、POST /cancel 看进度 / 中止。
 *
 * 依赖的候选顺序与 runtime/api-enhanced-boot.cjs、runtime/mpv-bridge.cjs **必须保持一致**，
 * 否则会出现「自检说没有、启动却找到了」这种自相矛盾（改一处记得改三处）。
 *
 * 环境变量：
 *   SETUP_HELPER_PORT  默认 3330
 *   SETUP_HELPER_HOST  默认 127.0.0.1
 *   HANA_MUSIC_DATA_DIR  数据目录（默认 cwd，宿主拉起时 cwd 就是 App 的 dataDir）
 *   （旧变量名 HANA_MUSIC163_DATA_DIR / HANA_MUSIC163_API_DIR 仍兼容）
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PORT = Number(process.env.SETUP_HELPER_PORT || "3330");
const HOST = process.env.SETUP_HELPER_HOST || "127.0.0.1";
const READY_MARKER = "SETUP_HELPER_READY";

const DATA_DIR = process.env.HANA_MUSIC_DATA_DIR || process.env.HANA_MUSIC163_DATA_DIR || process.cwd();
const API_DIR = path.join(DATA_DIR, "api-enhanced");

/* mpv.json 的定位顺序：优先用已经存在的那份；都不存在时落到 DATA_DIR 那一份。
 * 为什么 DATA_DIR 要排在 cwd 前面：宿主拉起时 cwd 确实是 App 的 dataDir，两者等价；
 * 但手工起（调试）时 cwd 可能不是，写错地方会静默失败（踩过：写到了工作区根目录）。 */
function resolveMpvConfigPath() {
  const candidates = [
    process.env.MPV_CONFIG,
    path.join(DATA_DIR, "mpv.json"),
    path.join(process.cwd(), "mpv.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return candidates[0] || path.join(DATA_DIR, "mpv.json");
}
const MPV_CONFIG_PATH = resolveMpvConfigPath();
const HANA_HOME = path.resolve(DATA_DIR, "..", "..");
const REPO_URL = "https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git";

/* 与 mpv-bridge.cjs 的 findMpv() 保持同一份候选顺序。 */
const MPV_CANDIDATES = [
  process.env.MPV_EXE,
  "C:\\Program Files\\MPV Player\\mpv.exe",
  "C:\\Program Files (x86)\\MPV Player\\mpv.exe",
  "C:\\Program Files\\mpv\\mpv.exe",
].filter(Boolean);

const API_CANDIDATES = [
  process.env.HANA_MUSIC_API_DIR,
  process.env.HANA_MUSIC163_API_DIR,
  path.join(process.cwd(), "api-enhanced"),
  path.join(HANA_HOME, "app-data", "hana-yunmusic", "api-enhanced"),
  /* 改名（2026-10-30）前的旧目录：已装的那份直接沿用，不必重装。 */
  path.join(HANA_HOME, "app-data", "hana-music163", "api-enhanced"),
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 检测结果的小缓存（目录扫描会走 1.7 万个文件，不值得每秒重扫）。
 * 安装任务结束时会在 endJob 里主动清掉 api 这条 —— 否则“刚装好又报缺”。 */
const cache = { toolchain: { at: 0, value: null }, api: { at: 0, value: null } };

/* ---------------- 小工具 ---------------- */

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJson(p, fallback) {
  try {
    if (!exists(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** 目录里有多少文件 / 多大（带上限，别让 1.7 万个文件把自检拖住）。 */
function scanDir(dir, cap = 30000) {
  const out = { files: 0, bytes: 0, truncated: false };
  if (!exists(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.files >= cap) {
        out.truncated = true;
        return out;
      }
      const full = path.join(cur, entry.name);
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        if (entry.isDirectory()) stack.push(full);
        continue;
      }
      try {
        out.bytes += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      out.files += 1;
    }
  }
  return out;
}

/* ---------------- 任务状态（同一时刻只跑一个） ---------------- */

const job = {
  running: false,
  kind: "",        // api-enhanced-copy / api-enhanced-git / mpv
  stage: "idle",
  startedAt: 0,
  finishedAt: 0,
  detail: "",
  percent: null,   // 0-100，拿不到就 null（前端显示不确定态）
  log: [],
  result: null,
  error: "",
};

let child = null;
let poller = null;

function say(line) {
  job.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  if (job.log.length > 400) job.log.shift();
}

function beginJob(kind, detail) {
  job.running = true;
  job.kind = kind;
  job.stage = "starting";
  job.detail = detail || "";
  job.startedAt = Date.now();
  job.finishedAt = 0;
  job.percent = null;
  job.log = [];
  job.result = null;
  job.error = "";
}

function endJob(ok, error, result) {
  job.running = false;
  job.stage = ok ? "done" : "failed";
  job.finishedAt = Date.now();
  job.error = error || "";
  job.result = result || null;
  /* 装完/失败都要把自检缓存丢掉，否则用户刚装好、再点一次“自检”还是那句“缺”。 */
  cache.api = { at: 0, value: null };
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
  child = null;
}

function snapshotJob() {
  return {
    running: job.running,
    kind: job.kind,
    stage: job.stage,
    detail: job.detail,
    percent: job.percent,
    elapsedMs: job.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : 0,
    log: job.log.slice(-60),
    result: job.result,
    error: job.error,
  };
}

/* ---------------- 检测 ---------------- */

function versionOf(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 6000, shell: false });
    if (r.error) return { ok: false, error: String(r.error.message || r.error) };
    const text = String(r.stdout || r.stderr || "").trim().split(/\r?\n/)[0] || "";
    if (r.status !== 0 && !text) return { ok: false, error: `exit ${r.status}` };
    return { ok: true, version: text };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/**
 * npm 在 Windows 上是 npm.cmd，而 .cmd 不能用 shell:false 直接 spawn（ENOENT），
 * 那会把「这台机器其实有 npm」误判成没有，进而把「在线装」这条路错关掉（踩过）。
 * 所以：先用 where/which 找到它，再经 shell 跑。
 */
function npmVersion() {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const names = process.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"];
  for (const name of names) {
    const probe = spawnSync(finder, [name], { encoding: "utf8", timeout: 6000 });
    const found = String(probe.stdout || "")
      .trim()
      .split(/\r?\n/)[0]
      .trim();
    if (!found) continue;
    try {
      const r = spawnSync(`"${found}" --version`, { encoding: "utf8", timeout: 8000, shell: true });
      const text = String(r.stdout || r.stderr || "").trim().split(/\r?\n/)[0] || "";
      if (text) return { ok: true, version: text, path: found };
    } catch {
      /* 换下一个候选 */
    }
  }
  return { ok: false, error: "PATH 里没有 npm" };
}

function toolchain() {
  if (cache.toolchain.value && Date.now() - cache.toolchain.at < 60000) return cache.toolchain.value;
  const value = {
    node: { ok: true, version: process.version, path: process.execPath },
    /* `git --version` 给的是整句「git version 2.55.0.windows.1」，而清单那行自己会写 "git "，
     * 不去掉前缀就会出现「git git version …」（用户 2026-10-15 截图指出）。
     * 顺带记一下：后面的 .windows.1 是 Git for Windows 自己的构建番号（不是 Windows 版本）。 */
    git: (() => {
      const info = versionOf(process.platform === "win32" ? "git.exe" : "git", ["--version"]);
      if (info && info.ok && typeof info.version === "string") {
        info.version = info.version.replace(/^git\s+version\s+/i, "").trim();
      }
      return info;
    })(),
    npm: npmVersion(),
  };
  cache.toolchain = { at: Date.now(), value };
  return value;
}

function apiEnhancedInfo() {
  if (cache.api.value && Date.now() - cache.api.at < 30000) return cache.api.value;
  const hit = API_CANDIDATES.find((candidate) => exists(path.join(candidate, "app.js"))) || "";
  const dir = hit || API_DIR;
  const scan = hit ? scanDir(hit) : { files: 0, bytes: 0, truncated: false };
  const value = {
    found: !!hit,
    dir,
    candidates: API_CANDIDATES,
    appJs: exists(path.join(dir, "app.js")),
    /* node_modules 是「装了依赖没」的标志；api-enhanced 不带它就跑不起来。 */
    nodeModules: exists(path.join(dir, "node_modules")),
    gitDir: exists(path.join(dir, ".git")),
    files: scan.files,
    sizeMB: Math.round((scan.bytes / 1048576) * 10) / 10,
    truncated: scan.truncated,
  };
  cache.api = { at: Date.now(), value };
  return value;
}

function mpvInfo() {
  const config = readJson(MPV_CONFIG_PATH, {});
  const fromConfig = config && typeof config.exePath === "string" ? config.exePath : "";
  const candidates = [fromConfig, ...MPV_CANDIDATES].filter(Boolean);
  const hit = candidates.find((candidate) => exists(candidate)) || "";
  let onPath = "";
  if (!hit) {
    const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["mpv"], {
      encoding: "utf8",
      timeout: 6000,
    });
    onPath = (String(probe.stdout || "").trim().split(/\r?\n/)[0] || "").trim();
  }
  return {
    found: !!hit || !!onPath,
    path: hit || onPath,
    from: hit ? (hit === fromConfig ? "mpv.json" : "候选目录") : onPath ? "PATH" : "",
    exePathInConfig: fromConfig,
    candidates,
    configPath: MPV_CONFIG_PATH,
  };
}

function statusReport() {
  const api = apiEnhancedInfo();
  return {
    ok: true,
    ready: api.found && api.appJs,
    needs: {
      apiEnhanced: !(api.found && api.appJs),
      mpv: !mpvInfo().found,
    },
    dirs: { dataDir: DATA_DIR, hanaHome: HANA_HOME, apiDir: API_DIR, mpvConfig: MPV_CONFIG_PATH },
    apiEnhanced: api,
    mpv: mpvInfo(),
    toolchain: toolchain(),
    job: snapshotJob(),
    platform: process.platform,
    helperPort: PORT,
  };
}

/* ---------------- 安装：把取源服务铺上 ---------------- */

/** 拷贝进度：数目标目录里有多少文件，跟源比。语言无关，比解析 robocopy 输出稳。 */
function startCopyPoller(srcDir, dstDir) {
  const total = Math.max(1, scanDir(srcDir).files);
  poller = setInterval(() => {
    const got = scanDir(dstDir).files;
    job.percent = Math.min(99, Math.round((got / total) * 100));
    job.detail = `已复制 ${got} / 约 ${total} 个文件`;
  }, 2000);
  if (typeof poller.unref === "function") poller.unref();
}

function runCopy(srcDir) {
  if (!exists(srcDir) || !exists(path.join(srcDir, "app.js"))) {
    endJob(false, `源目录里没有 app.js：${srcDir}`);
    return;
  }
  if (exists(path.join(API_DIR, "app.js"))) {
    endJob(false, `目标位置已经有取源服务了：${API_DIR}（要覆盖就先手动删掉它）`);
    return;
  }
  beginJob("api-enhanced-copy", `从 ${srcDir} 拷到 ${API_DIR}`);
  say("robocopy /E /SL（/SL = 软链接按链接拷，pnpm 的 junction 不会被展开成实体）");
  startCopyPoller(srcDir, API_DIR);
  child = spawn(
    "robocopy",
    [srcDir, API_DIR, "/E", "/SL", "/NFL", "/NDL", "/NP", "/R:1", "/W:1"],
    { windowsHide: true },
  );
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const t = line.trim();
      if (t) say(t);
    }
  });
  child.stderr.on("data", (chunk) => say(String(chunk).trim()));
  child.on("error", (error) => endJob(false, "起 robocopy 失败：" + String(error.message || error)));
  child.on("close", (code) => {
    /* robocopy 退出码：0-7 都是成功（1=有文件被复制），>=8 才是失败 */
    const ok = Number(code) >= 0 && Number(code) < 8;
    if (!ok) {
      endJob(false, `robocopy 退出码 ${code}（>=8 表示有失败项）`);
      return;
    }
    job.percent = 100;
    const scan = scanDir(API_DIR);
    endJob(true, "", { dir: API_DIR, files: scan.files, sizeMB: Math.round((scan.bytes / 1048576) * 10) / 10 });
  });
}

function runGitInstall() {
  if (exists(path.join(API_DIR, "app.js"))) {
    endJob(false, `目标位置已经有取源服务了：${API_DIR}（要覆盖就先手动删掉它）`);
    return;
  }
  beginJob("api-enhanced-git", `在线装：${REPO_URL} + npm install`);
  say(`git clone ${REPO_URL}`);
  const steps = [
    { cmd: "git.exe", args: ["clone", "--depth", "1", REPO_URL, API_DIR], stage: "cloning" },
    { cmd: "npm.cmd", args: ["install", "--no-audit", "--no-fund"], stage: "installing", cwd: API_DIR },
  ];
  let index = 0;
  const next = () => {
    if (index >= steps.length) {
      const scan = scanDir(API_DIR);
      job.percent = 100;
      endJob(true, "", { dir: API_DIR, files: scan.files, sizeMB: Math.round((scan.bytes / 1048576) * 10) / 10 });
      return;
    }
    const step = steps[index];
    index += 1;
    job.stage = step.stage;
    job.percent = null;
    job.detail = step.stage === "cloning" ? "正在下载仓库…" : "正在装依赖（npm install，可能要几分钟）…";
    say(`$ ${step.cmd} ${step.args.join(" ")}`);
    /* npm 在 Windows 上是 .cmd，必须经 shell 起；git.exe 直接起就行。
     * （npm 那一步的参数里没有带空格的路径，所以 shell 拼接不会出问题。） */
    const useShell = /\.cmd$/i.test(step.cmd);
    child = spawn(step.cmd, step.args, { cwd: step.cwd || DATA_DIR, windowsHide: true, shell: useShell });
    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.trim();
        if (t) say(t);
      }
    });
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.trim();
        if (t) say(t);
      }
    });
    child.on("error", (error) => {
      endJob(false, `起 ${step.cmd} 失败：${String(error.message || error)}（这台机器上有 git / npm 吗？看 /status 的 toolchain）`);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        endJob(false, `${step.cmd} 退出码 ${code}（详见日志）`);
        return;
      }
      next();
    });
  };
  next();
}

/* ---------------- 安装：记下 mpv.exe ---------------- */

function setMpvPath(exePath) {
  beginJob("mpv", exePath || "");
  if (!exePath) {
    endJob(false, "没给路径");
    return;
  }
  if (!exists(exePath)) {
    endJob(false, `找不到这个文件：${exePath}`);
    return;
  }
  const base = path.basename(exePath).toLowerCase();
  if (base !== "mpv.exe" && base !== "mpv") {
    endJob(false, `这看起来不是 mpv 可执行文件：${base}（期望 mpv.exe）`);
    return;
  }
  const config = readJson(MPV_CONFIG_PATH, {});
  config.exePath = exePath;
  try {
    fs.mkdirSync(path.dirname(MPV_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(MPV_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch (error) {
    endJob(false, "写 mpv.json 失败：" + String((error && error.message) || error));
    return;
  }
  say(`已写入 ${MPV_CONFIG_PATH}：exePath = ${exePath}`);
  say("下次重开 mpv（切一次后端，或 POST /mpv/restart）就会用它。");
  job.percent = 100;
  endJob(true, "", { exePath, configPath: MPV_CONFIG_PATH });
}

/* ---------------- HTTP ----------------
 *
 * 这个处理函数有两种用法：
 *   1. 单独起进程时（require.main === module）自己监听 SETUP_HELPER_PORT（调试与回归测试用）；
 *   2. 在真机上，它被 **下载器**（runtime/downloader.cjs，3320）挂到 /setup/* 下转发——
 *      因为应用进程的 fetch 被宿主拦了：只有已经能访问的端口才通（踩过：单独开 3330，
 *      从应用里 fetch 回 ERR_ACCESS_DENIED，而 3320 一直好好的）。
 *      所以下载器转交前会把 /setup 前缀剥掉，让这里的 p 仍然是 /status 这种净路径。
 */

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function handleSetupRequest(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/status") {
      send(res, 200, statusReport());
      return;
    }
    if (req.method === "GET" && p === "/progress") {
      send(res, 200, { ok: true, job: snapshotJob() });
      return;
    }
    if (req.method === "POST" && p === "/install/api-enhanced") {
      if (job.running) {
        send(res, 200, { ok: false, error: "已经有一个任务在跑了：" + job.kind });
        return;
      }
      const body = await readBody(req);
      const mode = String(body.mode || "copy");
      /* 交给后台跑，接口立刻回；前端轮询 /progress */
      if (mode === "git") runGitInstall();
      else runCopy(String(body.srcDir || ""));
      send(res, 200, { ok: true, started: true, mode, kind: job.kind });
      return;
    }
    if (req.method === "POST" && p === "/install/mpv") {
      if (job.running) {
        send(res, 200, { ok: false, error: "已经有一个任务在跑了：" + job.kind });
        return;
      }
      const body = await readBody(req);
      setMpvPath(String(body.path || ""));
      send(res, 200, { ok: !job.error, error: job.error, result: job.result, job: snapshotJob() });
      return;
    }
    if (req.method === "GET" && p === "/mpv-config") {
      /* 给应用侧一个“桥要不要重起”的判断依据（桥是在自己进程启动时读 mpv.json 的）。 */
      send(res, 200, { ok: true, configPath: MPV_CONFIG_PATH, exePath: (readJson(MPV_CONFIG_PATH, {}).exePath) || "" });
      return;
    }
    if (req.method === "POST" && p === "/cancel") {
      if (!job.running) {
        send(res, 200, { ok: false, error: "没有在跑的任务" });
        return;
      }
      say("用户中止了任务");
      try {
        if (child) child.kill();
      } catch {
        /* ignore */
      }
      endJob(false, "已中止（目标目录里可能留下半份文件，要用的话先删干净）");
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { ok: false, error: "no such endpoint: " + p });
  } catch (error) {
    send(res, 500, { ok: false, error: String((error && error.message) || error) });
  }
}

module.exports = { handleSetupRequest };

/* 单独跑（调试 / 测试）：自己监听一个端口。 */
if (require.main === module) {
  const server = http.createServer(handleSetupRequest);
  server.listen(PORT, HOST, () => {
    console.log(`[setup-helper] dataDir=${DATA_DIR}`);
    console.log(`[setup-helper] apiEnhanced=${API_DIR}`);
    console.log(READY_MARKER);
  });
}
