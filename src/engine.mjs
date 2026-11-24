import { normalizeConfig, parseRepo } from "./config-core.mjs";
import { makeGithub } from "./github.mjs";
import { makeNpm } from "./npm.mjs";
import { emptyStore, repoStore, mergeTraffic, mergeNpm, mergeStars, series, storedDays } from "./store-core.mjs";

// 全站聚合用的 key；单仓 key 是 owner/name，不会撞
export const ALL = "all";

// 时间字段会缺（npm 版本拿不到发布时间、fork 没 createdAt）：排序一律字符串兜底，
// 缺字段的排到最后，别让 undefined.at 把整块数据炸掉
const byAtDesc = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));
const byUpdatedDesc = (a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));

// 看板的全部抓取与聚合都收在这里：不碰 node 内置模块、不读盘、不读 process。
// store 由调用方给（引擎就地改，要落盘时回调 save(store)，没有 save 也不报错）；
// cfg 只认传进来的字段，token 已经在外面解析好放进 cfg.token。
export function makeEngine({ store: storeIn, save, cfg: cfgIn, repos, days = 7 } = {}) {
  let cfg = cfgIn || {};
  let store = storeIn || emptyStore();
  const persist = () => {
    if (typeof save === "function") save(store);
  };
  const list = repos || normalizeConfig(cfg).repos || [];
  const buildTargets = (rows, token) =>
    rows.map((r) => {
      const item = typeof r === "string" ? { repo: r } : r;
      const { owner, name } = parseRepo(item.repo);
      const npmPkg = item.npm || name;
      return { key: `${owner}/${name}`, owner, name, npmPkg, npmExplicit: Boolean(item.npm), gh: makeGithub(token, { owner, name }), npm: makeNpm(npmPkg) };
    });
  let targets = buildTargets(list, String(cfg.token || ""));
  let self = [...new Set([cfg.user, ...(cfg.selfLogins || [])].filter(Boolean))];
  // 绑完账号立刻换成新 token、新仓库列表和新 store，不用重启进程。
  // next 形状：{ cfg?, store? }；只给一份 cfg 也认，两个都不给就按当前 cfg 重算。
  function reload(next) {
    if (next && (next.cfg || next.store)) {
      if (next.cfg) cfg = next.cfg;
      if (next.store) store = next.store;
    } else if (next) {
      cfg = next;
    }
    targets = buildTargets(normalizeConfig(cfg).repos || [], String(cfg.token || ""));
    self = [...new Set([cfg.user, ...(cfg.selfLogins || [])].filter(Boolean))];
    return targets.length;
  }
  let lastSync = null;
  let syncProgress = { running: false, done: 0, total: 0 };

  async function syncOne(t) {
    const s = repoStore(store, t.key);
    // 匿名时只砍注定失败的那些：traffic 四路要 push 权限、alerts 三路要安全扫描权限，
    // 一定 401/403（还会各自重试退避），7 个请求全是白花的——额度留给真能取到数的接口。
    // activity/openWork/releases/stargazers/forks 是公开读，匿名照样有数据，不能砍。
    const authed = Boolean(cfg.token);
    const hasContrib = Boolean(s.meta?.activity || s.meta?.openWork);
    const [views, clones, paths, referrers, repoInfo, releases, activity, alerts, openWork, starDates, forkList] = await Promise.all([
      authed ? t.gh.views().catch(() => null) : null,
      authed ? t.gh.clones().catch(() => null) : null,
      authed ? t.gh.paths().catch(() => null) : null,
      authed ? t.gh.referrers().catch(() => null) : null,
      t.gh.repo().catch(() => null),
      t.gh.releases().catch(() => null),
      // 匿名下贡献只在第一次（还没有快照时）取：之后由 15 分钟的高频通道维护，
      // 60 次/小时的额度不允许每轮把 issue/PR 列表再翻一遍
      authed || !hasContrib ? t.gh.activity(new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), self).catch(() => null) : null,
      authed ? t.gh.alerts().catch(() => null) : null,
      authed || !hasContrib ? t.gh.openWork(self).catch(() => null) : null,
      t.gh.stargazers().catch(() => null),
      t.gh.forks().catch(() => null),
    ]);
    if (views || clones) mergeTraffic(s, views, clones);
    if (starDates) mergeStars(s, starDates);
    // 仓库名当包名只是默认猜测：先看 registry 的维护者，同名别人的包不算自己的下载
    let npmOk = true;
    if (!t.npmExplicit) {
      const own = await t.npm.maintainers().catch(() => null);
      npmOk = own?.missing ? false : (!own || !own.owners.length || own.owners.includes(t.owner.toLowerCase()));
      if (!npmOk) {
        s.npm = {};
        delete s.meta.npmWeek;
        delete s.meta.npmVers;
      }
    }
    s.meta.npmOwned = npmOk;
    let published = null;
    if (npmOk) {
      // npm registry 的几个接口互相独立，一起发比排队快一半
      const [npmRange, week, pub] = await Promise.all([
        t.npm.range(new Date(Date.now() - 400 * 864e5), new Date()).catch(() => null),
        t.npm.week().catch(() => null),
        t.npm.versions().catch(() => null),
      ]);
      if (Array.isArray(npmRange)) mergeNpm(s, npmRange);
      if (Number.isFinite(week)) s.meta.npmWeek = week;
      published = pub;
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
    // 版本时间线只来自 registry 的 time 表：逐版本下载端点已经不可用
    if (Array.isArray(published) && published.length) {
      s.meta.npmVers = published.map((v) => ({ v: v.version, at: v.at, url: null }));
    }
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
      persist();
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
    persist();
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
      // 和 store.series 同一套落点：当天那格全 0 是还没结算，别把它当「这一天没人来」
      const settled = (d) => slices.some(({ s }) => ["v", "u", "c", "cu"].some((f) => Number(s.days?.[d]?.[f]) > 0));
      let k = pick(1);
      if (!slices.some(({ s }) => s.days?.[k])) k = pick(2);
      else if (!settled(k)) k = [2, 3, 4].map(pick).find(settled) || k;
      const cell = { d: k, v: null, u: null, c: null, cu: null, n: null };
      for (const { s } of slices) {
        const row = s.days?.[k];
        // 下载逐日存在 s.npm 里，不在 s.days 那格：少读这一路，单日窗口永远没有下载数
        const npmDay = s.npm?.[k] ?? row?.n;
        if (npmDay != null) cell.n = (cell.n ?? 0) + npmDay;
        if (!row) continue;
        for (const kk of ["v", "u", "c", "cu"]) if (row[kk] != null) cell[kk] = (cell[kk] ?? 0) + row[kk];
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
        // npm 逐日是按窗口存的，npmWeek 是固定的 7 天滚动值：KPI 要用前者才跟得上范围
        npm: rows.some((x) => x.n != null) ? rows.reduce((a, x) => a + (x.n ?? 0), 0) : null,
        npmWeek: sumOf((s) => s.meta?.npmWeek),
      },
      repos: targets
        .map((t) => {
          const r = repoStore(store, t.key);
          // 1 天窗口各仓必须报同一个日历日，否则排行里的下载量和上面那行对不上
          const day1 = windowDays === 1 ? rows[0]?.d : null;
          const w = day1
            ? [{ d: day1, v: r.days?.[day1]?.v ?? null, u: r.days?.[day1]?.u ?? null, n: r.npm?.[day1] ?? r.days?.[day1]?.n ?? null }]
            : series(r, windowDays, r.npm || {});
          // 单日窗口就按那一天算：这个仓那天没有浏览数据时不能退回到它自己的第一天，
          // 否则「近 1 天」里塞进一个月的涨星
          const sg = starGrowthOf(
            day1 || [w.find((x) => x.v != null || x.u != null)?.d || "", firstDay(r) || ""].sort().at(-1) || null,
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
        // 漏斗是一段固定 14 天的转化：下载也取同一段，混进 7 天的周汇总会让后面两级对不上
        npm: (() => {
          const ds = last14Days(funnelEnd());
          return ds.length ? slices.reduce((acc, { s }) => acc + ds.reduce((b, d) => b + (s.npm?.[d] ?? 0), 0), 0) : null;
        })(),
      },
      impacts: windowDays < 7 ? [] : slices
        .map(({ t, s }) => {
          const im = impactOf(s);
          return im && im.before?.views?.avg ? { key: t.key, name: t.key.split("/")[1] || t.key, ...im } : null;
        })
        .filter((x) => x && x.at >= rows[0]?.d)
        .sort((a, b) => (a.limited === b.limited ? byAtDesc(a, b) : a.limited ? 1 : -1)),
      paths: [...paths.values()].sort((a, b) => b.n - a.n),
      referrers: [...referrers.values()].sort((a, b) => b.n - a.n),
      forks: (() => {
        const items = slices
          .flatMap(({ t, s }) => (s.meta?.forks?.items || [])
            .filter(inWindow(fw.from, fw.to))
            .map((x) => ({ ...x, repo: t.key })))
          .sort(byAtDesc);
        const latest = slices
          .flatMap(({ t, s }) => (s.meta?.forks?.items || []).map((x) => ({ ...x, repo: t.key })))
          .sort(byAtDesc)[0] || null;
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
      releases: releases.sort(byAtDesc).slice(0, 120),
      impact: windowDays < 7 ? null : (() => {
        // 主卡也要带上仓名，否则只有一个版本号，看不出是哪个仓
        const all = slices.map(({ t, s }) => {
          const im = impactOf(s);
          return im && im.before?.views ? { key: t.key, name: t.key.split("/")[1] || t.key, ...im } : null;
        }).filter((x) => x && x.at >= rows[0]?.d);
        const ok = all.filter((x) => !x.limited).sort(byAtDesc);
        return ok[0] || [...all].sort(byAtDesc)[0] || null;
      })(),
      contributions: {
        issues: issues.filter(inWindow(rows[0]?.d, rows.at(-1)?.d)),
        pulls: pulls.filter(inWindow(rows[0]?.d, rows.at(-1)?.d)),
        open: {
          issues: slices.flatMap(({ t, s }) => (s.meta?.openWork?.issues || []).map((x) => ({ ...x, repo: t.key }))).sort(byUpdatedDesc),
          pulls: slices.flatMap(({ t, s }) => (s.meta?.openWork?.pulls || []).map((x) => ({ ...x, repo: t.key }))).sort(byUpdatedDesc),
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
    cuts.sort(byAtDesc);
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
    const funnelEnd = () => {
      const t = new Date();
      t.setUTCHours(0, 0, 0, 0);
      t.setUTCDate(t.getUTCDate() - 1);
      return t.toISOString().slice(0, 10);
    };
    const sum14 = () => {
      const ds = last14Days(funnelEnd());
      return ds.length ? ds.reduce((b, d) => b + (s.days?.[d]?.v ?? 0), 0) : null;
    };
    const meta = s.meta || {};
    const views = meta.views || {};
    const clones = meta.clones || {};
    return {
      repo: { owner: t.owner, name: t.name, npmPkg: meta.npmOwned === false ? null : t.npmPkg, ...(meta.repo || {}) },
      range: { days: windowDays, from: rows[0]?.d, to: rows.at(-1)?.d, storedDays: storedDays(s), covered: coveredDays(s), first: firstDay(s) },
      series: rows,
      totals: {
        views: rows.reduce((a, x) => a + (x.v ?? 0), 0),
        uniques: views.uniques ?? null,
        clones: rows.reduce((a, x) => a + (x.c ?? 0), 0),
        cloneUniques: clones.uniques ?? null,
        npm: rows.some((x) => x.n != null) ? rows.reduce((a, x) => a + (x.n ?? 0), 0) : null,
        npmWeek: meta.npmWeek ?? null,
      },
      paths: meta.paths || [],
      funnel: {
        views: sum14(),
        home: (meta.paths || []).filter((p) => p.p === "仓库主页").reduce((a, p) => a + (p.n || 0), 0) || null,
        npm: (() => {
          const ds = last14Days(funnelEnd());
          return ds.length ? ds.reduce((b, d) => b + (s.npm?.[d] ?? 0), 0) : null;
        })(),
      },
      starGrowth: clampSpan(starGrowthOf(
        // 单日窗口就锁在那一天：这个仓那天没有流量行时退回自己的第一天，
        // 会把一个月的涨星塞进「近 1 天」
        windowDays === 1
          ? (rows[0]?.d || null)
          : ([rows.find((r) => r.v != null || r.u != null)?.d || "", firstDay(s) || ""].sort().at(-1) || null),
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

  function build(windowDays = days, key = ALL) {
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

  return {
    get cfg() { return cfg; },
    get targets() { return targets; },
    get store() { return store; },
    get lastSync() { return lastSync; },
    days,
    ALL,
    sync,
    syncOne,
    syncContribs,
    refreshContrib,
    build,
    repoRows,
    // 同步进度（/api/progress 用）：{ running, done, total, startedAt? }
    progress: () => ({ ...syncProgress }),
    reload,
    count: () => targets.length,
    resolveKey,
    noRepo,
  };
}
