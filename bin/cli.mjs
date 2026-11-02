#!/usr/bin/env node
import { readConfig, writeConfig, parseRepo, CONFIG_PATH } from "./../src/config.mjs";
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
const port = Number(flag("--port", "-p") || process.env.PORT || 4317);
const npmArg = flag("--npm");
const days = Number(flag("--days") || 7);
const intervalHours = Number(flag("--refresh") || 6);

function usage() {
  console.log(`github-overview

  github-overview init --repo owner/repo [--npm 包名]
  github-overview start [--port 4317] [--days 7] [--refresh 6]
  github-overview sync
  github-overview config --apikey KEY --baseurl URL
`);
}

try {
  if (cmd === "init") {
    const { owner, name } = parseRepo(repoArg || flag("--repo"));
    const next = { ...readConfig(), repo: `${owner}/${name}`, npm: npmArg || name };
    writeConfig(next);
    console.log(`已写入 ${CONFIG_PATH}`);
    console.log(`仓库 ${next.repo}，npm 包 ${next.npm}`);
    console.log("下一步：github-overview start");
    process.exit(0);
  }

  if (cmd === "config") {
    const next = { ...readConfig() };
    const apikey = flag("--apikey");
    const baseurl = flag("--baseurl");
    if (apikey) next.apikey = apikey;
    if (baseurl) next.baseurl = baseurl.replace(/\/$/, "");
    writeConfig(next);
    console.log(`AI 配置已保存到 ${CONFIG_PATH}`);
    process.exit(0);
  }

  const cfg = readConfig();
  const repo = repoArg || cfg.repo;
  if (!repo) {
    usage();
    console.log("还没有配置仓库，先跑：github-overview init --repo owner/repo");
    process.exit(1);
  }

  if (cmd === "sync") {
    const app = createApp({ repo, days });
    const out = await app.sync();
    console.log(`同步完成 ${out.syncedAt}`);
    process.exit(0);
  }

  if (cmd === "start") {
    const app = createApp({ repo, days });
    const addr = await app.listen(port);
    console.log(`github-overview 在 http://127.0.0.1:${addr.port}`);
    const tick = async () => {
      try {
        const out = await app.sync();
        console.log(`同步 ${out.syncedAt}`);
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
