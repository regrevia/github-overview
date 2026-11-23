import { readConfig, writeConfig, resolveToken } from "./config.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 绑定账号只有两条路，两条都要用户在浏览器里亲自授权：
//   1. 设备码流：显示 8 位码，在浏览器里确认（配了 GITHUB_OAUTH_CLIENT_ID 时走这条）
//   2. gh 的一次性授权：临时配置目录里跑 gh auth login --web，浏览器里点一下确认
// 本机 gh 里已经躺着的登录任何情况下都不借用——谁授权，绑的就是谁。
// 设备码流需要一个公开的 client_id（OAuth App 的 ID，本身不是密钥）。
// 想用它就把 GITHUB_OAUTH_CLIENT_ID 写进环境变量或配置，不写就走第 2 条。
// 两条都不通（没装 gh 也没配 client_id）时，退回粘贴 PAT。
const GH = "https://github.com";
const API = "https://api.github.com";
const UA = "github-overview";

export function clientId(cfg = readConfig()) {
  return process.env.GITHUB_OAUTH_CLIENT_ID || cfg.oauthClientId || "";
}

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: "bad_response", detail: text.slice(0, 120) };
  }
};

// /api/auth 每开一次页面就要判一次绑定态。直接问 GitHub 是 600–1000ms，
// 页面首屏会卡在这上面，所以认过的人名按账号缓存几分钟；
// 网络抖一下不该让用户看到「未绑定」，失败时宁可回上次认到的结果。
const ME_TTL = 5 * 60 * 1000;
const meCache = new Map(); // token 摘要 → { at, me }
const meKey = (token) => createHash("sha256").update(token).digest("hex").slice(0, 16);

export async function whoami(token, { fresh = false } = {}) {
  if (!token) return null;
  const key = meKey(token);
  const cached = fresh ? null : meCache.get(key);
  if (cached && Date.now() - cached.at < ME_TTL) return cached.me;
  const res = await fetch(`${API}/user`, {
    headers: { accept: "application/vnd.github+json", "user-agent": UA, authorization: `Bearer ${token}` },
  }).catch(() => null);
  // 凭据被撤销/失效是明确的答复，不能拿缓存糊过去；拿不到答复才回上次认到的人
  if (res && (res.status === 401 || res.status === 403)) {
    meCache.delete(key);
    return null;
  }
  if (!res || !res.ok) return cached ? cached.me : null;
  const me = await json(res);
  if (!me?.login) return cached ? cached.me : null;
  const out = { login: me.login, name: me.name || "", avatar: me.avatar_url || "" };
  meCache.set(key, { at: Date.now(), me: out });
  return out;
}

// 绑定状态：返回谁在用、token 从哪来，但绝不回传 token 本身
export async function authState() {
  const cfg = readConfig();
  // 只有用户自己给过的凭据才算绑定：环境变量或这里存下的 token。
  // 本机 gh 里躺着的登录不算——别人在这台电脑上打开，不该直接看到前一个人的账号。
  const fromEnv = Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  const explicit = fromEnv || Boolean(cfg.token);
  const me = explicit ? await whoami(resolveToken(cfg)) : null;
  const source = !me ? "none" : fromEnv ? "env" : "config";
  return {
    bound: Boolean(me),
    login: me?.login || null,
    name: me?.name || "",
    source,
    deviceFlow: Boolean(clientId(cfg)),
    // 前端据此决定主按钮走哪条路：浏览器授权 / 粘贴访问令牌
    loginMode: loginMode(cfg),
    repos: (cfg.repos || []).length,
  };
}

export async function deviceStart() {
  const id = clientId();
  if (!id) throw new Error("改用访问令牌");
  const res = await fetch(`${GH}/login/device/code`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    // repo 才能读私有仓的 traffic；read:user 只是为了显示绑定的是谁
    body: JSON.stringify({ client_id: id, scope: "repo read:user" }),
  }).catch((e) => {
    throw new Error(`连不上 GitHub：${e.message}`);
  });
  const data = await json(res);
  if (!data.device_code) {
    throw new Error("GitHub 没给出授权码，稍后重试");
  }
  return {
    userCode: data.user_code,
    verifyUrl: data.verification_uri || `${GH}/login/device`,
    interval: Math.max(5, Number(data.interval) || 5),
    expiresIn: Number(data.expires_in) || 900,
    deviceCode: data.device_code,
  };
}

