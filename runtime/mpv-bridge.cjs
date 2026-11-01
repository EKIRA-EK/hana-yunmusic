/**
 * runtime/mpv-bridge.cjs — mpv 高保真后端的「中间人」。
 *
 * 为什么要它：mpv 的控制通道是命名管道上的 JSON IPC（`--input-ipc-server`），
 * 而 HANA 的 App 进程够不到管道，页面更够不到。所以拿一个托管运行时（local-machine，
 * 与 api-enhanced 同款）跑这个小 HTTP 服务：
 *
 *    App / 页面  --HTTP-->  本桥(3310)  --JSON IPC(命名管道)-->  mpv.exe
 *
 * 桥自己 spawn mpv，自己轮询属性，对外只暴露几个直白的端点。
 *
 * 环境变量：
 *   MPV_BRIDGE_PORT   默认 3310
 *   MPV_BRIDGE_HOST   默认 127.0.0.1
 *   MPV_EXE           默认按候选找，最后退回 PATH 里的 mpv
 *   MPV_EXCLUSIVE     "0" 关掉 WASAPI 独占
 *   MPV_AUDIO_DEVICE  指定输出设备（如 wasapi/{guid}）；空 = auto
 *   MPV_EXTRA_ARGS    额外参数，空格分隔
 *   MPV_CONFIG        配置文件的路径
 *
 * 配置文件（默认 `<dataDir>/mpv.json`，改完必须在下次 spawn 前生效）：
 *   { "exclusive": false, "audioDevice": "wasapi/{guid}", "volume": 100, "extraArgs": [] }
 *   env 优先于文件，文件优先于内置默认。
 *
 * 端点（全部返回 JSON，成功带 ok:true）：
 *   GET  /status                        桥 + mpv 的当前状态
 *   POST /play    {url, position?, pause?}
 *   POST /pause | /resume | /toggle
 *   POST /seek    {position}
 *   POST /stop                          停止当前曲目（保留 mpv 进程）
 *   POST /volume  {volume | mute?}
 *   GET  /devices                       列出音频设备（mpv --audio-device=help）
 *   GET  /config                        读当前生效配置
 *   POST /config  {exclusive?, audioDevice?, volume?, extraArgs?}
 *                                       写配置文件；有变化就退掉 mpv，下次播放用新参数重起
 *   GET  /log                           最近 200 行 mpv 输出
 *   POST /quit                          退出 mpv（桥还在）
 *
 * 音频设备自愈（v0.4.1 起，v0.5.1 ~ v0.5.2 补齐）：
 *   1. 预检：播放前枚举设备，配置里那台不在了就先摘掉、退到系统默认；
 *   2. 级联：真开不起来时依次退到 系统默认 → 关独占共享播放；
 *   3. 独占喂不上数据（AUDCLNT_E_RESOURCES_INVALIDATED 刷屏）→ 自动关独占重来；
 *   4. 输出中途没了（end-file 报 audio output initialization failed）→ 用 resumePos 当恢复点重走预检+级联；
 *   5. 设备自己报失效（AUDCLNT_E_DEVICE_INVALIDATED，且用户显式指定了设备）→ 直接改走系统默认。
 * 第 5 条只在显式设备的场景生效：自动模式下这条往往只是 mpv 跟着新默认设备重开，属正常。
 *
 * 参考：设备被拔掉/改名时 mpv 的典型输出
 *   [ao/wasapi] Failed to find device '{guid}'
 *   [ao] Failed to initialize audio driver 'wasapi'
 * file_error 收成 "audio output initialization failed"。
 */
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PORT = Number(process.env.MPV_BRIDGE_PORT || "3310");
const HOST = process.env.MPV_BRIDGE_HOST || "127.0.0.1";
const PIPE = process.env.MPV_IPC_PIPE || "\\\\.\\pipe\\hana-yunmusic-mpv";
const EXTRA_ARGS_FROM_ENV = String(process.env.MPV_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);
const READY_MARKER = "MPV_BRIDGE_READY";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 配置 ---------------- */

function configCandidates() {
  return [
    process.env.MPV_CONFIG,
    path.join(process.cwd(), "mpv.json"),
    path.join(__dirname, "..", "..", "..", "app-data", "hana-yunmusic", "mpv.json"),
    /* 旧 id 目录（2026-10-30 改名前的），让设备/独占这些配置不用重设。 */
    path.join(__dirname, "..", "..", "..", "app-data", "hana-music163", "mpv.json"),
  ].filter(Boolean);
}

