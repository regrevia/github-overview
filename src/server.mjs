import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig, resolveToken, parseRepo, normalizeConfig } from "./config.mjs";
import { makeGithub } from "./github.mjs";
import { makeNpm } from "./npm.mjs";
import { loadStore, saveStore, repoStore, mergeTraffic, mergeNpm, mergeStars, series, storedDays } from "./store.mjs";
import { aiSummary, askQuestion, readAiConfig, templateSummary } from "./summary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ALL = "all";
// 摘要别拖慢页面：先回模板，AI 结果进缓存下一次带出来
const SUM_CACHE = new Map();

export function createApp({ repo, repos, days = 7, intervalHours = 6, contribMinutes = 15, cfg: cfgIn } = {}) {
  const cfg = cfgIn || readConfig();
  const list = repos || normalizeConfig(cfg).repos || (repo ? [{ repo, npm: cfg.npm }] : []);
  if (!list.length) throw new Error("还没有配置仓库");
  const token = resolveToken(cfg);
  const self = [...new Set([cfg.user, ...(cfg.selfLogins || [])].filter(Boolean))];
  const targets = list.map((r) => {
    const item = typeof r === "string" ? { repo: r } : r;
    const { owner, name } = parseRepo(item.repo);
    const npmPkg = item.npm || name;
    return { key: `${owner}/${name}`, owner, name, npmPkg, npmExplicit: Boolean(item.npm), gh: makeGithub(token, { owner, name }), npm: makeNpm(npmPkg) };
  });
  let store = loadStore();
  let lastSync = null;
  let syncProgress = { running: false, done: 0, total: 0 };

  async function syncOne(t) {
    const s = repoStore(store, t.key);
    const [views, clones, paths, referrers, repoInfo, releases, activity, alerts, openWork, starDates, forkList] = await Promise.all([
      t.gh.views().catch(() => null),
      t.gh.clones().catch(() => null),
      t.gh.paths().catch(() => null),
      t.gh.referrers().catch(() => null),
      t.gh.repo().catch(() => null),
      t.gh.releases().catch(() => null),
      t.gh.activity(new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), self).catch(() => null),
      t.gh.alerts().catch(() => null),
      t.gh.openWork(self).catch(() => null),
      t.gh.stargazers().catch(() => null),
      t.gh.forks().catch(() => null),
    ]);
    if (views || clones) mergeTraffic(s, views, clones);
    if (starDates) mergeStars(s, starDates);
    // 仓库名当包名只是默认猜测：先看 registry 的维护者，同名别人的包不算自己的下载
    let npmOk = true;
    if (!t.npmExplicit) {
      const own = await t.npm.maintainers().catch(() => null);
      npmOk = !own || !own.owners.length || own.owners.includes(t.owner.toLowerCase());
      if (!npmOk) {
        s.npm = {};
        delete s.meta.npmWeek;
        delete s.meta.npmVers;
      }
    }
    s.meta.npmOwned = npmOk;
    let perVers = null, published = null;
    if (npmOk) {
      // npm registry 的几个接口互相独立，一起发比排队快一半
      const [npmRange, week, pv, pub] = await Promise.all([
        t.npm.range(new Date(Date.now() - 400 * 864e5), new Date()).catch(() => null),
        t.npm.week().catch(() => null),
        t.npm.perVersion().catch(() => null),
        t.npm.versions().catch(() => null),
      ]);
      if (Array.isArray(npmRange)) mergeNpm(s, npmRange);
      if (Number.isFinite(week)) s.meta.npmWeek = week;
      perVers = pv; published = pub;
    }
    const prefix = `/${t.owner}/${t.name}`;
    s.meta.repo = repoInfo || s.meta.repo || { owner: t.owner, name: t.name };
    if (forkList) s.meta.forks = { at: new Date().toISOString(), items: forkList.slice(0, 200) };
    if (paths) {
      s.meta.paths = paths.map((p) => {
        const raw = String(p.path || "");
        const page = raw === prefix || raw === prefix + "/" ? "仓库主页" : raw.replace(prefix, "");
        return { p: page || "仓库主页", n: p.count, u: p.uniques };
      });
    }
    if (referrers) s.meta.referrers = referrers.map((r) => ({ from: r.referrer, n: r.count, u: r.uniques }));
    if (alerts) s.meta.alerts = alerts;
    if (activity) s.meta.activity = activity;
    if (openWork) s.meta.openWork = openWork;
    if (activity || openWork) s.meta.contribAt = new Date().toISOString();
    if (perVers) s.meta.npmVers = perVers;
    if (!npmOk) s.meta.npmVers = [];
    const merged = new Map((s.releases || []).map((r) => [r.tag, r]));
    for (const r of releases || []) merged.set(r.tag_name, { tag: r.tag_name, at: r.published_at, url: r.html_url });
    for (const v of published || []) if (!merged.has(v.version)) merged.set(v.version, { tag: v.version, at: v.at, url: null });
    s.releases = [...merged.values()]
      .filter((r) => r.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      // 每个仓留足够长的历史，别让截断把 90 天窗口里的发版数算少
      .slice(0, 200);
    s.meta.syncedAt = new Date().toISOString();
    s.meta.error = null;
    return { repo: t.key, ok: true };
  }

  // 贡献单独走高频通道：流量/star 是 6 小时一次，issue/PR 状态十几分钟就会变
  async function refreshContrib(t) {
    const s = repoStore(store, t.key);
    const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const [activity, openWork] = await Promise.all([
      t.gh.activity(since, self).catch(() => null),
      t.gh.openWork(self).catch(() => null),
    ]);
    if (activity) s.meta.activity = activity;
    if (openWork) s.meta.openWork = openWork;
    if (activity || openWork) s.meta.contribAt = new Date().toISOString();
    return { repo: t.key, ok: Boolean(activity || openWork) };
  }

  let contribPromise = null;
  async function syncContribs() {
    if (contribPromise) return contribPromise;
    contribPromise = (async () => {
      const results = new Array(targets.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const idx = cursor++;
          const t = targets[idx];
          try {
            results[idx] = await refreshContrib(t);
          } catch (e) {
            results[idx] = { repo: t.key, ok: false, error: String(e.message || e) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
      saveStore(store);
      return { ok: results.every((r) => r.ok), at: new Date().toISOString(), results };
    })();
    try {
      return await contribPromise;
    } finally {
      contribPromise = null;
    }
  }

  let syncPromise = null;
  async function sync() {
    // 连点刷新别再走一遍全量：正在跑就等同一个，刚跑完 1 分钟内直接返回
    if (syncPromise) return syncPromise;
    if (lastSync && Date.now() - Date.parse(lastSync) < 60_000) return { ok: true, cached: true, syncedAt: lastSync };
    syncPromise = runSync();
    try {
      return await syncPromise;
    } finally {
      syncPromise = null;
    }
  }

  async function runSync() {
    // 并发跑：31 个仓库串行要四分钟，用户点刷新只能干等
    const results = new Array(targets.length);
    const state = { running: true, done: 0, total: targets.length, startedAt: new Date().toISOString() };
    syncProgress = state;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const idx = cursor++;
        const t = targets[idx];
        try {
          results[idx] = await syncOne(t);
        } catch (e) {
          const s = repoStore(store, t.key);
          s.meta.error = String(e.message || e);
          s.meta.syncedAt = new Date().toISOString();
          results[idx] = { repo: t.key, ok: false, error: s.meta.error };
        }
        state.done++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
    } finally {
      state.running = false;
      syncProgress = state;
    }
    saveStore(store);
    lastSync = new Date().toISOString();
    return { ok: results.every((r) => r.ok), syncedAt: lastSync, results };
  }

  // 星标净增跟着图表标的区间走：起止与 range 一致，不按请求天数报
  function starGrowthOf(from, to, list) {
    if (!from || !to) return null;
    let delta = 0, seen = 0;
    for (const s of list) {
      const ds = s.stars || [];
      if (!ds.length) continue;
      seen++;
      delta += ds.filter((d) => d >= from && d <= to).length;
    }
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    return seen ? { span, from, to, delta } : null;
  }
  // 星标跨度和浏览/issue 的「近 N 天」用同一个口径：今天没采集到不算一天
  const clampSpan = (sg, cov) => (sg && cov ? { ...sg, span: Math.max(1, Math.min(sg.span, cov)) } : sg);

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
    // 漏斗固定「最近 14 个完整日」：跟随窗口末行会让今天那行 0 参与、切范围时数字还会变
    const funnelEnd = () => {
      const t = new Date();
      t.setUTCHours(0, 0, 0, 0);
      t.setUTCDate(t.getUTCDate() - 1);
      return t.toISOString().slice(0, 10);
    };
    const sum14 = () => {
      const ds = last14Days(funnelEnd());
      return ds.length ? slices.reduce((acc, { s }) => acc + ds.reduce((b, d) => b + (s.days?.[d]?.v ?? 0), 0), 0) : null;
    };
    const allSeries = slices.map(({ s }) => series(s, windowDays, s.npm || {}));
    const rows = [];
    if (windowDays === 1) {
      // 1 天窗口必须落在同一个日历日上：各仓自己的「最近一天」可能不同，
      // 按位置相加会把 11-06 的数写进 11-05 那行
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const pick = (back) => new Date(today.getTime() - back * 864e5).toISOString().slice(0, 10);
      let k = pick(1);
      if (!slices.some(({ s }) => s.days?.[k])) k = pick(2);
      const cell = { d: k, v: null, u: null, c: null, cu: null, n: null };
      for (const { s } of slices) {
        const row = s.days?.[k];
        if (!row) continue;
        for (const kk of ["v", "u", "c", "cu", "n"]) if (row[kk] != null) cell[kk] = (cell[kk] ?? 0) + row[kk];
      }
      rows.push(cell);
    }
    for (let i = 0; i < windowDays && windowDays > 1; i++) {
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
      for (const k of alertKeys) {
        const cell = m.alerts?.[k];
        if (cell?.available) {
          alerts[k] = {
            available: true,
            open: (alerts[k].open || 0) + (cell.open || 0),
            repos: [...(alerts[k].repos || []), { key: t.key, open: cell.open || 0 }],
          };
        } else if (!alerts[k].available && !alerts[k].blocked && cell?.status === 403) {
          alerts[k].blocked = "permission_denied";
        }
      }
    }
    const anyAlert = alertKeys.some((k) => alerts[k].available || alerts[k].blocked);
    const fw = forkWindow(windowDays);
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
        // 这些是按区间加出来的；views.total 是每仓 14 天的量，当窗口用会把 7 天说成 19 天
        // 和 series 行同源，1 天窗口才不会拿各仓不同的「最近一天」去加
        views: rows.reduce((a, x) => a + (x.v ?? 0), 0),
        uniques: sumOf((s) => s.meta?.views?.uniques),
        clones: rows.reduce((a, x) => a + (x.c ?? 0), 0),
        cloneUniques: sumOf((s) => s.meta?.clones?.uniques),
        npmWeek: sumOf((s) => s.meta?.npmWeek),
      },
      repos: targets
        .map((t) => {
          const r = repoStore(store, t.key);
          const w = series(r, windowDays, r.npm || {});
          const sg = starGrowthOf(
            [w.find((x) => x.v != null || x.u != null)?.d || "", firstDay(r) || ""].sort().at(-1) || null,
            w.at(-1)?.d || null,
            [r],
          );
          return {
            key: t.key,
            name: t.key.split("/")[1] || t.key,
            uniques: windowDays === 1 ? (w.at(-1)?.u ?? null) : (r.meta?.views?.uniques ?? null),
            views: w.reduce((a, x) => a + (x.v ?? 0), 0),
            npm: w.reduce((a, x) => a + (x.n ?? 0), 0),
            npmWeek: r.meta?.npmWeek ?? null,
            stars: r.meta?.repo?.stars ?? null,
            starDelta: sg ? sg.delta : null,
            forks: r.meta?.repo?.forks ?? null,
            newForks: (r.meta?.forks?.items || []).filter(inWindow(fw.from, fw.to)).length,
            lastFork: (r.meta?.forks?.items || [])[0] || null,
          };
        })
        .sort((a, b) => (b.uniques ?? 0) - (a.uniques ?? 0)),
      // 漏斗的浏览用「同一段 14 天的逐日和」，别混用 meta 里的接口总数：
      // 两者口径差几次，同时上屏就成两个数
      funnel: {
        views: sum14(),
        home: [...paths.values()].filter((p) => p.p === "仓库主页").reduce((a, p) => a + p.n, 0) || null,
        npm: sumOf((s) => s.meta?.npmWeek),
      },
      impacts: windowDays < 7 ? [] : slices
        .map(({ t, s }) => {
          const im = impactOf(s);
          return im && im.before?.views?.avg ? { key: t.key, name: t.key.split("/")[1] || t.key, ...im } : null;
        })
        .filter((x) => x && x.at >= rows[0]?.d)
        .sort((a, b) => (a.limited === b.limited ? b.at.localeCompare(a.at) : a.limited ? 1 : -1)),
      paths: [...paths.values()].sort((a, b) => b.n - a.n),
      referrers: [...referrers.values()].sort((a, b) => b.n - a.n),
      forks: (() => {
        const items = slices
          .flatMap(({ t, s }) => (s.meta?.forks?.items || [])
            .filter(inWindow(fw.from, fw.to))
            .map((x) => ({ ...x, repo: t.key })))
          .sort((a, b) => String(b.at).localeCompare(String(a.at)));
        const latest = slices
          .flatMap(({ t, s }) => (s.meta?.forks?.items || []).map((x) => ({ ...x, repo: t.key })))
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
        return {
          total: repoInfo.forks,
          from: fw.from,
          to: fw.to,
          inWindow: items.length,
          items: items.slice(0, 100),
          // 窗口里没有新 fork 时，也要能说清最近一次是什么时候
          latest,
          at: slices.map(({ s }) => s.meta?.forks?.at).filter(Boolean).sort().at(-1) || null,
        };
      })(),
      releases: releases.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 120),
      npmVersions,
      impact: windowDays < 7 ? null : (() => {
        // 主卡也要带上仓名，否则只有一个版本号，看不出是哪个仓
        const all = slices.map(({ t, s }) => {
          const im = impactOf(s);
          return im && im.before?.views ? { key: t.key, name: t.key.split("/")[1] || t.key, ...im } : null;
        }).filter((x) => x && x.at >= rows[0]?.d);
        const ok = all.filter((x) => !x.limited).sort((a, b) => b.at.localeCompare(a.at));
        return ok[0] || all.sort((a, b) => b.at.localeCompare(a.at))[0] || null;
      })(),
      contributions: {
        issues: issues.filter(inWindow(rows[0]?.d, rows.at(-1)?.d)),
        pulls: pulls.filter(inWindow(rows[0]?.d, rows.at(-1)?.d)),
        open: {
          issues: slices.flatMap(({ t, s }) => (s.meta?.openWork?.issues || []).map((x) => ({ ...x, repo: t.key }))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
          pulls: slices.flatMap(({ t, s }) => (s.meta?.openWork?.pulls || []).map((x) => ({ ...x, repo: t.key }))).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
        },
        alerts: anyAlert ? alerts : null,
        at: slices.map(({ s }) => s.meta?.contribAt).filter(Boolean).sort().at(-1) || null,
      },
      starGrowth: clampSpan(starGrowthOf(
        [rows.find((r) => r.v != null || r.u != null)?.d || "", slices.map(({ s }) => firstDay(s)).filter(Boolean).sort()[0] || ""]
          .sort()
          .at(-1) || null,
        rows.at(-1)?.d || null,
        slices.map(({ s }) => s),
      ), Math.max(...slices.map(({ s }) => coveredDays(s)), 0)),
      updatedAt: lastSync,
    };
  }

  const shiftDay = (d, n) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };

  // 最近一次发版前后 7 天的日均，数据不足时如实报覆盖天数
  function impactOf(s) {
    const cuts = [
      ...(s.releases || []).filter((r) => r.at).map((r) => ({ version: r.tag, at: String(r.at).slice(0, 10), url: r.url || null })),
      ...((s.meta?.npmVers || []).filter((v) => v.at).map((v) => ({ version: v.v || v.version, at: String(v.at).slice(0, 10), url: null }))),
    ];
    if (!cuts.length) return null;
    cuts.sort((a, b) => b.at.localeCompare(a.at));
    const ev = cuts[0];
    const rows = series(s, 90, s.npm || {});
    const avg = (from, to) => {
      const hit = rows.filter((r) => r.d >= from && r.d <= to);
      const pick = (k) => {
        const got = hit.filter((r) => r[k] !== null && r[k] !== undefined);
        if (!got.length) return null;
        const sum = got.reduce((a, r) => a + r[k], 0);
        return { avg: Math.round((sum / got.length) * 10) / 10, days: got.length, from: got[0].d, to: got.at(-1).d };
      };
      return { from, to, views: pick("v"), uniques: pick("u"), npm: pick("n") };
    };
    const at = (x) => ({ before: avg(shiftDay(x.at, -7), shiftDay(x.at, -1)), after: avg(shiftDay(x.at, 1), shiftDay(x.at, 7)) });
    // 刚发的版本后面还没数据，退到最近一个前后都有 3 天以上的版本
    let chosen = null;
    for (const c of cuts.slice(0, 30)) {
      const r = at(c);
      if (r.before.views?.days >= 3 && r.after.views?.days >= 3) {
        chosen = { ...c, ...r };
        break;
      }
    }
    if (!chosen) {
      const r = at(ev);
      chosen = { ...ev, ...r };
    }
    const { before, after } = chosen;
    const delta = (k) => {
      const b = before[k]?.avg, a = after[k]?.avg;
      return b != null && a != null && b !== 0 ? Math.round((a / b - 1) * 100) : null;
    };
    return { ...chosen, limited: (after.views?.days || 0) < 3, delta: { views: delta("views"), uniques: delta("uniques"), npm: delta("npm") } };
  }

  const inWindow = (from, to) => (x) => {
    // fork 用 at，活动条目用 createdAt/mergedAt：两种字段都要认
    const at = String(x.at || x.mergedAt || x.closedAt || x.createdAt || "").slice(0, 10);
    return !from || (at >= from && at <= to);
  };
  // fork 按创建时间算，不受流量数据滞后一天影响
  const forkWindow = (days) => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - Math.max(0, days - 1) * 864e5).toISOString().slice(0, 10);
    return { from, to };
  };

  function buildRepo(windowDays, t) {
    const s = repoStore(store, t.key);
    const fw = forkWindow(windowDays);
    const rows = series(s, windowDays, s.npm || {});
    // 同全站：固定按「最近 14 个完整日」，不跟窗口末行走
    const sum14 = () => {
      const t = new Date();
      t.setUTCHours(0, 0, 0, 0);
      t.setUTCDate(t.getUTCDate() - 1);
      const ds = last14Days(t.toISOString().slice(0, 10));
      return ds.length ? ds.reduce((b, d) => b + (s.days?.[d]?.v ?? 0), 0) : null;
    };
    const meta = s.meta || {};
    const views = meta.views || {};
    const clones = meta.clones || {};
    return {
      repo: { owner: t.owner, name: t.name, npmPkg: t.npmPkg, ...(meta.repo || {}) },
      range: { days: windowDays, from: rows[0]?.d, to: rows.at(-1)?.d, storedDays: storedDays(s), covered: coveredDays(s), first: firstDay(s) },
      series: rows,
      totals: {
        views: rows.reduce((a, x) => a + (x.v ?? 0), 0),
        uniques: views.uniques ?? null,
        clones: rows.reduce((a, x) => a + (x.c ?? 0), 0),
        cloneUniques: clones.uniques ?? null,
        npmWeek: meta.npmWeek ?? null,
      },
      paths: meta.paths || [],
      funnel: {
        views: sum14(),
        home: (meta.paths || []).filter((p) => p.p === "仓库主页").reduce((a, p) => a + (p.n || 0), 0) || null,
        npm: meta.npmWeek ?? null,
      },
      starGrowth: clampSpan(starGrowthOf(
        [rows.find((r) => r.v != null || r.u != null)?.d || "", firstDay(s) || ""].sort().at(-1) || null,
        rows.at(-1)?.d || null,
        [s],
      ), coveredDays(s)),
      // fork 是留存信号：谁在什么时候 fork 的，窗口内单独列出来
      forks: {
        total: meta.repo?.forks ?? null,
        from: fw.from,
        to: fw.to,
        inWindow: (meta.forks?.items || []).filter(inWindow(fw.from, fw.to)).length,
        items: (meta.forks?.items || []).filter(inWindow(fw.from, fw.to)).slice(0, 30),
        latest: (meta.forks?.items || [])[0] || null,
        at: meta.forks?.at || null,
      },
      referrers: meta.referrers || [],
      releases: s.releases || [],
      npmVersions: meta.npmVers || [],
      impact: windowDays < 7 ? null : (() => {
        const im = impactOf(s);
        return im && im.at >= rows[0]?.d ? im : null;
      })(),
      contributions: {
        issues: (meta.activity?.issues || []).filter(inWindow(rows[0]?.d, rows.at(-1)?.d)),
        pulls: (meta.activity?.pulls || []).filter(inWindow(rows[0]?.d, rows.at(-1)?.d)),
        open: meta.openWork ? { issues: meta.openWork.issues || [], pulls: meta.openWork.pulls || [] } : null,
        alerts: meta.alerts || null,
        at: meta.contribAt || null,
      },
      updatedAt: meta.syncedAt || lastSync,
    };
  }

  // 未知 repo 不能悄悄退回全部仓库：那会把全站数字显示成一个仓的，看起来像这个仓的数据
  function resolveKey(raw) {
    const q = String(raw || "").trim();
    if (!q || q === ALL) return ALL;
    const hit = targets.find((x) => x.key.toLowerCase() === q.toLowerCase());
    if (hit) return hit.key;
    const tail = targets.filter((x) => x.key.toLowerCase().endsWith("/" + q.toLowerCase()));
    return tail.length === 1 ? tail[0].key : null;
  }
  const noRepo = (key) => `没有绑定这个仓库：${key}。右上角切换范围，或在 config 里加上它。`;
  // 以当前窗口最后一天为终点、往前 14 个日历日的逐日浏览和
  const last14Days = (endD) => {
    if (!endD) return [];
    const end = Date.parse(endD + "T00:00:00Z");
    const out = [];
    for (let i = 13; i >= 0; i--) out.push(new Date(end - i * 864e5).toISOString().slice(0, 10));
    return out;
  };

  function build(windowDays, key = ALL) {
    if (key === ALL) return aggregate(windowDays);
    const t = targets.find((x) => x.key === key);
    // 只接受已解析的 key：未绑定的仓库不能悄悄落到全站数据上
    if (!t) throw new Error("没有绑定这个仓库：" + key);
    return t ? buildRepo(windowDays, t) : aggregate(windowDays);
  }

  const repoRows = () => ({
    repos: targets.map((t) => {
      const s = repoStore(store, t.key);
      return {
        key: t.key,
        label: t.key,
        npmPkg: s.meta?.npmOwned === false ? null : t.npmPkg,
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
        const rawKey = url.searchParams.get("repo");
        const key = resolveKey(rawKey);
        if (key === null) return send(404, { error: noRepo(rawKey), repo: rawKey });
        return send(200, build(windowDays, key));
      }
      if (url.pathname === "/api/progress") {
        return send(200, { ...syncProgress, intervalHours, contribMinutes });
      }
      if (url.pathname === "/api/sync" && req.method === "POST") {
        return send(200, await sync());
      }
      if (url.pathname === "/api/summary") {
        const windowDays = Number(url.searchParams.get("days") || days);
        const rawKey = url.searchParams.get("repo");
        const key = resolveKey(rawKey);
        if (key === null) return send(404, { error: noRepo(rawKey) });
        const data = build(windowDays, key);
        const winViews = data.series.reduce((a, r) => a + (r.v ?? 0), 0);
        const single = data.range.days === 1 ? data.series[0] : null;
        const ctx = {
          days: windowDays,
          // 日历跨度会把「今天还没采集到」算成一天；只承诺真正有数据的天数
          span: Math.max(1, Math.min(windowDays, data.range.covered || windowDays)),
          day: single ? single.d : null,
          covered: data.range.covered,
          uniques: single ? single.u : data.totals.uniques,
          views: single ? single.v : winViews,
          external: data.contributions,
          stars: data.repo.stars,
          starGrowth: data.starGrowth,
          npmWeek: data.totals.npmWeek,
          paths: data.paths,
          scope: key === ALL ? `你的 ${targets.length} 个仓库` : key,
        };
        // 数据一同步，旧的摘要就该作废，否则会拿上一版的星数继续讲
        const ck = `${key}|${windowDays}|${data.updatedAt || ""}`;
        const hit = SUM_CACHE.get(ck);
        const now = Date.now();
        if (hit?.val && now - hit.at < 300000) return send(200, hit.val);
        if (!hit?.busy) {
          SUM_CACHE.set(ck, { at: hit?.at || 0, val: hit?.val || null, busy: true });
          if (SUM_CACHE.size > 200) SUM_CACHE.clear();
          aiSummary(ctx)
            .then((r) => SUM_CACHE.set(ck, { at: Date.now(), val: r, busy: false }))
            .catch((e) => {
              console.error("summary failed", key, windowDays, e?.message || e);
              SUM_CACHE.set(ck, { at: hit?.at || 0, val: hit?.val || null, busy: false });
            });
        }
        return send(200, hit?.val || { source: "template", lines: templateSummary(ctx) });
      }
      if (url.pathname === "/api/ask" && req.method === "POST") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        const question = String(body.question || "").trim();
        if (!question) return send(400, { error: "缺少问题" });
        const windowDays = Number(body.days || days);
        const rawKey = body.repo;
        const key = resolveKey(rawKey);
        if (key === null) return send(200, { answer: noRepo(rawKey), source: "data" });
        const data = build(windowDays, key);
        const allData = key === ALL ? null : build(windowDays, ALL);
        // 「有没有没处理的」这类问题不该由模型凭窗口数据猜：窗口外的老 issue 会让它答「都处理了」。
        // 直接读实时清单，答案和链接都来自数据本身。
        if (/未处理|没处理|未回|没回|待处理|待办|没人回|没有回|没合|未合并|没合并/i.test(question)) {
          const op = data.contributions?.open;
          const scope = key === ALL ? `全部 ${targets.length} 个仓库` : key;
          if (!op) return send(200, { answer: `${scope}的未处理清单还没同步到，先刷新一次。`, source: "data" });
          const rows = [
            ...op.issues.map((x) => ({ ...x, kind: "issue" })),
            ...op.pulls.map((x) => ({ ...x, kind: "PR" })),
          ];
          // 一个都别丢：没回的和没合的全都给出链接，不截断成「最新 5 个」
          const links = rows.map((x) => ({
            label: `${(x.repo || "").split("/")[1] || "本仓"} #${x.number} ${x.kind}`,
            url: x.url,
          }));
          const noReply = op.issues.filter((x) => !((x.comments || 0) > 0)).length;
          // 两侧都写出来：问 PR 的时候不能只回 issue 的数
          const head = [
            op.issues.length
              ? (noReply === op.issues.length
                ? `${op.issues.length} 个 issue 没人回`
                : (noReply === 0
                  ? `${op.issues.length} 个 issue 还开着（都有回复）`
                  : `${op.issues.length} 个 issue 还开着（${noReply} 个没人回）`))
              : "没有还开着的 issue",
            op.pulls.length ? `${op.pulls.length} 个 PR 没合` : "没有没合的 PR",
          ].join("，");
          if (!rows.length) {
            // GitHub 的 open_issues_count 含 PR、也含已经回过话的老单，和这份「没人回」清单不是一个口径
            const counter = Number(data.repo?.openIssues || 0);
            const tail = counter ? `（GitHub 计数 ${counter} 个，含 PR 和回过话的老单）` : "";
            return send(200, { answer: `${scope}：没有还开着的 issue，也没有没合的 PR${tail}。`, source: "data" });
          }
          return send(200, { answer: `${scope}：${head}。`, links, source: "data" });
        }
        // 排名类问题直接算，不花几十秒等模型：数据都在手里，答案和链接都准确。
        const num = (x) => Number(x || 0).toLocaleString("en-US");
        const rankBy = (metric) =>
          targets
            .map((t) => {
              const d = build(windowDays, t.key);
              return { key: t.key, name: t.name, v: metric(d) };
            })
            .filter((r) => r.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 3);
        // 「发版后哪个涨得多」里也有「浏览」，别被流量排名抢走
        if (!/发版|发布|版本/.test(question) && /最热|流量最高|浏览最多|哪个(仓库|项目).*(流量|浏览)/.test(question)) {
          const rows = rankBy((d) => d.totals.views);
          if (!rows.length) return send(200, { answer: "这段时间还没有浏览记录。", source: "data" });
          const body = rows.map((r, i) => `${["", "其次 ", "再次 ", "还有 "][Math.min(i, 3)]}${r.name} ${num(r.v)} 次浏览`).join("，");
          const cov = data.range.covered || windowDays;
          const spanTxt = cov < windowDays ? `${cov} 天（图上选了 ${windowDays} 天，其余没数据）` : `${windowDays} 天`;
          const own = key === ALL ? "" : `本仓近 ${spanTxt} ${num(data.totals.views)} 次浏览；全站`;
          return send(200, { answer: `${own || "近 " + windowDays + " 天"}浏览最多：${body}。`, links: rows.map((r) => ({ label: r.name, url: `https://github.com/${r.key}` })), source: "data" });
        }
        if (/访客最多|哪个(仓库|项目).*(访客|人数)/.test(question)) {
          const rows = rankBy((d) => d.totals.uniques);
          if (!rows.length) return send(200, { answer: "这段时间还没有访客记录。", source: "data" });
          const body = rows.map((r, i) => `${["", "其次 ", "再次 ", "还有 "][Math.min(i, 3)]}${r.name} ${num(r.v)} 位访客`).join("，");
          const own = key === ALL ? "" : `本仓 ${num(data.totals.uniques)} 位访客；全站`;
          return send(200, { answer: `${own || "近 " + Math.min(data.range.covered || 14, 14) + " 天"}访客最多：${body}。`, links: rows.map((r) => ({ label: r.name, url: `https://github.com/${r.key}` })), source: "data" });
        }
        if (/star|关注数|收藏/.test(question)) {
          const grown = /涨|增|新|多了|加/.test(question);
          const askWho = /哪个|哪几个|最多|排行|谁/.test(question);
          const sg = data.starGrowth;
          const total = num(data.repo?.stars ?? 0);
          const delta = sg && sg.delta != null ? `近 ${sg.span} 天 ${sg.delta > 0 ? "+" : ""}${num(sg.delta)} 个` : "";
          // 面板已经选了某个仓，就先答这个仓，不拿全站排名冒充它
          if (key !== ALL) {
            return send(200, {
              answer: `${key} 现在 ${total} 个 star${delta ? "，" + delta : ""}。`,
              links: [{ label: key, url: `https://github.com/${key}` }],
              source: "data",
            });
          }
          if (askWho && grown) {
            const rows = rankBy((d) => d.starGrowth?.delta ?? 0);
            if (!rows.length) return send(200, { answer: `近 ${windowDays} 天没有仓库涨 star（有 star 记录的只有 ${data.range.covered || windowDays} 天）。`, source: "data" });
            const body = rows.map((r, i) => `${["", "其次 ", "再次 ", "还有 "][Math.min(i, 3)]}${r.name} +${num(r.v)}`).join("，");
            return send(200, {
              answer: `全站近 ${sg?.span ?? windowDays} 天新增 ${num(sg?.delta ?? 0)} 个 star，涨得最多：${body}。`,
              links: rows.map((r) => ({ label: r.name, url: `https://github.com/${r.key}` })),
              source: "data",
            });
          }
          if (askWho) {
            const rows = rankBy((d) => d.repo?.stars ?? 0);
            if (!rows.length) return send(200, { answer: "还没有 star 记录。", source: "data" });
            const body = rows.map((r, i) => `${["", "其次 ", "再次 ", "还有 "][Math.min(i, 3)]}${r.name} ${num(r.v)}`).join("，");
            return send(200, {
              answer: `全站现在共 ${total} 个 star，总数最多：${body}。`,
              links: rows.map((r) => ({ label: r.name, url: `https://github.com/${r.key}` })),
              source: "data",
            });
          }
          return send(200, { answer: `全站现在共 ${total} 个 star${delta ? "，" + delta : ""}。`, source: "data" });
        }
        if (/npm|下载/.test(question)) {
          if (key !== ALL) {
            const w = data.totals.npmWeek;
            return send(200, {
              answer: w ? `${key} 近 7 天 npm 下载 ${num(w)} 次。` : `${key} 没有关联 npm 包。`,
              links: [{ label: key, url: `https://github.com/${key}` }],
              source: "data",
            });
          }
          const rows = rankBy((d) => d.totals.npmWeek);
          if (!rows.length) return send(200, { answer: "没有关联 npm 的仓库。", source: "data" });
          const body = rows.map((r, i) => `${["", "其次 ", "再次 ", "还有 "][Math.min(i, 3)]}${r.name} 周下载 ${num(r.v)}`).join("，");
          return send(200, { answer: `全站 npm 周下载最多：${body}。`, links: rows.map((r) => ({ label: r.name, url: `https://github.com/${r.key}` })), source: "data" });
        }
        if (/发版|发布.*(效果|影响)|涨了多少/.test(question)) {
          if (key !== ALL) {
            const it = data.impact;
            if (!it || it.before?.views?.avg == null) return send(200, { answer: `${key} 近期的发版还看不出效果。`, source: "data" });
            const b = Math.round(it.before.views.avg * 10) / 10, a = Math.round((it.after?.views?.avg ?? 0) * 10) / 10;
            const pct = it.delta?.views != null ? `${it.delta.views >= 0 ? "+" : ""}${Math.round(it.delta.views)}%` : "";
            // 前后窗口不一定等长（默认前 7 天、后 3 天），写出来才不会被当同期对比
            const bd = it.before?.days, ad = it.after?.days;
            const win = bd && ad && bd !== ad ? `（前 ${bd} 天 vs 后 ${ad} 天）` : "";
            return send(200, {
              answer: `${key} ${String(it.version).replace(/^v/i, "")} 发版前后，浏览日均 ${num(b)} → ${num(a)}${pct ? "（" + pct + "）" : ""}${win}。`,
              links: [{ label: key, url: `https://github.com/${key}` }],
              source: "data",
            });
          }
          // 基线太小的仓，倍数只是噪声（0.3 → 12 也是 ×39），低于日均 5 次浏览的不参与排名
          const rows = rankBy((d) => ((d.impact?.before?.views?.avg ?? 0) >= 5 ? (d.impact?.delta?.views ?? 0) : 0));
          if (!rows.length) return send(200, { answer: "近期的发版还看不出效果。", source: "data" });
          const body = rows
            .map((r, i) => {
              const im = data.impacts.find((x) => x.key === r.key);
              const b = im?.before?.views?.avg, a = im?.after?.views?.avg;
              const pair = b != null && a != null ? ` ${num(Math.round(b * 10) / 10)} → ${num(Math.round(a * 10) / 10)}` : "";
              return `${["", "其次 ", "再次 ", "还有 "][Math.min(i, 3)]}${r.name}${pair}`;
            })
            .join("，");
          // 排名口径写在答案里：按浏览日均涨幅、日均不到 5 次的不参与、前后窗口不等长
          const im0 = data.impacts.find((x) => x.before?.days && x.after?.days);
          const relWin = im0 && im0.before.days !== im0.after.days ? `；前 ${im0.before.days} 天 vs 后 ${im0.after.days} 天` : "";
          return send(200, { answer: `全站发版后浏览涨得最多：${body}。（按发版前后浏览日均的涨幅排，日均不到 5 次的不参与${relWin}）`, links: rows.map((r) => ({ label: r.name, url: `https://github.com/${r.key}` })), source: "data" });
        }
        const topRepos = key === ALL ? null : targets
          .map((t) => ({ name: t.name, u: repoStore(store, t.key).meta?.views?.uniques ?? 0 }))
          .sort((a, b) => b.u - a.u)
          .slice(0, 5);
        const ans = await askQuestion(
          {
            allTotal: allData ? allData.totals.uniques : null,
            topRepos,
            days: windowDays,
            covered: data.range.covered,
            uniques: data.totals.uniques,
            views: data.totals.views,
            external: data.contributions,
            impact: data.impact,
            funnel: data.funnel,
            impacts: data.impacts,
            stars: data.repo.stars,
            starGrowth: data.starGrowth,
            npmWeek: data.totals.npmWeek,
            paths: data.paths,
            scope: key === ALL ? `你的 ${targets.length} 个仓库` : key,
          },
          question,
          [
            {
              name: "traffic",
              description: "查一段时间内某个仓库或全部仓库的访客、浏览、外部 issue/PR、stars、npm 周下载",
              parameters: { type: "object", properties: { days: { type: "integer", description: "7、30 或 90" }, repo: { type: "string", description: "owner/name，不填就是当前面板范围" } } },
              run: ({ days: d, repo }) => {
                const dd = [7, 30, 90].includes(Number(d)) ? Number(d) : windowDays;
                const k2 = repo && targets.some((t) => t.key === repo) ? repo : key;
                const data = build(dd, k2);
                return {
                  scope: k2 === ALL ? "全部仓库" : k2,
                  days: dd,
                  covered: data.range.covered,
                  visitors: data.totals.uniques,
                  views: data.totals.views,
                  issues: data.contributions.issues.length,
                  pulls: data.contributions.pulls.length,
                  openIssues: data.contributions.open?.issues?.length ?? null,
                  openPulls: data.contributions.open?.pulls?.length ?? null,
                  contribAt: data.contributions.at || null,
                  stars: data.repo.stars,
                  starGrowth: data.starGrowth,
                  npmWeek: data.totals.npmWeek,
                  impact: data.impact,
                  topPaths: data.paths.slice(0, 3),
                };
              },
            },
            { name: "list_repos", description: "列出看板绑定的所有仓库", parameters: { type: "object", properties: {} }, run: () => targets.map((t) => t.key) },
            {
              name: "daily",
              description: "按天查浏览/访客曲线，用来回答哪天下滑或上涨",
              parameters: { type: "object", properties: { days: { type: "integer", description: "7、30 或 90" }, repo: { type: "string", description: "owner/name，不填就是当前面板范围" } } },
              run: ({ days: d, repo }) => {
                const dd = [7, 30, 90].includes(Number(d)) ? Number(d) : windowDays;
                const k2 = repo && targets.some((t) => t.key === repo) ? repo : key;
                return build(dd, k2).series.map((r) => `${r.d.slice(5)} 浏览${r.v ?? 0} 访客${r.u ?? 0}`).join("，")
                  + "（访客是当天去重人数，加起来会大于整段去重人数；最后一天常是当天，还没同步完，别当成下滑）";
              },
            },
            {
              name: "activity",
              description: "查外部 issue 和 PR 的明细：编号、标题、作者、状态、是否合并、时间、链接",
              parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name，不填就是当前面板范围" } } },
              run: ({ repo }) => {
                const k2 = repo && targets.some((t) => t.key === repo) ? repo : key;
                const d = build(windowDays, k2).contributions;
                const pick = (x, kind) => ({ kind, n: x.number, title: x.title, by: x.author, state: x.merged ? "merged" : x.state, at: x.mergedAt || x.closedAt || x.createdAt, url: x.url });
                const all = [...d.pulls.map((x) => pick(x, "PR")), ...d.issues.map((x) => pick(x, "issue"))];
                // 还开着/没合的单子可能落在窗口外，明细里必须带上，不然模型只能报个数
                const openItems = [
                  ...(d.open?.pulls || []).map((x) => ({ ...pick(x, "PR"), repo: x.repo, comments: x.comments ?? 0 })),
                  ...(d.open?.issues || []).map((x) => ({ ...pick(x, "issue"), repo: x.repo, comments: x.comments ?? 0 })),
                ];
                return {
                  total: all.length,
                  open: { issues: d.open?.issues?.length ?? null, pulls: d.open?.pulls?.length ?? null },
                  openItems: openItems.slice(0, 30),
                  items: all.slice(0, 30),
                };
              },
            },
            {
              name: "sync",
              description: "实时拉一次某个仓库的最新流量，几秒",
              parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name" } }, required: ["repo"] },
              run: async ({ repo }) => {
                const t = targets.find((x) => x.key === repo);
                if (!t) return "没有这个仓库";
                await syncOne(t);
                const s2 = repoStore(store, t.key);
                return { repo: t.key, syncedAt: s2.meta?.syncedAt, visitors: s2.meta?.views?.uniques, error: s2.meta?.error || null };
              },
            },
          ],
        );
        return send(200, ans);
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
    syncContribs,
    build,
    listen(port = 4317, host = "127.0.0.1") {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
  };
}
