/**
 * runtime/downloader.cjs — 下载器（本机小服务，127.0.0.1:3320）。
 *
 * 为什么单独起一个进程，而不是应用自己下：
 *   1. 应用进程的出站闸门「默认只放行 HTTPS」，而网易的音频直链常常是 http；
 *   2. 应用侧还有个 maxResponseBytes（8MB）的响应上限，而 FLAC / Hi-Res 一首就是几十兆；
 *   3. 应用进程的文件系统写权限只覆盖它自己的 dataDir，写不到用户选的下载目录。
 * 这个进程跑在 local-machine 档：没有文件系统隔离（能写任意目录），自带独立网络
 * （network: "external"），上面三条都不挡它。
 *
 * 环境变量：
 *   MUSIC_DL_PORT   默认 3320
 *   MUSIC_DL_HOST   默认 127.0.0.1
 *
 * 端点：
 *   GET  /ping               活着
 *   POST /fetch  {url,dest}  排一个下载任务，立刻返回 {ok,id}
 *   GET  /jobs               列出所有任务
 *   GET  /jobs/<id>          单个任务
 *   POST /open   {dir}       在资源管理器里打开那个目录（子进程能给，应用进程给不了）
 *   GET  /list?dir=<dir>     扫那个目录里的音频文件（只扫一层，不下子目录）
 *   GET  /file?p=<path>      把本地文件当 HTTP 发出去（带 Range，能拖进度）
 *                            ——应用进程读不到用户的目录，所以本地播放只能由这里发。
 *
 * 任务状态：queued → running → done | failed
 * 写盘规矩：先写 dest.part，长度核对通过再改名成 dest（绝不留下半截文件）。
 * 任务串行执行：一次只下一个，不把上游捶急。
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
/* 环境自检与引导安装（v0.16.0）：逻辑在 setup-helper.cjs，挂到本服务的 /setup/* 下转交。
 * 为什么不它自己开一个端口：应用进程的 fetch 被宿主拦（单独开 3330 从应用里拿不到，
 * ERR_ACCESS_DENIED），而 3320 一直是通的 —— 详见 setup-helper.cjs 顶部注释。 */
const { handleSetupRequest } = require("./setup-helper.cjs");
/* 入口凭据：只接受 App 本身（带 runtime-token）调用。本服务的端点能读文件、返回任意路径，
   不加这一层等于把本机文件读取能力开放给任何进程。 */
const { TOKEN, DATA_DIR, isAuthorized, corsHeaders } = require("./_app-token.cjs");

const PORT = Number(process.env.MUSIC_DL_PORT || "3320");
const HOST = process.env.MUSIC_DL_HOST || "127.0.0.1";
const READY_MARKER = "MUSIC_DL_READY";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) hana-yunmusic-downloader";
const TIMEOUT_MS = 10 * 60 * 1000; // 单个文件上限 10 分钟
const MAX_ATTEMPTS = 2;
const KEEP_DONE_MS = 30 * 60 * 1000; // 完成的任务留 30 分钟给界面看

/** 本地库认这些后缀。 */
const AUDIO_EXT = new Set([".flac", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".wma", ".ape"]);
const MIME_OF = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".lrc": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".opus": "audio/ogg",
  ".wma": "audio/x-ms-wma",
  ".ape": "audio/x-ape",
};

const jobs = new Map();
let seq = 0;
const queue = [];
let running = false;

function log(...args) {
  try {
    console.log("[downloader]", ...args);
  } catch {
    /* ignore */
  }
}

function view(j) {
  return {
    id: j.id,
    state: j.state,
    bytes: j.bytes,
    total: j.total,
    error: j.error,
    path: j.dest,
  };
}

function prune() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.state === "done" || j.state === "failed") {
      if (j.doneAt && now - j.doneAt > KEEP_DONE_MS) jobs.delete(id);
    }
  }
}