function resolveConfigPath() {
  for (const candidate of configCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  const first = configCandidates()[0];
  return first || path.join(process.cwd(), "mpv.json");
}

const CONFIG_PATH = resolveConfigPath();

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const fileConfig = readConfigFile();

const config = {
  exclusive:
    process.env.MPV_EXCLUSIVE !== undefined
      ? process.env.MPV_EXCLUSIVE !== "0"
      : fileConfig.exclusive === true,
  audioDevice:
    process.env.MPV_AUDIO_DEVICE !== undefined
      ? String(process.env.MPV_AUDIO_DEVICE)
      : String(fileConfig.audioDevice || ""),
  volume: Number.isFinite(Number(fileConfig.volume)) ? Number(fileConfig.volume) : 100,
  extraArgs: EXTRA_ARGS_FROM_ENV.length
    ? EXTRA_ARGS_FROM_ENV
    : Array.isArray(fileConfig.extraArgs)
      ? fileConfig.extraArgs.map(String)
      : [],
  /* mpv.exe 的位置。引导安装（runtime/setup-helper.cjs）把用户选的路径写到这里，
     所以它得排在 Program Files 那几个候选之前 —— 客户自己选的优先。 */
  exePath:
    process.env.MPV_EXE !== undefined ? String(process.env.MPV_EXE) : String(fileConfig.exePath || ""),
};

function configSignature() {
  return JSON.stringify([config.exclusive, config.audioDevice, config.extraArgs, config.exePath]);
}

/* ---------------- 哪些输出不支持独占 ---------------- */

// 名字只是「种子」：常见的虚拟/DSP 设备（FxSound、Voicemeeter、VB-Audio 等）先默认不支持独占，
// 免得第一次用就白试一次。真正管用的是下面的 noExclusive —— 哪台设备独占失败过就记下来，
// 换台机器重新学；名字没盖住的虚拟设备，踩一次坑之后一样会被挡住。
const VIRTUAL_DEVICE_RE = /fxsound|voicemeeter|vb-audio|virtual audio|virtual cable|虚拟/i;
// 踩过就记住：对某台设备尝试独占失败后写进 mpv.json 的 noExclusive 数组
const noExclusive = new Set(
  (Array.isArray(fileConfig.noExclusive) ? fileConfig.noExclusive : []).map(String),
);

/** 这台设备能不能用独占。名字像虚拟设备的直接否；剩下的看有没有踩过坑。 */
function deviceNoExclusive(id, label) {
  const key = String(id || "");
  if (key && noExclusive.has(key)) return true;
  return VIRTUAL_DEVICE_RE.test(String(label || ""));
}

function markNoExclusive(id) {
  const key = String(id || "");
  if (!key || noExclusive.has(key)) return;
  noExclusive.add(key);
  record("记住：这台输出不支持独占 " + key);
  try {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ...readConfigFile(), ...config, noExclusive: [...noExclusive] }, null, 2),
      "utf8",
    );
  } catch {
    /* 写不了就只影响持久化 */
  }
}

/* ---------------- 状态 ---------------- */

const state = {
  spawned: false,
  exe: "",
  connected: false,
  url: "",
  paused: false,
  idleActive: true,
  eof: false,
  position: 0,
  duration: 0,
  volume: config.volume,
  mute: false,
  lastError: "",
  startedAt: Date.now(),
  // 实际喂给当前这个 mpv 进程的输出参数（可能与 config 不同：回退过）
  effectiveExclusive: config.exclusive,
  effectiveDevice: config.audioDevice,
  // 最近一次自动回退的记录，供 UI 说明「为什么声音没走我选的那台」
  fallback: null,
  // 最近一次 mpv 报的音频输出失败原文（play 的级联用它判断）
  aoFailure: "",
  // 真正在播时记住的位置。mpv 一失败就把 time-pos 归零，只能靠这个当恢复点。
  resumePos: 0,
  // 本次播放真正开声的时刻（用来避开刚起播时的误判）
  playStartedAt: 0,
};

const logLines = [];
function record(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
}

function findMpv() {
  const candidates = [
    config.exePath, // mpv.json 里记的，或 MPV_EXE 环境变量（引导安装写的就是这个）
    "C:\\Program Files\\MPV Player\\mpv.exe",
    "C:\\Program Files (x86)\\MPV Player\\mpv.exe",
    "C:\\Program Files\\mpv\\mpv.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return "mpv"; // 交给 PATH
}

/* ---------------- 音频设备 ---------------- */

function parseDevices(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("'"))
    .map((line) => {
      const match = /^'([^']*)'\s*(?:\((.*)\))?/.exec(line);
      return match ? { id: match[1], label: match[2] || match[1] } : { id: line, label: line };
    });
}

/* 设备表缓存。枚举要起一个 mpv 进程（几百毫秒），所以异步做 + 带 TTL，
 * 不阻塞 /status 这种每秒都可能被问到的请求。 */
let deviceCache = { at: 0, list: [] };
let deviceProbe = null;

