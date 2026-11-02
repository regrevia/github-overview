import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig, resolveToken, parseRepo } from "./config.mjs";
import { makeGithub } from "./github.mjs";
import { makeNpm } from "./npm.mjs";
import { loadStore, saveStore, mergeTraffic, mergeNpm, series, storedDays } from "./store.mjs";
import { aiSummary, readAiConfig, saveAiConfig } from "./summary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

export function createApp({ repo, days = 7 } = {}) {
  const cfg = readConfig();
  const target = parseRepo(repo || cfg.repo || "");
  const npmPkg = cfg.npm || target.name;
  const selfLogins = cfg.selfLogins || [];
  const token = resolveToken(cfg);
  const gh = makeGithub(token, target);
  const npm = makeNpm(npmPkg);
  let store = loadStore();
  let lastSync = null;
  let lastActivity = null;

  async function sync() {
    const from = new Date(Date.now() - 14 * 864e5).toISOString();
    const [views, clones, paths, referrers, repoInfo, releases, activity, alerts] = await Promise.all([
      gh.views().catch(() => null),
      gh.clones().catch(() => null),
      gh.paths().catch(() => []),
      gh.referrers().catch(() => []),
      gh.repo().catch(() => null),
      gh.releases().catch(() => []),
      gh.activity(from, selfLogins).catch(() => ({ issues: [], pulls: [], selfCount: 0 })),
      gh.alerts().catch(() => null),
    ]);
    if (views || clones) mergeTraffic(store, views, clones);
    const range = await npm.range(new Date(Date.now() - 400 * 864e5), new Date());
    if (Array.isArray(range)) mergeNpm(store, range);
    const week = await npm.week().catch(() => null);
    if (week && Number.isFinite(week.downloads)) store.meta.npmWeek = week.downloads;
    store.meta.repo = repoInfo || store.meta.repo || null;
    const prefix = `/${target.owner}/${target.name}`;
    store.meta.paths = (paths || []).map((p) => ({
      p: p.path === prefix ? "仓库主页"
        : (p.path.startsWith(prefix + "/") ? p.path.slice(prefix.length + 1) : p.path),
      n: p.count,
      u: p.uniques,
    }));
    store.meta.referrers = (referrers || []).map((r) => ({ from: r.referrer, n: r.count, u: r.uniques }));
    store.meta.alerts = alerts;
    store.meta.npmVers = await npm.perVersion().catch(() => []);
    // 发版时间优先用 npm 发布时间：GitHub 上很多仓库只打 tag 而不建 Release
    const published = await npm.versions().catch(() => []);
    const merged = (releases || []).map((r) => ({ tag: r.tag_name, at: r.published_at, url: r.html_url }));
    for (const v of published) {
      if (!merged.some((r) => r.tag === v.version)) merged.push({ tag: v.version, at: v.at, url: null });
    }
    merged.sort((x, y) => Date.parse(y.at || 0) - Date.parse(x.at || 0));
    store.releases = merged.slice(0, 30);
    saveStore(store);
    lastActivity = activity;
    lastSync = new Date().toISOString();
    return { ok: true, syncedAt: lastSync };
  }

  function build(windowDays) {
    const npmDaily = store.npm || {};
    const rows = series(store, windowDays, npmDaily);
    const activity = lastActivity || { issues: [], pulls: [], selfCount: 0 };
    const meta = store.meta || {};
    const views = meta.views || {};
    const clones = meta.clones || {};
    const covers = storedDays(store);
    // 访客用 API 自己的窗口去重值；窗口长于覆盖天数时退回日均估算
    const uniques = windowDays <= 14 && views.uniques != null ? views.uniques : null;
    return {
      repo: meta.repo ? { ...meta.repo, npmPkg } : { owner: target.owner, name: target.name, npmPkg },
      range: { days: windowDays, from: rows[0]?.d, to: rows.at(-1)?.d, storedDays: covers },
      series: rows,
      totals: {
        views: views.total ?? null,
        uniques,
        clones: clones.total ?? null,
        cloneUniques: clones.uniques ?? null,
        npmWeek: meta.npmWeek ?? null,
      },
      paths: meta.paths || [],
      referrers: meta.referrers || [],
      releases: store.releases || [],
      npmVersions: (store.meta && store.meta.npmVers) || [],
      contributions: {
        issues: activity.issues || [],
        pulls: activity.pulls || [],
        selfCount: activity.selfCount || 0,
        alerts: meta.alerts || null,
      },
      updatedAt: lastSync,
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (url.pathname === "/api/data") {
        return send(200, build(Number(url.searchParams.get("days") || days)));
      }
      if (url.pathname === "/api/sync" && req.method === "POST") {
        return send(200, await sync());
      }
      if (url.pathname === "/api/summary") {
        const windowDays = Number(url.searchParams.get("days") || days);
        const data = build(windowDays);
        const ai = await aiSummary({
          days: windowDays,
          uniques: data.totals.uniques,
          views: data.totals.views,
          external: data.contributions,
          stars: data.repo.stars,
          npmWeek: data.totals.npmWeek,
          paths: data.paths,
        });
        return send(200, ai);
      }
      if (url.pathname === "/api/config") {
        if (req.method === "POST") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw || "{}");
          const next = { ...readConfig(), ...body };
          writeConfig(next);
          return send(200, { ...readAiConfig(), apikey: next.apikey ? "已保存" : "" });
        }
        const ai = readAiConfig();
        return send(200, { ...ai, apikey: ai.apikey ? "已保存" : "" });
      }
      let file = url.pathname === "/" ? "/index.html" : url.pathname;
      const full = join(PUBLIC, file);
      if (!full.startsWith(PUBLIC) || !existsSync(full)) return send(404, "not found", "text/plain");
      return send(200, await readFile(full), MIME[extname(full)] || "application/octet-stream");
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  });

  return {
    server,
    sync,
    listen(port = 4317, host = "127.0.0.1") {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
  };
}