function newJob(url, dest, extras) {
  const id = "dl" + (++seq).toString(36) + Date.now().toString(36).slice(-4);
  /* 2026-10-22：一首歌一个文件夹。extras 带着封面地址 / 歌词正文 / meta，
     音频落位之后再写成 cover.jpg / lyrics.lrc / meta.json（见 writeSidecars）。 */
  const job = {
    id,
    url,
    dest,
    coverUrl: String((extras && extras.coverUrl) || ""),
    lyric: String((extras && extras.lyric) || ""),
    meta: (extras && extras.meta) || null,
    /* 封面与歌词写到哪里（默认跟音频同目录）。2026-10-22 起用户要求单独归档到
       `<dir>\\封面歌词\\<歌名>\\`，音频本身保持平铺。 */
    sidecarDir: String((extras && extras.sidecarDir) || ""),
    state: "queued",
    bytes: 0,
    total: 0,
    error: "",
    at: Date.now(),
    doneAt: 0,
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  return job;
}

/** 把封面 / 歌词 / meta 写进歌曲文件夹（音频已经落位之后才做，哪一个失败都不影响音频）。 */
async function writeSidecars(job) {
  const dir = job.sidecarDir || path.dirname(job.dest);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  if (job.coverUrl) {
    try {
      const res = await fetch(job.coverUrl, {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length) await fsp.writeFile(path.join(dir, "cover.jpg"), buf);
      }
    } catch (error) {
      log("封面失败", job.id, String((error && error.message) || error));
    }
  }
  if (job.lyric) {
    try {
      await fsp.writeFile(path.join(dir, "lyrics.lrc"), job.lyric, "utf8");
    } catch {
      /* ignore */
    }
  }
  if (job.meta) {
    try {
      await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(job.meta, null, 2), "utf8");
    } catch {
      /* ignore */
    }
  }
}

/** 暂停时把待下的任务挪到这里（2026-10-23）。不用全局暂停标：
 *  把 queue 抽空就自然停了，running 那首下完也不会再拉下一首；继续时倒回去再 pump。 */
const parked = [];
/** 目录占用的缓存（2026-10-30）：自动缓存限额靠它，60 秒内不重算。 */
const usageCache = { dir: "", at: 0, value: null };
async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    job.state = "running";
    log("开始", job.id, job.dest);
    await download(job);
    job.state = "done";
    job.doneAt = Date.now();
    log("完成", job.id, job.bytes + " B");
  } catch (error) {
    job.state = "failed";
    job.error = String((error && error.message) || error);
    job.doneAt = Date.now();
    log("失败", job.id, job.error);
  } finally {
    running = false;
    prune();
    pump();
  }
}