function probeDevices() {
  if (deviceProbe) return deviceProbe;
  deviceProbe = new Promise((resolve) => {
    const exe = state.exe || findMpv();
    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      deviceProbe = null;
      deviceCache = { at: Date.now(), list: parseDevices(out) };
      resolve(deviceCache.list);
    };
    try {
      const c = spawn(exe, ["--audio-device=help"], { windowsHide: true });
      c.stdout.on("data", (b) => { out += b.toString("utf8"); });
      c.stderr.on("data", (b) => { out += b.toString("utf8"); });
      c.on("error", finish);
      c.on("exit", finish);
      setTimeout(() => { try { c.kill(); } catch { /* ignore */ } finish(); }, 4000);
    } catch {
      finish();
    }
  });
  return deviceProbe;
}

async function ensureDevices(maxAgeMs = 6000) {
  if (Date.now() - deviceCache.at > maxAgeMs) {
    try { await probeDevices(); } catch { /* ignore */ }
  }
  return deviceCache.list;
}

/** 设定的设备现在还在不在。枚举失败/空表就不拦（交给 mpv 自己报错）。 */
async function deviceExists(id, maxAgeMs = 6000) {
  if (!id || id === "auto") return true;
  const list = await ensureDevices(maxAgeMs);
  if (!list.length) return true;
  return list.some((d) => d.id === id);
}

/** mpv 的音频输出失败长这样，命中就说明这台设备/这套参数打不开。 */
function isAoFailure(text) {
  return /audio output initialization failed|Failed to initialize audio driver|Failed to find device|Could not open\/initialize audio device|AUDCLNT_E_/i.test(
    String(text || ""),
  );
}

function setFallback(patch) {
  state.fallback = Object.assign({ at: Date.now() }, patch);
  record("音频回退：" + JSON.stringify(state.fallback));
}

/* ---------------- mpv 进程 ---------------- */

let child = null;
let socket = null;
let connectTimer = null;
let pollTimer = null;
let requestId = 0;
const pending = new Map();

// 独占输出在虚拟声卡上会「初始化成功、却持续喂不上数据」：
// AUDCLNT_E_* 反复刷、位置在走、耳朵里没声。攒够条数就自动关独占重来。
const aoWatch = { count: 0, lastAt: 0, recovered: false };
let playInFlight = 0;
let recovering = false;

function mpvArgs(exclusive, device) {
  const args = [
    "--idle=yes",
    "--no-video",
    "--osd-level=0",
    "--input-ipc-server=" + PIPE,
    "--msg-level=all=warn",
    "--gapless-audio=yes",
    // 用配置里的音量，不用 state.volume：后者会被 mpv 的实际音量覆盖，
    // 于是「改了配置但下次 spawn 又拿旧值」这种坑就出来了。
    "--volume=" + config.volume,
  ];
  if (exclusive) {
    args.push("--ao=wasapi", "--audio-exclusive=yes");
    if (device) args.push("--audio-device=" + device);
  } else if (device) {
    args.push("--audio-device=" + device);
  }
  return args.concat(config.extraArgs);
}

function handleMpvOutputLine(text) {
  if (!isAoFailure(text)) return;
  state.aoFailure = text;
  aoWatch.count += 1;
  aoWatch.lastAt = Date.now();
  // 「设备已失效」和「独占拿不住设备」是两种病：
  //   前者（DEVICE_INVALIDATED）在共享模式下也会出现，而且往往只吐一两条就静默下去，
  //   靠「攒够条数」根本等不到；但它在自动模式下也可能只是 mpv 跟着新默认设备重开（正常），
  //   所以只在「用户显式指定了设备」时才当成故障，直接走一次「改用系统默认」的恢复。
  if (/AUDCLNT_E_DEVICE_INVALIDATED/i.test(text) && state.effectiveDevice) {
    scheduleOutputRecovery({
      dropDevice: true,
      reason: "音频输出报告设备已失效（AUDCLNT_E_DEVICE_INVALIDATED），已改用系统默认并续播",
    });
  }
}

