import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig, resolveToken, parseRepo, normalizeConfig } from "./config.mjs";
import { makeGithub } from "./github.mjs";
import { makeNpm } from "./npm.mjs";
import { loadStore, saveStore, repoStore, mergeTraffic, mergeNpm, series, storedDays } from "./store.mjs";
import { aiSummary, readAiConfig } from "./summary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ALL = "all";

export function createApp({ repo, repos, days = 7, cfg: cfgIn } = {}) {
  const cfg = cfgIn || readConfig();
  const list = repos || normalizeConfig(cfg).repos || (repo ? [{ repo, npm: cfg.npm }] : []);
  if (!list.length) throw new Error("还没有配置仓库");
  const token = resolveToken(cfg);
  const self = [...new Set([cfg.user, ...(cfg.selfLogins || [])].filter(Boolean))];
  const targets = list.map((r) => {
    const item = typeof r === "string" ? { repo: r } : r;
    const { owner, name } = parseRepo(item.repo);
    const npmPkg = item.npm || name;
    return { key: `${owner}/${name}`, owner, name, npmPkg, gh: makeGithub(token, { owner, name }), npm: makeNpm(npmPkg) };
  });
  let store = loadStore();
  let lastSync = null;

  async function syncOne(t) {
    const s = repoStore(store, t.key);
    const [views, clones, paths, referrers, repoInfo, releases, activity, alerts] = await Promise.all([
      t.gh.views().catch(() => null),
      t.gh.clones().catch(() => null),
      t.gh.paths().catch(() => []),
      t.gh.referrers().catch(() => []),
      t.gh.repo().catch(() => null),
      t.gh.releases().catch(() => []),
      t.gh.activity(new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), self).catch(() => ({ issues: [], pulls: [], selfCount: 0 })),
      t.gh.alerts().catch(() => null),
    ]);
    if (views || clones) mergeTraffic(s, views, clones);
    const npmRange = await t.npm.range(new Date(Date.now() - 400 * 864e5), new Date());
    if (Array.isArray(npmRange)) mergeNpm(s, npmRange);
    const week = await t.npm.week().catch(() => null);
    if (Number.isFinite(week)) s.meta.npmWeek = week;
    const prefix = `/${t.owner}/${t.name}`;
    s.meta.repo = repoInfo || s.meta.repo || { owner: t.owner, name: t.name };
    s.meta.paths = (paths || []).map((p) => {
      const raw = String(p.path || "");
      const page = raw === prefix || raw === prefix + "/" ? "仓库主页" : raw.replace(prefix, "");
      return { p: page || "仓库主页", n: p.count, u: p.uniques };
    });
    s.meta.referrers = (referrers || []).map((r) => ({ from: r.referrer, n: r.count, u: r.uniques }));
    s.meta.alerts = alerts;
    s.meta.npmVers = await t.npm.perVersion().catch(() => []);
    s.meta.activity = activity;
    const published = await t.npm.versions().catch(() => []);
    const merged = new Map();
    for (const r of releases || []) merged.set(r.tag_name, { tag: r.tag_name, at: r.published_at, url: r.html_url });
    for (const v of published) if (!merged.has(v.version)) merged.set(v.version, { tag: v.version, at: v.at, url: null });
    s.releases = [...merged.values()]
      .filter((r) => r.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 30);
    s.meta.syncedAt = new Date().toISOString();
    s.meta.error = null;
    return { repo: t.key, ok: true };
  }

  async function sync() {
    const results = [];
    for (const t of targets) {
      try {
        results.push(await syncOne(t));
      } catch (e) {
        const s = repoStore(store, t.key);
        s.meta.error = String(e.message || e);
        s.meta.syncedAt = new Date().toISOString();
        results.push({ repo: t.key, ok: false, error: s.meta.error });
      }
    }
    saveStore(store);
    lastSync = new Date().toISOString();
    return { ok: results.every((r) => r.ok), syncedAt: lastSync, results };
  }

  // GitHub 只回 14 天去重访客，更长范围沿用这段窗口并说明覆盖天数
  const coveredDays = (s) => Object.values(s.days || {}).filter((d) => d.u != null).length;
  const firstDay = (s) => Object.values(s.days || {})
    .filter((d) => d.v != null || d.u != null).map((d) => d.d).sort()[0] || null;

  const sumOf = (get) => {
    let has = false;
    let v = 0;
    for (const t of targets) {
      const x = get(repoStore(store, t.key));
      if (x != null) {
        has = true;
        v += x;
      }
    }
    return has ? v : null;
  };

  function aggregate(windowDays) {
    const slices = targets.map((t) => ({ t, s: repoStore(store, t.key) }));
    const allSeries = slices.map(({ s }) => series(s, windowDays, s.npm || {}));
    const rows = [];
    for (let i = 0; i < windowDays; i++) {
      const cell = { d: allSeries[0]?.[i]?.d, v: null, u: null, c: null, cu: null, n: null };
      for (const sr of allSeries) {
        const r = sr[i];
        if (!r) continue;
        for (const k of ["v", "u", "c", "cu", "n"]) if (r[k] != null) cell[k] = (cell[k] ?? 0) + r[k];
      }
      rows.push(cell);
    }
    const paths = new Map();
    const referrers = new Map();
    const releases = [];
    const issues = [];
    const pulls = [];
    const npmVersions = [];
    const alertKeys = ["dependabot", "codeScanning", "secretScanning"];
    const alerts = { dependabot: { available: false, open: 0 }, codeScanning: { available: false, open: 0 }, secretScanning: { available: false, open: 0 } };
    for (const { t, s } of slices) {
      const m = s.meta || {};
      for (const p of m.paths || []) {
        const cur = paths.get(p.p) || { p: p.p, n: 0, u: 0 };
        cur.n += p.n || 0;
        cur.u += p.u || 0;
        paths.set(p.p, cur);
      }
      for (const r of m.referrers || []) {
        const cur = referrers.get(r.from) || { from: r.from, n: 0, u: 0 };
        cur.n += r.n || 0;
        cur.u += r.u || 0;
        referrers.set(r.from, cur);
      }
      for (const rel of s.releases || []) releases.push({ ...rel, repo: t.key });
      for (const i of m.activity?.issues || []) issues.push({ ...i, repo: t.key });
      for (const p of m.activity?.pulls || []) pulls.push({ ...p, repo: t.key });
      for (const v of m.npmVers || []) npmVersions.push({ ...v, repo: t.key });
      for (const k of alertKeys) if (m.alerts?.[k]?.available) alerts[k] = { available: true, open: (alerts[k].open || 0) + (m.alerts[k].open || 0) };
    }
    const anyAlert = alertKeys.some((k) => alerts[k].available);
    const repoInfo = slices.reduce(
      (acc, { s }) => ({
        stars: acc.stars + (s.meta?.repo?.stars || 0),
        forks: acc.forks + (s.meta?.repo?.forks || 0),
        openIssues: acc.openIssues + (s.meta?.repo?.openIssues || 0),
      }),
      { stars: 0, forks: 0, openIssues: 0 },
    );
    return {
      repo: { fullName: "全部仓库", owner: "", name: "全部仓库", stars: repoInfo.stars, forks: repoInfo.forks, openIssues: repoInfo.openIssues, count: targets.length },
      range: { days: windowDays, from: rows[0]?.d, to: rows.at(-1)?.d, storedDays: Math.max(...slices.map(({ s }) => storedDays(s)), 0), covered: Math.max(...slices.map(({ s }) => coveredDays(s)), 0), first: slices.map(({ s }) => firstDay(s)).filter(Boolean).sort()[0] || null },
      series: rows,
      totals: {
        views: sumOf((s) => s.meta?.views?.total),
        uniques: sumOf((s) => s.meta?.views?.uniques),
        clones: sumOf((s) => s.meta?.clones?.total),
        cloneUniques: sumOf((s) => s.meta?.clones?.uniques),
        npmWeek: sumOf((s) => s.meta?.npmWeek),
      },
      paths: [...paths.values()].sort((a, b) => b.n - a.n),
      referrers: [...referrers.values()].sort((a, b) => b.n - a.n),
      releases: releases.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30),
      npmVersions,
      contributions: { issues, pulls, alerts: anyAlert ? alerts : null },
      updatedAt: lastSync,
    };
  }

  function buildRepo(windowDays, t) {
    const s = repoStore(store, t.key);
    const rows = series(s, windowDays, s.npm || {});
    const meta = s.meta || {};
    const views = meta.views || {};
    const clones = meta.clones || {};
    return {
      repo: { owner: t.owner, name: t.name, npmPkg: t.npmPkg, ...(meta.repo || {}) },
      range: { days: windowDays, from: rows[0]?.d, to: rows.at(-1)?.d, storedDays: storedDays(s), covered: coveredDays(s), first: firstDay(s) },
      series: rows,
      totals: {
        views: views.total ?? null,
        uniques: views.uniques ?? null,
        clones: clones.total ?? null,
        cloneUniques: clones.uniques ?? null,
        npmWeek: meta.npmWeek ?? null,
      },
      paths: meta.paths || [],
      referrers: meta.referrers || [],
      releases: s.releases || [],
      npmVersions: meta.npmVers || [],
      contributions: { issues: meta.activity?.issues || [], pulls: meta.activity?.pulls || [], alerts: meta.alerts || null },
      updatedAt: meta.syncedAt || lastSync,
    };
  }

  function build(windowDays, key = ALL) {
    if (key === ALL) return aggregate(windowDays);
    const t = targets.find((x) => x.key === key);
    return t ? buildRepo(windowDays, t) : aggregate(windowDays);
  }

  const repoRows = () => ({
    repos: targets.map((t) => {
      const s = repoStore(store, t.key);
      return {
        key: t.key,
        label: t.key,
        npmPkg: t.npmPkg,
        stars: s.meta?.repo?.stars ?? null,
        storedDays: storedDays(s),
        syncedAt: s.meta?.syncedAt ?? null,
        error: s.meta?.error ?? null,
      };
    }),
    default: ALL,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (url.pathname === "/api/repos") {
        return send(200, repoRows());
      }
      if (url.pathname === "/api/data") {
        const windowDays = Number(url.searchParams.get("days") || days);
        return send(200, build(windowDays, url.searchParams.get("repo") || ALL));
      }
      if (url.pathname === "/api/sync" && req.method === "POST") {
        return send(200, await sync());
      }
      if (url.pathname === "/api/summary") {
        const windowDays = Number(url.searchParams.get("days") || days);
        const key = url.searchParams.get("repo") || ALL;
        const data = build(windowDays, key);
        const ai = await aiSummary({
          days: windowDays,
          covered: data.range.covered,
          uniques: data.totals.uniques,
          views: data.totals.views,
          external: data.contributions,
          stars: data.repo.stars,
          npmWeek: data.totals.npmWeek,
          paths: data.paths,
          scope: key === ALL ? `你的 ${targets.length} 个仓库` : key,
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
    build,
    listen(port = 4317, host = "127.0.0.1") {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
  };
}