async function download(job) {
  const dir = path.dirname(job.dest);
  await fsp.mkdir(dir, { recursive: true });
  const part = job.dest + ".part";
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await fsp.rm(part, { force: true });
      const res = await fetch(job.url, {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);

      const total = Number(res.headers.get("content-length")) || 0;
      job.total = total;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));

      const size = (await fsp.stat(part)).size;
      job.bytes = size;
      if (!size) throw new Error("下到 0 字节");
      if (total && size !== total) throw new Error(`长度不符（期望 ${total}，实得 ${size}）`);

      await fsp.rm(job.dest, { force: true });
      await fsp.rename(part, job.dest);
      await writeSidecars(job); // 封面 / 歌词 / meta（失败不影响音频）
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(part, { force: true }).catch(() => {});
      if (attempt < MAX_ATTEMPTS) log("重试", job.id, String((error && error.message) || error));
    }
  }
  throw lastError || new Error("下载失败");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (chunk) => {
      s += chunk;
      if (s.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

/**
 * `/file` 只允许发送「用户选定的下载目录」里的文件。
 * 根由 App 写进 dl-roots.json（目录一改就重写），这里 1 秒缓存，避免每个 Range 请求都读盘。
 * 用 realpath 比对：能挡住 `..`、符号链接与大小写变体。
 */
let rootsCache = { at: 0, list: [] };
function allowedRoots() {
  const now = Date.now();
  if (now - rootsCache.at < 1000) return rootsCache.list;
  let list = [];
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, "dl-roots.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.roots)) list = parsed.roots.map(String).filter(Boolean);
  } catch {
    list = [];
  }
  /* 字体库：歌词条要用用户导入的字体，文件在 <hanaHome>/font-library。
     它是系统级的只读目录，不属于「写入目录」，但必须能读，否则自定义字体加载失败。 */
  if (DATA_DIR) {
    try {
      const fontDir = path.join(DATA_DIR, "..", "..", "font-library");
      if (fs.statSync(fontDir).isDirectory()) list.push(fontDir);
    } catch {
      /* 没装字体库就忽略 */
    }
  }
  rootsCache = { at: now, list };
  return list;
}
function fileAllowed(target) {
  const roots = allowedRoots();
  if (!roots.length) return false;
  let real;
  try {
    real = fs.realpathSync(target).toLowerCase();
  } catch {
    return false;
  }
  for (const root of roots) {
    let r;
    try {
      r = fs.realpathSync(root).toLowerCase();
    } catch {
      continue;
    }
    if (real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method || "GET").toUpperCase();
  const send = (code, obj) => {
    const s = JSON.stringify(obj);
    /* CORS：歌词存档（.lrc）要从控制台页面 fetch 回来，所以仍需要这个头，
       但只回显回环来源，不再用 "*"（2026-11-04 按市场审查意见收紧）。 */
    res.writeHead(code, Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(s),
    }, corsHeaders(req)));
    res.end(s);
  };

  try {
    /* 预检请求只回 CORS 头，不带内容 */
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    /* 凭据：没有令牌文件时直接拒绝（不降级成“开放”）。 */
    if (!TOKEN) return send(503, { ok: false, error: "服务未就绪：缺少应用令牌" });
    if (!isAuthorized(req, url)) return send(401, { ok: false, error: "unauthorized" });
    /* 环境自检：前缀在这里剥掉，助手那边仍按 /status 这种净路径处理 */
    if (route === "/setup" || route.startsWith("/setup/")) {
      req.url = req.url.replace(/^\/setup/, "") || "/";
      return handleSetupRequest(req, res);
    }
    /* 原生文件夹选择框（2026-10-23，第二版）。
       第一版用的 FolderBrowserDialog 是 XP 时代的树状框，异羽一眼就看出“好老”。
       现在换成 Vista+ 的 IFileDialog（FOS_PICKFOLDERS）——就是资源管理器里弹出那种，
       带侧边栏、可导航、可新建文件夹，跟系统版本长相一致。
       Add-Type 编一段 C# 调 COM；应用进程弹不了 GUI，所以仍由下载器子进程出。 */
    if (route === "/browse" && method === "GET") {
      const initial = String(url.searchParams.get("dir") || "");
      const cs = [
        "using System;",
        "using System.Runtime.InteropServices;",
        "[ComImport, Guid(\"42f85136-db7e-439c-85f1-e4075d135fc8\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
        "public interface IFileDialog {",
        "  [PreserveSig] int Show(IntPtr parent);",
        "  void SetFileTypes(uint c, IntPtr f); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);",
        "  void Advise(IntPtr p, out uint c); void Unadvise(uint c);",
        "  void SetOptions(uint o); void GetOptions(out uint o);",
        "  void SetDefaultFolder(IShellItem i); void SetFolder(IShellItem i); void GetFolder(out IShellItem i);",
        "  void GetCurrentSelection(out IShellItem i);",
        "  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string s); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string s);",
        "  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string s); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string s);",
        "  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string s); void GetResult(out IShellItem i);",
        "  void AddPlace(IShellItem i, int a); void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string s);",
        "  void Close(int hr); void SetClientGuid(ref Guid g); void ClearClientData(); void SetFilter(IntPtr f);",
        "}",
        "[ComImport, Guid(\"43826d1e-e718-42ee-bc55-a1e261c37bfe\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
        "public interface IShellItem {",
        "  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);",
        "  void GetParent(out IShellItem ppsi);",
        "  void GetDisplayName(uint sigdnName, out IntPtr ppszName);",
        "  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);",
        "  void Compare(IShellItem psi, uint hint, out int piOrder);",
        "}",
        "public static class HanaFolderPicker {",
        "  [DllImport(\"shell32.dll\", CharSet = CharSet.Unicode)]",
        "  static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);",
        "  [DllImport(\"kernel32.dll\")] static extern IntPtr SetThreadUILanguage(ushort langid);",
        "  public static string Pick(string title, string initial) {",
        "    SetThreadUILanguage(0x0804); // zh-CN：不设的话对话框自带的 Cancel/Folder: 会走英文资源（PowerShell 进程默认语言）",
        "    var dlg = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(\"DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7\")));",
        "    dlg.SetOptions(0x20 | 0x40);",
        "    dlg.SetTitle(title);",
        "    dlg.SetOkButtonLabel(\"选择文件夹\");",
        "    dlg.SetFileNameLabel(\"文件夹：\");",
        "    if (!string.IsNullOrEmpty(initial)) {",
        "      var iid = new Guid(\"43826d1e-e718-42ee-bc55-a1e261c37bfe\");",
        "      IShellItem item;",
        "      if (SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out item) == 0) dlg.SetFolder(item);",
        "    }",
        "    if (dlg.Show(IntPtr.Zero) != 0) return \"\";",
        "    IShellItem res; dlg.GetResult(out res);",
        "    IntPtr ptr; res.GetDisplayName(0x80058000, out ptr);",
        "    var path = Marshal.PtrToStringUni(ptr); Marshal.FreeCoTaskMem(ptr);",
        "    return path;",
        "  }",
        "}",
      ].join("\n");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        /* 中文路径必经：不显式置输出编码，汉字会以 GBK 吐出来，Node 按 UTF-8 解就是乱码。 */
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -TypeDefinition @\"" + "\n" + cs + "\n\"@",
        "[Console]::Out.Write([HanaFolderPicker]::Pick('选择 HANA云音乐 的下载目录', " + JSON.stringify(initial) + "))",
      ].join("\n");
      /* 用 -EncodedCommand（UTF-16LE base64）传，不走 stdin：
         stdin 的编码由控制台默认页决定，中文标题/路径会在这里丢掉。 */
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      return new Promise((resolve) => {
        const child = spawn("powershell.exe", ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (b) => {
          out += b.toString("utf8");
        });
        child.stderr.on("data", (b) => {
          err += b.toString("utf8");
        });
        child.on("error", (e) => {
          resolve(send(500, { ok: false, error: String((e && e.message) || e) }));
        });
        child.on("close", () => {
          const picked = out.trim();
          if (picked) return resolve(send(200, { ok: true, dir: picked }));
          if (err.trim()) return resolve(send(200, { ok: false, error: err.trim().split(/\r?\n/)[0] }));
          resolve(send(200, { ok: true, dir: "", cancelled: true }));
        });
      });
    }

    /* 暂停 / 继续：整单下载一按就是几十首，得能中途收住。
       正在下的那一首不强行中断（几 MB，一两秒就完），比中途砍断留半截文件安全。 */
    if (route === "/pause" && method === "POST") {
      const moved = queue.splice(0, queue.length);
      for (const job of moved) parked.push(job);
      return send(200, { ok: true, paused: true, parked: parked.length, running: running ? 1 : 0 });
    }
    if (route === "/resume" && method === "POST") {
      const back = parked.splice(0, parked.length);
      for (const job of back) queue.push(job);
      pump();
      return send(200, { ok: true, resumed: back.length });
    }
    /* 按 id 撤掉**还没开始**的任务（2026-10-30）：关掉「播放时自动缓存」时要能把排队中那一批抽掉。
       正在下的那首不动 —— 中途砍断会留半截文件，而且几 MB 一两秒就完。 */
    if (route === "/drop" && method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const ids = new Set((payload.ids || []).map(String));
      if (!ids.size) return send(400, { ok: false, error: "缺少 ids" });
      let dropped = 0;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (ids.has(String(queue[i].id))) {
          queue.splice(i, 1);
          dropped += 1;
        }
      }
      for (let i = parked.length - 1; i >= 0; i -= 1) {
        if (ids.has(String(parked[i].id))) {
          parked.splice(i, 1);
          dropped += 1;
        }
      }
      const stillRunning = running && ids.has(String(running.id)) ? 1 : 0;
      return send(200, { ok: true, dropped, running: stillRunning });
    }

    /* HANA 字体库索引（2026-10-23）：读 ~/.hanako/font-library/registry.json，
       把用户导入的字体报给界面（origin=user 的那批）。
       只报名字与 family，不碰字体文件本体 —— 应用包不会因此变大。 */
    if (route === "/fonts" && method === "GET") {
      /* 不能用 process.env.USERPROFILE / os.homedir()：下载器是应用的子进程，
         宿主把 HOME、USERPROFILE 全改写到了 app-data\<app>\.runtime-tmp，
         算出来的永远是沙箱路径（2026-10-23 实测）。改成**逐层往上找**：
         从 cwd 往上，第一个带着 .hanako\font-library\registry.json 的祖先就是它。 */
      const findHome = () => {
        let at = process.cwd();
        for (let i = 0; i < 8; i += 1) {
          if (path.basename(at) === ".hanako") return at;
          const cand = path.join(at, ".hanako");
          if (fs.existsSync(path.join(cand, "font-library", "registry.json"))) return cand;
          const up = path.dirname(at);
          if (up === at) break;
          at = up;
        }
        return path.join(os.homedir(), ".hanako");
      };
      const home = process.env.HANA_HOME || findHome();
      const reg = path.join(home, "font-library", "registry.json");
      try {
        const json = JSON.parse(await fsp.readFile(reg, "utf8"));
        const fonts = (Array.isArray(json.fonts) ? json.fonts : [])
          .map((f) => {
            const face = Array.isArray(f.faces) ? f.faces[0] : null;
            let src = "";
            if (face && face.filename) {
              const file = path.join(home, "font-library", "files", String(face.filename));
              if (fs.existsSync(file)) src = "http://127.0.0.1:3320/file?p=" + encodeURIComponent(file) + "&t=" + TOKEN;
            }
            return {
              id: String(f.id || ""),
              label: String(f.label || f.id || ""),
              family: String(f.family || ""),
              origin: String(f.origin || ""),
              src,
              format: face && /otf$/i.test(String(face.filename)) ? "opentype" : "truetype",
              fallback: Array.isArray(f.fallbackFamilies) && f.fallbackFamilies.length ? f.fallbackFamilies : ["serif"],
            };
          })
          .filter((f) => f.id && f.family);
        return send(200, { ok: true, fonts });
      } catch (error) {
        return send(200, { ok: false, error: "读不到字体库：" + String((error && error.message) || error) });
      }
    }

    if (route === "/ping") return send(200, { ok: true, jobs: jobs.size, queued: queue.length });
    if (route === "/jobs" && method === "GET") {
      return send(200, { ok: true, jobs: [...jobs.values()].map(view) });
    }
    if (route.startsWith("/jobs/") && method === "GET") {
      const job = jobs.get(route.slice("/jobs/".length));
      return job ? send(200, { ok: true, job: view(job) }) : send(404, { ok: false, error: "没有这个任务" });
    }
    if (route === "/fetch" && method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const target = String(payload.url || "");
      const dest = String(payload.dest || "");
      if (!target || !dest) return send(400, { ok: false, error: "缺少 url 或 dest" });
      const job = newJob(target, dest, payload);
      return send(200, { ok: true, id: job.id, path: job.dest });
    }
    if (route === "/open" && method === "POST") {      const payload = JSON.parse((await readBody(req)) || "{}");
      const dir = String(payload.dir || "");
      if (!dir) return send(400, { ok: false, error: "缺少 dir" });
      // 目录还不存在就先建出来（用户第一次点「打开目录」时很常见）
      await fsp.mkdir(dir, { recursive: true });
      const exe = path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe");
      const child = spawn(exe, [dir], { detached: true, stdio: "ignore" });
      child.unref();
      return send(200, { ok: true, dir });
    }
    /* 目录占用（2026-10-30）：算整棵目录（含封面歌词），用于自动缓存的限额判断。
       应用进程读不到用户目录（权限只覆盖 dataDir），所以由这里算。 */
    if (route === "/usage" && method === "GET") {
      const dir = String(url.searchParams.get("dir") || "");
      if (!dir) return send(400, { ok: false, error: "缺少 dir" });
      const now = Date.now();
      if (usageCache.dir === dir && now - usageCache.at < 60000 && usageCache.value) {
        return send(200, Object.assign({ ok: true, cached: true }, usageCache.value));
      }
      let bytes = 0;
      let files = 0;
      const walk = async (folder) => {
        const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
        for (const ent of entries) {
          const full = path.join(folder, ent.name);
          if (ent.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!ent.isFile()) continue;
          const st = await fsp.stat(full).catch(() => null);
          if (st) {
            bytes += st.size;
            files += 1;
          }
        }
      };
      await walk(dir);
      usageCache.dir = dir;
      usageCache.at = now;
      usageCache.value = { bytes, files };
      return send(200, { ok: true, bytes, files });
    }
    /* 补写归档（2026-10-31）：异羽清过「封面歌词」后，本地歌就没词没封面了。
       应用进程写不了用户目录，所以由这里代写；内容由应用层从在线接口取得。 */
    if (route === "/sidecar" && method === "POST") {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const dir = String(payload.dir || "");
      const stem = String(payload.stem || "");
      if (!dir || !stem) return send(400, { ok: false, error: "缺少 dir 或 stem" });
      const sdir = path.join(dir, "封面歌词", stem);
      await fsp.mkdir(sdir, { recursive: true }).catch(() => null);
      const wrote = [];
      if (payload.coverUrl) {
        try {
          const res = await fetch(String(payload.coverUrl));
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length) {
              await fsp.writeFile(path.join(sdir, "cover.jpg"), buf);
              wrote.push("cover");
            }
          }
        } catch {
          /* 封面失败不影响词 */
        }
      }
      if (payload.lyric) {
        await fsp.writeFile(path.join(sdir, "lyrics.lrc"), String(payload.lyric), "utf8").catch(() => null);
        wrote.push("lrc");
      }
      if (payload.yrc) {
        await fsp.writeFile(path.join(sdir, "lyrics.yrc"), String(payload.yrc), "utf8").catch(() => null);
        wrote.push("yrc");
      }
      if (payload.meta) {
        await fsp.writeFile(path.join(sdir, "meta.json"), JSON.stringify(payload.meta, null, 2), "utf8").catch(() => null);
        wrote.push("meta");
      }
      usageCache.at = 0; // 目录变了，占用缓存作废
      return send(200, { ok: true, dir: sdir, wrote });
    }
    /* 归档夹列表（2026-10-31）：删了音频重下时，靠它把**原序号**捡回来 ——
       否则 007 xxx 会变成 xxx，序号一丢，列表顺序也跟着变。 */
    if (route === "/stems" && method === "GET") {
      const dir = String(url.searchParams.get("dir") || "");
      if (!dir) return send(400, { ok: false, error: "缺少 dir" });
      const root = path.join(dir, "封面歌词");
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      return send(200, { ok: true, items: entries.filter((e) => e.isDirectory()).map((e) => e.name) });
    }
    if (route === "/list" && method === "GET") {
      const dir = String(url.searchParams.get("dir") || "");
      if (!dir) return send(400, { ok: false, error: "缺少 dir" });
      const names = await fsp.readdir(dir).catch(() => []);
      const items = [];
      const hasFile = async (p) => {
        const st = await fsp.stat(p).catch(() => null);
        return !!(st && st.isFile());
      };
      /* 音频平铺在根下；封面/歌词/ meta 在 `<dir>\\封面歌词\\<同名>\\`（2026-10-22 用户定的）。
         两边用「去扩展名的文件名」对起来写，所以改档位重下也不会错位。
         2026-10-30：异羽把音频收进了子文件夹（「新建文件夹」），只扫根下就一首也找不到；
         现在根下 + **一层子目录**都扫，跳过「封面歌词」（那里只有封面与词）。同名以根下优先。 */
      const sidecarRoot = path.join(dir, "封面歌词");
      const audioFiles = new Map();
      const takeAudio = async (folder, name) => {
        const full = path.join(folder, name);
        const stat = await fsp.stat(full).catch(() => null);
        return stat && stat.isFile() ? { name, full, stat } : null;
      };
      for (const name of names) {
        const full = path.join(dir, name);
        const stat = await fsp.stat(full).catch(() => null);
        if (stat && stat.isFile()) {
          if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) continue;
          if (!audioFiles.has(name)) audioFiles.set(name, { name, full, stat });
          continue;
        }
        if (stat && stat.isDirectory() && name !== "封面歌词") {
          const subNames = await fsp.readdir(full).catch(() => []);
          for (const sub of subNames) {
            if (!AUDIO_EXT.has(path.extname(sub).toLowerCase())) continue;
            const hit = await takeAudio(full, sub);
            if (hit && !audioFiles.has(sub)) audioFiles.set(sub, hit);
          }
        }
      }
      for (const { name, full, stat } of audioFiles.values()) {
        const stem = name.replace(/\.[^.]+$/, "");
        const sdir = path.join(sidecarRoot, stem);
        const cover = path.join(sdir, "cover.jpg");
        const lrc = path.join(sdir, "lyrics.lrc");
        const yrc = path.join(sdir, "lyrics.yrc");
        const metaFile = path.join(sdir, "meta.json");
        items.push({
          name,
          path: full,
          size: stat.size,
          mtime: stat.mtimeMs,
          cover: (await hasFile(cover)) ? cover : "",
          lrc: (await hasFile(lrc)) ? lrc : "",
          /* 逐字时间轴（2026-10-23）：层染“走字不准”的根 —— 有它才能按字同步。 */
          yrc: (await hasFile(yrc)) ? yrc : "",
          meta: (await hasFile(metaFile)) ? metaFile : "",
        });
      }
      items.sort((a, b) => a.name.localeCompare(b.name, "zh"));
      return send(200, { ok: true, dir, items });
    }
    if (route === "/file" && method === "GET") {
      const target = String(url.searchParams.get("p") || "");
      if (!target) return send(400, { ok: false, error: "缺少 p" });
      if (!fileAllowed(target)) return send(403, { ok: false, error: "路径不在允许的目录内" });
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return send(404, { ok: false, error: "文件不存在" });
      const total = stat.size;
      const type = MIME_OF[path.extname(target).toLowerCase()] || "application/octet-stream";
      const pipe = (start, end, code, extra) => {
        const stream = fs.createReadStream(target, { start, end });
        stream.on("error", () => {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        });
        res.writeHead(code, Object.assign({ "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" }, corsHeaders(req), extra || {}));
        stream.pipe(res);
      };
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || "").trim());
      if (m) {
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          return res.end();
        }
        return pipe(start, end, 206, {
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${total}`,
        });
      }
      return pipe(0, Math.max(0, total - 1), 200, { "Content-Length": String(total) });
    }
    return send(404, { ok: false, error: "未知端点 " + route });
  } catch (error) {
    return send(500, { ok: false, error: String((error && error.message) || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[downloader] listening on http://${HOST}:${PORT}`);
  console.log(READY_MARKER);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
process.on("uncaughtException", (error) => log("未捕获异常", String((error && error.stack) || error)));