function spawnMpv(opts = {}) {
  if (child) return;
  const exclusive = opts.exclusive !== undefined ? !!opts.exclusive : state.effectiveExclusive;
  const device = opts.device !== undefined ? String(opts.device || "") : state.effectiveDevice;
  state.effectiveExclusive = exclusive;
  state.effectiveDevice = device;
  state.exe = findMpv();
  const args = mpvArgs(exclusive, device);
  record(`spawn ${state.exe} ${args.join(" ")}`);
  try {
    child = spawn(state.exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    state.lastError = "启动 mpv 失败：" + String((error && error.message) || error);
    record(state.lastError);
    child = null;
    return;
  }
  state.spawned = true;
  const onOut = (tag) => (buf) => {
    const text = buf.toString("utf8").trim();
    record(tag + text);
    handleMpvOutputLine(text);
  };
  child.stdout.on("data", onOut("[mpv] "));
  child.stderr.on("data", onOut("[mpv!] "));
  child.on("error", (error) => {
    state.lastError = String((error && error.message) || error);
    record("mpv 进程错误：" + state.lastError);
  });
  child.on("exit", (code, signal) => {
    record(`mpv 退出 code=${code} signal=${signal}`);
    state.spawned = false;
    state.connected = false;
    state.paused = true;
    state.idleActive = true;
    child = null;
    if (socket) {
      try { socket.destroy(); } catch { /* ignore */ }
      socket = null;
    }
  });
  connectIpc(0);
}

/** 退掉当前 mpv，等它真的退干净（子进程 exit 后 child 会置空）。 */
async function killMpv() {
  if (!child) return;
  record("按需重启 mpv（输出参数变化或回退）");
  if (socket) {
    try { await ipc(["quit"]); } catch { /* ignore */ }
  }
  for (let i = 0; i < 40 && child; i += 1) await sleep(100);
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    for (let i = 0; i < 20 && child; i += 1) await sleep(100);
  }
}

/** 保证 mpv 正跑在指定的输出参数上；不符就重启它。 */
async function ensureMpvFor(opts = {}) {
  const wantExclusive = opts.exclusive !== undefined ? !!opts.exclusive : state.effectiveExclusive;
  const wantDevice = opts.device !== undefined ? String(opts.device || "") : state.effectiveDevice;
  if (child && state.effectiveExclusive === wantExclusive && state.effectiveDevice === wantDevice) return;
  if (child) await killMpv();
  spawnMpv({ exclusive: wantExclusive, device: wantDevice });
}

function connectIpc(attempt) {
  if (socket || !child) return;
  const s = net.connect(PIPE);
  s.setEncoding("utf8");
  s.on("connect", () => {
    socket = s;
    state.connected = true;
    state.lastError = "";
    record("IPC 已连接");
    bindEvents();
    startPolling();
  });
  s.on("data", onIpcData);
  s.on("error", () => {
    try { s.destroy(); } catch { /* ignore */ }
    if (attempt < 40 && child) {
      connectTimer = setTimeout(() => connectIpc(attempt + 1), 250);
    } else {
      state.lastError = "连不上 mpv 的 IPC 管道：" + PIPE;
      record(state.lastError);
    }
  });
  s.on("close", () => {
    if (socket === s) socket = null;
    state.connected = false;
  });
}

let rx = "";
function onIpcData(chunk) {
  rx += chunk;
  let idx;
  while ((idx = rx.indexOf("\n")) >= 0) {
    const line = rx.slice(0, idx).trim();
    rx = rx.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.request_id !== undefined && pending.has(msg.request_id)) {
      const resolve = pending.get(msg.request_id);
      pending.delete(msg.request_id);
      resolve(msg);
      continue;
    }
    onIpcEvent(msg);
  }
}

function onIpcEvent(msg) {
  if (!msg || !msg.event) return;
  if (msg.event === "start-file") {
    state.eof = false;
    state.idleActive = false;
    state.lastError = "";
  } else if (msg.event === "end-file") {
    if (msg.reason === "eof") state.eof = true;
    if (msg.reason === "error" || msg.reason === "unknown") {
      const detail = msg.file_error || msg.reason;
      const ao = isAoFailure(detail);
      if (ao) state.aoFailure = String(detail);
      state.lastError = "mpv 播放失败：" + detail;
      record(state.lastError);
      // 输出设备中途消失 / AO 崩掉时，mpv 会立即 unload 并 idle，
      // 「播放中才查设备表」那条巡检因此根本轮不上——直接按失败事件触发一次带级联的恢复。
      if (ao) scheduleOutputRecovery();
    }
  } else if (msg.event === "idle") {
    state.idleActive = true;
  }
}

function ipc(command) {
  return new Promise((resolve) => {
    if (!socket) {
      resolve({ error: "not-connected" });
      return;
    }
    const id = ++requestId;
    pending.set(id, resolve);
    try {
      socket.write(JSON.stringify({ command, request_id: id }) + "\n");
    } catch (error) {
      pending.delete(id);
      resolve({ error: String((error && error.message) || error) });
      return;
    }
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: "timeout" });
      }
    }, 4000);
  });
}

async function getProp(name) {
  const res = await ipc(["get_property", name]);
  return res && res.error === "success" ? res.data : undefined;
}

function bindEvents() {
  ipc(["observe_property", 1, "pause"]).then((r) => {
    if (r && r.error === "success") record("observe pause ok");
  });
}

let polling = null;