// 轮询一次：pending 就继续等，拿到 token 直接落盘（0600），不经过前端
export async function devicePoll(deviceCode) {
  const id = clientId();
  if (!id) throw new Error("改用访问令牌");
  const res = await fetch(`${GH}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ client_id: id, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  }).catch(() => null);
  const data = res ? await json(res) : { error: "network" };
  if (data.access_token) {
    const me = await whoami(data.access_token, { fresh: true });
    if (!me) return { status: "error", message: "这个 token 读不到账号" };
    saveToken(data.access_token, me.login);
    return { status: "ok", login: me.login };
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") return { status: "pending" };
  if (data.error === "expired_token") return { status: "expired", message: "码过期了，重新开始" };
  if (data.error === "access_denied") return { status: "denied", message: "你取消了这次授权" };
  // 剩下的情况用户只需要知道再点一次；原文留给日志
  console.warn("[auth] device poll:", data.error_description || data.error);
  return { status: "error", message: "授权没完成，再点一次" };
}

// 把 token 写进配置；当前登录的 gh 账号也一并记下来，方便后面按账号列仓库
export function saveToken(token, login) {
  const cfg = readConfig();
  const next = { ...cfg, token };
  if (login) next.user = login;
  writeConfig(next);
  return next;
}

// 绑定之后直接把账号名下自己有权推送的仓库填进去，不然用户还要再跑一次 init
export async function ownedRepos(token, login) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${API}/user/repos?affiliation=owner&per_page=100&sort=pushed&page=${page}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": UA, authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!res || !res.ok) throw new Error(`拉取仓库失败：${res ? res.status : "网络"}`);
    const rows = await json(res);
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all
    .filter((r) => !r.fork && (r.permissions ? r.permissions.push : true) && r.owner?.login?.toLowerCase() === String(login || r.owner?.login).toLowerCase())
    .map((r) => ({ repo: r.full_name }));
}

// 绑定 + 首次填仓库合成一步：已有绑定就不覆盖
export async function adoptAccount(token, login) {
  const cfg = readConfig();
  if ((cfg.repos || []).length) return { added: 0, total: cfg.repos.length };
  const repos = await ownedRepos(token, login);
  if (!repos.length) return { added: 0, total: 0 };
  const next = { ...cfg, token, user: login, repos };
  delete next.repo;
  delete next.npm;
  writeConfig(next);
  return { added: repos.length, total: repos.length };
}

// 同步、不联网：只回答「用户自己给过凭据没有」，供每个请求快速判断要不要给数据。
// 本机 gh 里的登录不算：那不是用户在这个界面里授权过的身份。
export function boundExplicit(cfg = readConfig()) {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return true;
  return Boolean(cfg.token);
}

// 有没有 gh 命令行：有就能让它自己开浏览器做一次性授权，不用我们注册 OAuth App
export function hasGh() {
  try {
    execFileSync("gh", ["--version"], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// gh 平时把登录存在自己的配置目录（或系统钥匙串）里。授权时把它的配置目录指向一个空目录，
// 并让它把凭据明文写进那个目录：这样读回来的 token 只可能来自刚才这次授权，
// 不可能顺走这台电脑上原本登着的账号。读的是文件本身，不去碰钥匙串。用完整个目录删掉。
function ghTokenIn(dir) {
  try {
    const raw = readFileSync(join(dir, "hosts.yml"), "utf8");
    const m = raw.match(/^\s*oauth_token:\s*(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function dropDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// 浏览器登录：优先用我们自己的 OAuth App（能显示成这个应用），
// 没配就借 gh 的授权流程——同样是「浏览器里点一下确认」，但账号永远是当前的人自己登的
const LOGIN = new Map();

export function loginMode(cfg = readConfig()) {
  if (clientId(cfg)) return "device";
  if (hasGh()) return "gh";
  return "paste";
}

export async function loginStart(cfg = readConfig()) {
  if (clientId(cfg)) return { mode: "device", ...(await deviceStart()) };
  if (!hasGh()) throw new Error("这台电脑只能用访问令牌");
  const id = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "github-overview-login-"));
  const child = spawn("gh", ["auth", "login", "--web", "--insecure-storage", "--hostname", "github.com", "--git-protocol", "https"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_CONFIG_DIR: dir, NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
  const entry = { child, code: null, done: null, at: Date.now(), tail: "", dir };
  LOGIN.set(id, entry);
  const watch = (buf) => {
    entry.tail = (entry.tail + String(buf)).slice(-400);
    const m = entry.tail.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
    if (m) entry.code = m[1];
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);
  child.on("error", () => { entry.done = { status: "error", message: "没能打开浏览器授权" }; });
  child.on("close", (code) => {
    if (entry.done) return;
    if (code !== 0) {
      entry.done = { status: "denied", message: "没有完成授权，再点一次" };
      return;
    }
    try {
      const token = ghTokenIn(dir);
      dropDir(dir);
      if (!token) {
        entry.done = { status: "error", message: "没读到刚授权的账号" };
        return;
      }
      whoami(token, { fresh: true }).then(async (me) => {
        if (!me) {
          entry.done = { status: "error", message: "读不到刚授权的账号" };
          return;
        }
        saveToken(token, me.login);
        const adopt = await adoptAccount(token, me.login).catch(() => null);
        entry.done = { status: "ok", login: me.login, repos: adopt?.total ?? 0 };
      }).catch((e) => { entry.done = { status: "error", message: e.message }; });
    } catch (e) {
      entry.done = { status: "error", message: e.message };
    }
  });
  // 等 gh 把一次性码打出来，最多 15 秒
  for (let i = 0; i < 60 && !entry.code && !entry.done; i++) await new Promise((r) => setTimeout(r, 250));
  if (entry.done) {
    child.kill("SIGTERM");
    dropDir(dir);
    LOGIN.delete(id);
    throw new Error(entry.done.message || "没能开始授权");
  }
  if (!entry.code) {
    child.kill("SIGTERM");
    dropDir(dir);
    LOGIN.delete(id);
    throw new Error("授权页没打开，再试一次");
  }
  return { mode: "gh", id, userCode: entry.code, verifyUrl: `${GH}/login/device`, interval: 3 };
}

// 轮询浏览器授权结果；成功后 token 已经落盘，前端只需要知道绑到了谁
export function loginPoll(id) {
  const entry = LOGIN.get(id);
  if (!entry) return { status: "error", message: "这次登录已结束，重新点一次" };
  if (entry.done) {
    if (entry.dir) dropDir(entry.dir);
    LOGIN.delete(id);
    return entry.done;
  }
  if (Date.now() - entry.at > 900000) {
    entry.child.kill("SIGTERM");
    if (entry.dir) dropDir(entry.dir);
    LOGIN.delete(id);
    return { status: "expired", message: "等太久了，重新点一次" };
  }
  return { status: "pending" };
}

