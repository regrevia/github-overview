#!/usr/bin/env node
import { readConfig, writeConfig, parseRepo, normalizeConfig, resolveToken, CONFIG_PATH } from "./../src/config.mjs";
import { createApp } from "./../src/server.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
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
const npmArg = flag("--npm");
const days = Number(flag("--days") || 7);
const intervalHours = Number(flag("--refresh") || 6);

function usage() {
  console.log(`github-overview

  github-overview init --user 用户名 [--npm 包名,...]
  github-overview init --repo owner/repo[,owner/repo2] [--npm 包名,...]
  github-overview start [--port 4317] [--days 7] [--refresh 6]
  github-overview sync
  github-overview config --apikey KEY --baseurl URL [--model deepseek-chat]
`);
}

// 账号绑定：列出该账号名下仓库；有 token 时能拿到私有仓库的 traffic
async function listUserRepos(user) {
  const token = resolveToken(readConfig());
  const headers = { accept: "application/vnd.github+json", "user-agent": "github-overview" };
  if (token) headers.authorization = `Bearer ${token}`;
  const who = await fetch("https://api.github.com/user", { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const path = who?.login === user ? "/user/repos?affiliation=owner&per_page=100&sort=pushed" : `/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`;
  const res = await fetch("https://api.github.com" + path, { headers });
  if (!res.ok) throw new Error(`拉取 ${user} 的仓库失败：${res.status}`);
  const rows = await res.json();
  return rows.filter((r) => !r.fork && (r.permissions ? r.permissions.push : true)).map((r) => ({ repo: r.full_name }));
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
  if (!repos.length) {
    usage();
    console.log("还没有配置仓库，先跑：github-overview init --user 用户名");
    process.exit(1);
  }

  if (cmd === "sync") {
    const app = createApp({ repos, days, cfg });
    const out = await app.sync();
    for (const r of out.results) console.log(`${r.ok ? "同步" : "失败"} ${r.repo}${r.error ? "：" + r.error : ""}`);
    console.log(`同步完成 ${out.syncedAt}`);
    process.exit(out.ok ? 0 : 1);
  }

  if (cmd === "start") {
    const app = createApp({ repos, days, cfg });
    const addr = await app.listen(port);
    console.log(`github-overview 在 http://127.0.0.1:${addr.port}`);
    console.log(`已绑定 ${cfg.user}，${repos.length} 个仓库`);
    const tick = async () => {
      try {
        const out = await app.sync();
        const failed = out.results.filter((r) => !r.ok);
        console.log(`同步 ${out.syncedAt}${failed.length ? `，${failed.length} 个失败` : ""}`);
      } catch (e) {
        console.log(`同步失败：${e.message}`);
      }
    };
    tick();
    setInterval(tick, Math.max(1, intervalHours) * 3600e3);
    await new Promise(() => {});
  }

  usage();
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