/**
 * 拉一次最新属性到本地状态。
 * 所有「要报给外面」的地方都先 await 它：命令刚下发完就报缓存值，会让前端
 * 看到一个慢半拍的旧态（点播放后图标迟迟不翻转就是这个原因）。
 */
async function refreshProps() {
  if (!socket) return;
  if (polling) return polling;
  polling = (async () => {
    try {
      const [pos, dur, pause, idle, eof, vol] = await Promise.all([
        getProp("time-pos"),
        getProp("duration"),
        getProp("pause"),
        getProp("idle-active"),
        getProp("eof-reached"),
        getProp("volume"),
      ]);
      if (typeof pos === "number") state.position = pos;
      if (typeof dur === "number") state.duration = dur;
      if (typeof pause === "boolean") state.paused = pause;
      if (typeof idle === "boolean") state.idleActive = idle;
      // 确实在播时把位置记下来：mpv 一旦失去输出会把 time-pos 归零，那份进度只能自己留住
      if (idle === false && typeof pos === "number" && pos > 0) state.resumePos = pos;
      if (typeof eof === "boolean" && eof) state.eof = true;
      if (typeof vol === "number") state.volume = vol;
    } catch {
      /* 单个属性拉不到不影响其他 */
    } finally {
      polling = null;
    }
  })();
  return polling;
}

/** 后台低频轮询只当保险丝；对外读取一律走 refreshProps。 */
function startPolling(intervalMs = 1000) {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void refreshProps();
    void maybeRecoverAudio();
    void maybeRecoverDevice();
  }, intervalMs);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
}

/**
 * 播放中盯一眼独占健康度：虚拟声卡上的独占会初始化成功但持续喂不上数据
 * （AUDCLNT_E_* 刷屏、位置在走、耳朵里没声）。6 秒内攒到 5 条就自动关独占重来，
 * 每次播放最多救一次，避免来回折腾。
 */
async function maybeRecoverAudio() {
  if (recovering || playInFlight > 0) return;
  if (state.idleActive || state.paused) return;
  if (!state.effectiveExclusive || aoWatch.recovered) return;
  if (!aoWatch.lastAt || Date.now() - aoWatch.lastAt > 6000) {
    aoWatch.count = 0;
    return;
  }
  if (aoWatch.count < 5) return;
  recovering = true;
  try {
    const url = state.url;
    const pos = state.position;
    if (!url) return;
    aoWatch.recovered = true;
    setFallback({
      fromDevice: state.effectiveDevice || "auto",
      toDevice: "auto",
      droppedExclusive: true,
      reason: "独占输出持续报错（多为虚拟声卡），已改为共享模式重来",
    });
    record("独占输出异常，自动改为共享并重载");
    await ensureMpvFor({ exclusive: false, device: state.effectiveDevice || "" });
    for (let i = 0; i < 60 && !socket; i += 1) await sleep(100);
    if (!socket) return;
    state.aoFailure = "";
    await ipc(["loadfile", url, "replace"]);
    if (pos > 1) await ipc(["seek", pos, "absolute+exact"]);
    await ipc(["set_property", "pause", false]);
    state.paused = false;
    state.idleActive = false;
    await refreshProps();
  } finally {
    recovering = false;
  }
}

/**
 * 播放中盯设备：用户选的那台被拔掉/改名后，WASAPI 的 AO 有时不报错、只是不出声，
 * 所以直接查设备表——没了就自动回退到系统默认并续上原位。
 * 只盯「明确指定了设备」的情形（跟随系统默认时没什么可查的）。
 */
async function maybeRecoverDevice() {
  if (recovering || playInFlight > 0) return;
  if (state.idleActive || state.paused) return;
  if (!state.effectiveDevice) return;
  if (Date.now() - state.playStartedAt < 3000) return;
  let alive = true;
  try {
    alive = await deviceExists(state.effectiveDevice, 8000);
  } catch {
    return;
  }
  if (alive) return;
  recovering = true;
  try {
    const url = state.url;
    const pos = state.position;
    if (!url) return;
    setFallback({
      fromDevice: state.effectiveDevice,
      toDevice: "auto",
      droppedExclusive: false,
      reason: "设定的音频设备在播放中消失（被拔掉），已回退到系统默认并续播",
    });
    record("输出设备消失，自动回退到系统默认并重载");
    await ensureMpvFor({ exclusive: state.effectiveExclusive, device: "" });
    for (let i = 0; i < 60 && !socket; i += 1) await sleep(100);
    if (!socket) return;
    state.aoFailure = "";
    aoWatch.count = 0;
    aoWatch.lastAt = 0;
    aoWatch.recovered = false; // 回退后如果新输出也报错，让音频监测接着救
    await ipc(["loadfile", url, "replace"]);
    if (pos > 1) await ipc(["seek", pos, "absolute+exact"]);
    await ipc(["set_property", "pause", false]);
    state.paused = false;
    state.idleActive = false;
    await refreshProps();
  } finally {
    recovering = false;
  }
}

