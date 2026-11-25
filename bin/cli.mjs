#!/usr/bin/env node
import { readConfig, writeConfig, parseRepo, normalizeConfig, resolveToken, CONFIG_PATH } from "./../src/config.mjs";
import { createApp } from "./../src/server.mjs";
import { startLoop } from "./../src/loop.mjs";
import { authState } from "./../src/auth.mjs";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
// --help / --version 走完就退出，别当成 start 把服务拉起来
if (argv.includes("--help") || argv.includes("-h") || cmd === "help") {
  usage();
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}
const flag = (...names) => {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

const repoArg = flag("--repo", "-r");
const userArg = flag("--user", "-u");
const port = Number(flag("--port", "-p") || process.env.PORT || 4317);
// 手机连的是这台电脑，默认只听本机；要给手机看再加 --host 0.0.0.0
const hostArg = flag("--host") || process.env.HOST || "127.0.0.1";
const npmArg = flag("--npm");
const days = Number(flag("--days") || 7);
const intervalHours = Number(flag("--refresh") || 6);
const contribMinutes = Number(flag("--contrib") || 15);

function usage() {
  console.log(`github-overview

  github-overview init --user 用户名 [--npm 包名,...]
  github-overview init --repo owner/repo[,owner/repo2] [--npm 包名,...]
  github-overview start [--port 4317] [--host 0.0.0.0] [--days 7] [--refresh 6] [--contrib 15]
  github-overview sync
  github-overview config --apikey KEY --baseurl URL [--model deepseek-chat]
`);
}

// 手机要填的地址：只留真实局域网网卡，跳回环、自分配和 VPN 隧道（那不是手机能到的地址）
const TUNNEL = /^(utun|ipsec|gif|stf|awdl|llw|nan|bridge|ap\d|ppp)/;
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (TUNNEL.test(name)) continue;
    for (const it of list || []) {
      if (it.family !== "IPv4" || it.internal) continue;
      if (it.address.startsWith("169.254.")) continue;
      // en0/wlan 这类物理网卡排前面，虚拟网桥排后面
      out.push({ name, ip: it.address });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).map((it) => it.ip);
}

// 账号绑定：列出该账号名下仓库；有 token 时能拿到私有仓库的 traffic
async function listUserRepos(user) {
  const token = resolveToken(readConfig());
  const headers = { accept: "application/vnd.github+json", "user-agent": "github-overview" };
  if (token) headers.authorization = `Bearer ${token}`;
  const who = await fetch("https://api.github.com/user", { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const base = who?.login === user ? "/user/repos?affiliation=owner&per_page=100&sort=pushed" : `/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`;
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com${base}&page=${page}`, { headers });
    if (!res.ok) throw new Error(`拉取 ${user} 的仓库失败：${res.status}`);
    const rows = await res.json();
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all.filter((r) => !r.fork && (r.permissions ? r.permissions.push : true)).map((r) => ({ repo: r.full_name }));
}

try {
  if (cmd === "init") {
    let repos = [];
    let user = userArg;
    if (user) repos = await listUserRepos(user);
    else if (repoArg) repos = repoArg.split(",").map((s) => s.trim()).filter(Boolean).map((s) => parseRepo(s)).map((r) => ({ repo: `${r.owner}/${r.name}` }));
    else {
      usage();
      throw new Error("给个账号或仓库：--user 用户名 或 --repo owner/repo");
    }
    if (!repos.length) throw new Error(`${user || repoArg} 下没有可绑定的仓库`);
    const npmList = npmArg ? npmArg.split(",").map((s) => s.trim()) : [];
    repos = repos.map((r, i) => (npmList[i] ? { ...r, npm: npmList[i] } : r));
    const next = { ...readConfig(), user: user || repos[0].repo.split("/")[0], repos };
    delete next.repo;
    delete next.npm;
    writeConfig(next);
    console.log(`已写入 ${CONFIG_PATH}`);
    console.log(`绑定 ${next.user}，${repos.length} 个仓库`);
    console.log(repos.slice(0, 8).map((r) => `  ${r.repo}${r.npm && r.npm !== r.repo.split("/")[1] ? " → npm " + r.npm : ""}`).join("\n") + (repos.length > 8 ? `\n  …共 ${repos.length} 个` : ""));
    console.log("下一步：github-overview start");
    process.exit(0);
  }

  if (cmd === "config") {
    const next = { ...readConfig() };
    const apikey = flag("--apikey");
    const baseurl = flag("--baseurl");
    const model = flag("--model");
    if (apikey) next.apikey = apikey;
    if (baseurl) next.baseurl = baseurl.replace(/\/$/, "");
    if (model) next.model = model;
    writeConfig(next);
    console.log(`AI 配置已保存到 ${CONFIG_PATH}`);
    process.exit(0);
  }

  const cfg = normalizeConfig(readConfig());
  const repos = cfg.repos;
  // init/sync 需要仓库；start 不需要——空配置先起绑定页，绑完就能用
  if (!repos.length && cmd !== "start") {
    usage();
    console.log("还没有绑定账号，先跑：github-overview init --user 用户名");
    process.exit(1);
  }

  if (cmd === "sync") {
    const app = createApp({ repos, days, intervalHours, contribMinutes, cfg });
    const out = await app.sync();
    for (const r of out.results) console.log(`${r.ok ? "同步" : "失败"} ${r.repo}${r.error ? "：" + r.error : ""}`);
    console.log(`同步完成 ${out.syncedAt}`);
    process.exit(out.ok ? 0 : 1);
  }

  if (cmd === "start") {
    const app = createApp({ repos, days, intervalHours, contribMinutes, cfg });
    const lan = hostArg !== "127.0.0.1" && hostArg !== "localhost";
    const addr = await app.listen(port, lan ? "0.0.0.0" : "127.0.0.1");
    console.log(`github-overview 在 http://127.0.0.1:${addr.port}`);
    if (addr.moved) console.log(`端口 ${port} 被占用了，改用 ${addr.port}`);
    if (repos.length) console.log(`已绑定 ${cfg.user}，${repos.length} 个仓库`);
    else console.log(`还没绑定账号，打开 http://127.0.0.1:${addr.port} 用浏览器登录一次`);
    if (lan) {
      for (const ip of lanAddresses()) console.log(`手机填 http://${ip}:${addr.port}`);
      // 手机连不上时不用改任何配置，数据线插上就能用这条
      console.log(`连不上就把手机插上跑 adb reverse tcp:${addr.port} tcp:${addr.port}，手机上填 http://127.0.0.1:${addr.port}`);
    }
    // 同步节奏放在 src/loop.mjs，桌面端跑的也是这一份
    startLoop(app, { intervalHours, contribMinutes, onLog: (line) => console.log(line) });
    // 首屏会问一次「绑的是谁」，进程刚起来还没认过：先自己认一次，
    // 等等第一次打开就不用等这次网络往返（失败了不影响，请求时再认）
    authState().catch(() => {});
    await new Promise(() => {});
  }

  usage();
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
