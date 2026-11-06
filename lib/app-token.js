/**
 * lib/app-token.js — App 与两个本机托管服务之间的共享令牌。
 *
 * 为什么要有它：下载器（3320）与 mpv 桥（3310）跑在 local-machine 档，没有文件系统隔离，
 * 本机任何进程都能连上回环端口。它们又都能做危险操作（读文件、spawn 可执行文件），
 * 所以必须有一个「只给 App 用」的凭据。
 *
 * 分发方式：`sdk.runtime.start()` 没有 env 字段（见 lib/service.js 顶部注释），
 * 只能走文件。App 先把这个文件写到 dataDir，子进程启动时读同一路径。
 *
 * 令牌固定不轮换：服务是懒启动、还可能被巡检重启，轮换会让已经起来的旧进程失联。
 * 64 位 hex，权限只在本机用户下。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TOKEN_FILE = "runtime-token";

let cached = "";
let dataDirCached = "";

function tokenPath(dataDir) {
  return path.join(dataDir, TOKEN_FILE);
}

/**
 * 读已有的令牌；没有就生成一个写进去。返回最终使用的令牌（可能为空，表示写失败）。
 * 启动时调用一次即可。
 */
export function initToken(dataDir) {
  dataDirCached = String(dataDir || "");
  const p = tokenPath(dataDir);
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(raw)) {
      cached = raw;
      return cached;
    }
  } catch {
    /* 没有文件：往下生成 */
  }
  cached = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(p, cached, "utf8");
  } catch {
    /* 写不进去时仍把令牌留在内存里；子进程读不到会拒绝连接，宁可断也不裸奔 */
  }
  return cached;
}

export function getToken() {
  return cached;
}

/** 启动时传入的数据目录（写 dl-roots.json 用）。 */
export function getDataDir() {
  return dataDirCached;
}

/**
 * 给 img/audio 这类不能带请求头的 URL 用：把令牌拼进查询串。
 * 只用于回环地址，不会出现在外发请求里。
 */
export function withToken(url) {
  if (!cached) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${cached}`;
}