/*
 * 输出设备中途消失 / AO 崩掉后的自动恢复。
 * mpv 碰到这种失败会立刻卸载并 idle，所以「播放中巡检设备表」那条路刚好错过，
 * 这里改成由 end-file 的失败事件直接触发，并且走 play() 那套预检 + 级联。
 * 同一条 URL 最多救两次，两次之间至少隔 8 秒，避免和上游互相抽风。
 */
let recoveryForUrl = "";
let recoveryCount = 0;
let lastRecoveryAt = 0;
let recoveryTimer = null;
let pendingRecovery = {};

function scheduleOutputRecovery(opts = {}) {
  if (recoveryTimer) {
    // 已经排上了：把更激进的那次（要摘设备的）留下
    if (opts.dropDevice && !pendingRecovery.dropDevice) pendingRecovery = opts;
    return;
  }
  pendingRecovery = opts;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    const run = pendingRecovery;
    pendingRecovery = {};
    void recoverOutput(run);
  }, 600);
  if (typeof recoveryTimer.unref === "function") recoveryTimer.unref();
}

async function recoverOutput(opts = {}) {
  if (recovering) return;
  const url = state.url;
  if (!url) return;
  if (Date.now() - lastRecoveryAt < 8000) return;
  if (recoveryForUrl !== url) {
    recoveryForUrl = url;
    recoveryCount = 0;
  }
  if (recoveryCount >= 2) return;
  lastRecoveryAt = Date.now();
  recoveryCount += 1;
  recovering = true;
  try {
    const pos = state.resumePos || 0;
    const dropDevice = opts.dropDevice === true;
    if (dropDevice) {
      // 设备自己报了失效：不再相信设备表（它可能还把死设备列着），直接改走系统默认
      setFallback({
        fromDevice: state.effectiveDevice || "auto",
        toDevice: "auto",
        droppedExclusive: false,
        reason: opts.reason || "音频输出失效，已改用系统默认并续播",
      });
    }
    record(`音频输出失败，尝试自动恢复（第 ${recoveryCount} 次，从 ${Math.round(pos)}s 续${dropDevice ? "，改用系统默认" : ""}）`);
    const r = await play(
      { url, position: pos, pause: state.paused === true },
      { keepFallback: dropDevice, deviceOverride: dropDevice ? "" : undefined },
    );
    if (r && r.ok) record("音频输出自动恢复成功");
    else {
      state.lastError = "音频输出不可用：" + ((r && r.error) || "未知");
      record("音频输出自动恢复失败：" + ((r && r.error) || "未知"));
    }
  } catch (error) {
    record("音频输出自动恢复异常：" + String((error && error.message) || error));
  } finally {
    recovering = false;
  }
}

/* ---------------- 控制 ---------------- */

/**
 * 播一首，带音频输出自愈。
 * 先按「预检」把不在了的设备摘掉，再试；真打不开就级联降级，直到出声或确实没法。
 */
