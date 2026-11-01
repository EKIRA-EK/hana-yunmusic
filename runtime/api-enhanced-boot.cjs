/**
 * runtime/api-enhanced-boot.cjs — 取源服务（api-enhanced）的启动壳。
 *
 * 由 App 通过 sdk.runtime.start({ runtime:"node", entry:"runtime/api-enhanced-boot.cjs",
 * profile:"local-machine", network:"external" }) 拉起。
 *
 * 为什么不直接把 api-enhanced/app.js 当 entry：
 *   api-enhanced 的 serveNcmApi 只认 options.port / process.env.PORT，不读命令行参数，
 *   而宿主的 start() 没有 env 字段。所以在这里把 PORT / HOST 写进进程环境再 require，
 *   既不用依赖工作目录，也不用额外放一个 .env 文件。
 *
 * 为什么不用 NODE_OPTIONS 垫片：
 *   宿主的托管运行时（local-machine）不以 AppHost 的 Node 权限模型为边界，子进程是
 *   干净的，直接 require 自己的 node_modules 即可。旧版 ncm-cli 的垫片做法只在
 *   「App 进程自己 spawn」时才需要。
 *
 * 目录定位按候选顺序找，避免依赖 cwd：
 *   1. HANA_MUSIC_API_DIR（手动调试用；旧变量名 HANA_MUSIC163_API_DIR 仍兼容）
 *   2. <cwd>/api-enhanced（宿主默认 cwd 是本 App 的 dataDir）
 *   3. <HANA_HOME>/app-data/hana-yunmusic/api-enhanced（由安装目录反推）
 *   4. <HANA_HOME>/app-data/hana-music163/api-enhanced（**旧 id 的目录**，2026-10-30 改名前的）
 */
const fs = require("node:fs");
const path = require("node:path");

process.env.PORT = process.env.PORT || "3300";
process.env.HOST = process.env.HOST || "127.0.0.1";

const candidates = [
  process.env.HANA_MUSIC_API_DIR,
  process.env.HANA_MUSIC163_API_DIR,
  path.join(process.cwd(), "api-enhanced"),
  path.join(__dirname, "..", "..", "..", "app-data", "hana-yunmusic", "api-enhanced"),
  /* 改名（2026-10-30）前装在旧 id 目录下的那一份，130MB / 1.7 万文件，不必让人重装。 */
  path.join(__dirname, "..", "..", "..", "app-data", "hana-music163", "api-enhanced"),
].filter(Boolean);

const dir = candidates.find((candidate) => {
  try {
    return fs.existsSync(path.join(candidate, "app.js"));
  } catch {
    return false;
  }
});

if (!dir) {
  console.error(
    "[hana-yunmusic] 找不到 api-enhanced 目录，以下候选里都没有 app.js：\n  " + candidates.join("\n  "),
  );
  process.exit(1);
}

console.log("[hana-yunmusic] 取源服务目录：" + dir);
require(path.join(dir, "app.js"));