async function play({ url, position, pause }, options = {}) {
  if (!url) return { ok: false, error: "缺少 url" };
  playInFlight += 1;
  try {

  // 每次播放重新评估回退状态（内部自动恢复时可以要求保留它自己写的那条）
  if (!options.keepFallback) state.fallback = null;
  let desired = {
    exclusive: config.exclusive,
    device: options.deviceOverride !== undefined ? String(options.deviceOverride) : config.audioDevice,
  };
  if (desired.device && !(await deviceExists(desired.device, 0))) {
    setFallback({
      fromDevice: desired.device,
      toDevice: "",
      droppedExclusive: false,
      reason: "设定的音频设备当前不在（拔掉或改名），已回退到系统默认",
    });
    desired = { exclusive: desired.exclusive, device: "" };
  }

  const startAt = Number(position) || 0;

  async function attempt(opts) {
    await ensureMpvFor(opts);
    for (let i = 0; i < 60 && !socket; i += 1) await sleep(100);
    if (!socket) return { ok: false, error: state.lastError || "mpv 还没准备好" };
    state.aoFailure = "";
    aoWatch.count = 0;
    aoWatch.lastAt = 0;
    aoWatch.recovered = false;
    state.url = url;
    state.eof = false;
    state.position = startAt;
    const res = await ipc(["loadfile", url, "replace"]);
    if (!res || res.error !== "success") {
      return { ok: false, error: "loadfile 失败：" + ((res && res.error) || "无响应") };
    }
    if (startAt > 0) await ipc(["seek", startAt, "absolute+exact"]);
    // 给它一点时间：要么真的开声（idle 转 false），要么吐音频初始化错误
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (state.aoFailure) return { ok: false, ao: true, error: state.aoFailure };
      if (!state.idleActive && !state.eof) break;
      await sleep(120);
    }
    if (state.aoFailure) {
      // 独占在这台设备上开不了：记下来，下次不用再试
      if (opts.exclusive && opts.device) markNoExclusive(opts.device);
      return { ok: false, ao: true, error: state.aoFailure };
    }
    return { ok: true };
  }

  let r = await attempt(desired);
  const tried = [desired];
  // 级联 1：设备开不了 → 退到系统默认（保留独占）
  if (r.ok === false && r.ao && desired.device) {
    const next = { exclusive: desired.exclusive, device: "" };
    setFallback({
      fromDevice: desired.device,
      toDevice: "",
      droppedExclusive: false,
      reason: "音频设备打不开，已回退到系统默认",
    });
    r = await attempt(next);
    desired = next;
    tried.push(next);
  }
  // 级联 2：系统默认也开不了（常见于默认设备是虚拟声卡，独占不被支持）→ 关独占
  if (r.ok === false && r.ao && desired.exclusive) {
    const last = { exclusive: false, device: "" };
    setFallback({
      fromDevice: "auto",
      toDevice: "auto",
      droppedExclusive: true,
      reason: "独占方式开不了这台输出（可能是虚拟声卡），已改为共享模式",
    });
    r = await attempt(last);
    desired = last;
    tried.push(last);
  }

  if (r.ok === false) {
    state.lastError = "音频输出起不来：" + (r.error || "未知");
    record(state.lastError);
    return { ok: false, error: r.error || "音频输出起不来", tried };
  }

  if (pause === true) {
    await ipc(["set_property", "pause", true]);
    state.paused = true;
  } else {
    state.paused = false;
  }
  state.idleActive = false;
  state.resumePos = startAt;
  state.playStartedAt = Date.now();
  await refreshProps();
  return { ok: true, tried, fallback: state.fallback, effective: effectiveSnapshot() };
  } finally {
    playInFlight -= 1;
  }
}

async function simple(command, arg) {
  if (!child) spawnMpv();
  for (let i = 0; i < 40 && !socket; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!socket) return { ok: false, error: state.lastError || "mpv 还没准备好" };
  const res = await ipc(arg === undefined ? command : command.concat(arg));
  await refreshProps(); // 命令生效后立刻回真实状态，不让调用方读到旧值
  if (res && res.error === "success") return { ok: true, data: res.data };
  return { ok: false, error: res && res.error !== undefined ? String(res.error) : "IPC 无响应" };
}

/* ---------------- HTTP ---------------- */

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 256 * 1024) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function effectiveSnapshot() {
  return { exclusive: state.effectiveExclusive, device: state.effectiveDevice };
}

function snapshot() {
  // mpv 空闲（没加载文件）时，它自己会保留上一首的 time-pos/duration，
  // 直接报出去会让 UI 给一首没在放的歌配上错的进度与总时长，所以按空闲清零。
  const idle = state.idleActive === true;
  return {
    ok: true,
    spawned: state.spawned,
    connected: state.connected,
    exe: state.exe,
    exePath: config.exePath || "",
    config: { exclusive: config.exclusive, audioDevice: config.audioDevice, volume: config.volume, exePath: config.exePath },
    effective: effectiveSnapshot(),
    fallback: state.fallback,
    configPath: CONFIG_PATH,
    url: state.url,
    paused: state.paused,
    idleActive: state.idleActive,
    eof: state.eof,
    position: idle ? 0 : state.position,
    duration: idle ? 0 : state.duration,
    volume: state.volume,
    mute: state.mute,
    error: state.lastError,
  };
}

const server = http.createServer(async (req, res) => {  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method || "GET").toUpperCase();
  try {
    if (method === "GET" && (route === "/" || route === "/status")) {
      await refreshProps(); // 读的时候现拉，不把缓存当实况
      return send(res, 200, snapshot());
    }
    if (method === "GET" && route === "/log") return send(res, 200, { ok: true, lines: logLines.slice(-200) });

    const body = method === "POST" ? await readBody(req) : {};
    if (method === "POST" && route === "/play") {
      const r = await play(body);
      return send(res, 200, Object.assign({ state: stateSnapshotQuiet() }, r));
    }
    if (method === "POST" && route === "/pause") return send(res, 200, await simple(["set_property", "pause", true]));
    if (method === "POST" && route === "/resume") return send(res, 200, await simple(["set_property", "pause", false]));
    if (method === "POST" && route === "/toggle") return send(res, 200, await simple(["cycle", "pause"]));
    if (method === "POST" && route === "/seek") {
      const pos = Number(body.position) || 0;
      state.position = pos;
      return send(res, 200, await simple(["seek", pos, "absolute+exact"]));
    }
    if (method === "POST" && route === "/stop") {
      state.eof = false;
      // 主动停止就把 url 清掉：自动恢复只应该救「还在放却断了」的曲目，不该把停掉的又拉起来
      state.url = "";
      // 没有 mpv 时别为了「停止」把它启起来（simple() 本来会在无 child 时 spawn）
      if (!child) return send(res, 200, { ok: true, skipped: "no-mpv" });
      return send(res, 200, await simple(["stop"]));
    }
    if (method === "POST" && route === "/volume") {
      const vol = Math.max(0, Math.min(100, Number(body.volume)));
      if (!Number.isFinite(vol)) return send(res, 200, { ok: false, error: "volume 不是数字" });
      state.volume = vol;
      // 音量也是一个「设定」：写回配置，不然下次 spawn mpv 会退回旧值
      config.volume = vol;
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfigFile(), ...config }, null, 2), "utf8");
      } catch { /* 写不了就只影响持久化，不影响这次播放 */ }
      return send(res, 200, await simple(["set_property", "volume", vol]));
    }
    if (method === "POST" && route === "/mute") {
      state.mute = body.mute !== false;
      return send(res, 200, await simple(["set_property", "mute", state.mute]));
    }
    if (method === "POST" && route === "/quit") {
      const r = await simple(["quit"]);
      return send(res, 200, r);
    }
    if (method === "GET" && route === "/devices") {
      const list = await ensureDevices(0);
      return send(res, 200, {
        ok: true,
        devices: list.map((d) => ({ ...d, noExclusive: deviceNoExclusive(d.id, d.label) })),
      });
    }
    if (method === "GET" && route === "/config") {
      return send(res, 200, { ok: true, config: { ...config }, path: CONFIG_PATH, signature: configSignature() });
    }
    if (method === "POST" && route === "/config") {
      const before = configSignature();
      if (body.exclusive !== undefined) config.exclusive = body.exclusive === true;
      if (body.audioDevice !== undefined) config.audioDevice = String(body.audioDevice || "");
      if (body.exePath !== undefined) config.exePath = String(body.exePath || "");
      if (body.volume !== undefined && Number.isFinite(Number(body.volume))) {
        config.volume = Math.max(0, Math.min(100, Number(body.volume)));
        state.volume = config.volume;
      }
      if (Array.isArray(body.extraArgs)) config.extraArgs = body.extraArgs.map(String);
      // 不支持独占的输出：不把它悬着，直接落成 false（界面上那个勾也就会变灰）
      let droppedExclusive = false;
      if (config.exclusive) {
        const list = await ensureDevices(0);
        const dev = list.find((d) => d.id === config.audioDevice);
        if (deviceNoExclusive(config.audioDevice, dev ? dev.label : "")) {
          config.exclusive = false;
          droppedExclusive = true;
          record("这台输出不支持独占，已自动改为共享");
        }
      }
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfigFile(), ...config }, null, 2), "utf8");
      } catch (error) {
        return send(res, 200, { ok: false, error: "写配置失败：" + String((error && error.message) || error) });
      }
      const changed = before !== configSignature();
      if (changed) {
        // 用户重新选了输出：清掉旧的回退记录，并让 mpv 按新参数重启
        state.fallback = null;
        state.effectiveExclusive = config.exclusive;
        state.effectiveDevice = config.audioDevice;
        if (child) await killMpv();
      }
      record(changed ? "配置已改，mpv 需重启" : "配置已写（参数无变化）");
      return send(res, 200, { ok: true, changed, droppedExclusive, config: { ...config } });
    }
    return send(res, 404, { ok: false, error: "未知路由 " + method + " " + route });
  } catch (error) {
    state.lastError = String((error && error.message) || error);
    return send(res, 200, { ok: false, error: state.lastError });
  }
});

function stateSnapshotQuiet() {
  const idle = state.idleActive === true;
  return {
    paused: state.paused,
    position: idle ? 0 : state.position,
    duration: idle ? 0 : state.duration,
    eof: state.eof,
    url: state.url,
  };
}

server.listen(PORT, HOST, () => {
  record(`桥已监听 http://${HOST}:${PORT}（独占=${config.exclusive}，设备=${config.audioDevice || "auto"}，管道=${PIPE}）`);
  console.log(`[mpv-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[mpv-bridge] config=${CONFIG_PATH}`);
  console.log(READY_MARKER);
});

process.on("SIGTERM", () => {
  record("收到 SIGTERM，收尾退出");
  try { if (child) child.kill(); } catch { /* ignore */ }
  process.exit(0);
});
