(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/engine.mjs
  var engine_exports = {};
  __export(engine_exports, {
    ALL: () => ALL,
    makeEngine: () => makeEngine
  });

  // src/config-core.mjs
  function parseRepo(spec) {
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(spec || "").trim());
    if (!m) throw new Error(`\u4ED3\u5E93\u5199\u6CD5\u5E94\u4E3A owner/repo\uFF0C\u6536\u5230\uFF1A${spec}`);
    return { owner: m[1], name: m[2] };
  }
  function normalizeConfig(raw = {}) {
    const cfg = { ...raw };
    let repos = cfg.repos;
    if (!Array.isArray(repos) || !repos.length) {
      repos = cfg.repo ? [{ repo: cfg.repo, npm: cfg.npm }] : [];
    }
    cfg.repos = repos.map((r) => typeof r === "string" ? { repo: r } : r).filter((r) => r && r.repo).map((r) => {
      const { owner, name } = parseRepo(r.repo);
      return { repo: `${owner}/${name}`, ...r.npm ? { npm: r.npm } : {} };
    });
    if (!cfg.user && cfg.repos.length) cfg.user = cfg.repos[0].repo.split("/")[0];
    return cfg;
  }

  // src/github.mjs
  var API = "https://api.github.com";
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function makeGithub(token, { owner, name }) {
    async function gh(path, { method = "GET", body, accept } = {}) {
      var _a;
      for (let attempt = 0; ; attempt++) {
        const res = await once(path, { method, body, accept });
        const limited = res.status === 429 || res.status === 403;
        if (!limited) return res.data;
        if (method !== "GET" || attempt >= 2) throw res.err;
        await sleep(Math.min((_a = res.retryAfter) != null ? _a : 800 * (attempt + 1), 3e3));
      }
    }
    async function once(path, { method, body, accept }) {
      const res = await fetch(API + path, {
        method,
        headers: {
          accept: accept || "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "github-overview",
          ...token ? { authorization: `Bearer ${token}` } : {},
          ...body ? { "content-type": "application/json" } : {}
        },
        body: body ? JSON.stringify(body) : void 0
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const err = new Error(`${method} ${path} \u2192 ${res.status} ${(data == null ? void 0 : data.message) || ""}`.trim());
        err.status = res.status;
        const ra = Number(res.headers.get("retry-after"));
        const exhaust = res.headers.get("x-ratelimit-remaining") === "0";
        if (!(res.status === 429 || res.status === 403)) throw err;
        if (!Number.isFinite(ra) && !exhaust) throw err;
        err.retryAfter = Number.isFinite(ra) ? Math.max(ra * 1e3, 250) : 1500;
        return { data: null, status: res.status, retryAfter: err.retryAfter, err };
      }
      return { data, status: res.status };
    }
    const repoPath = `/repos/${owner}/${name}`;
    async function listPages(path, stop) {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const rows = await gh(`${path}${path.includes("?") ? "&" : "?"}page=${page}`).catch(() => null);
        if (!rows) return page === 1 ? null : out;
        if (!rows.length) break;
        out.push(...rows);
        if (rows.length < 100 || stop && stop(rows.at(-1))) break;
      }
      return out;
    }
    return {
      owner,
      name,
      gh,
      async repo() {
        const r = await gh(repoPath);
        return {
          owner,
          name,
          fullName: r.full_name,
          stars: r.stargazers_count,
          forks: r.forks_count,
          watchers: r.subscribers_count,
          openIssues: r.open_issues_count,
          createdAt: r.created_at,
          pushedAt: r.pushed_at,
          htmlUrl: r.html_url,
          description: r.description || ""
        };
      },
      // 星标历史：带 star+json 才回 starred_at，据此算任意窗口的净增
      // 列表按加星时间从早到晚，翻页上限 10 页就是 1000 条；星多的仓只有翻到最后几页
      // 才拿得到最近的加星，否则窗口净增会少算成 0
      async stargazers() {
        var _a;
        const grab = async (page) => {
          const rows = await gh(`${repoPath}/stargazers?per_page=100&page=${page}`, { accept: "application/vnd.github.star+json" });
          return Array.isArray(rows) ? rows : [];
        };
        const first = await grab(1);
        const total = first.length < 100 ? first.length : ((_a = await gh(repoPath).catch(() => null)) == null ? void 0 : _a.stargazers_count) || 1e3;
        const pages = Math.max(1, Math.ceil(total / 100));
        const from = Math.max(1, pages - 9);
        const all = from === 1 ? [first] : [];
        for (let page = from === 1 ? 2 : from; page <= pages; page++) all.push(await grab(page));
        const out = [];
        for (const rows of all) for (const r of rows) if (r.starred_at) out.push(String(r.starred_at).slice(0, 10));
        return out.sort();
      },
      // traffic endpoints need push access, and only keep 14 rolling days
      async views() {
        return gh(`${repoPath}/traffic/views?per=day`);
      },
      async clones() {
        return gh(`${repoPath}/traffic/clones?per=day`);
      },
      async referrers() {
        return gh(`${repoPath}/traffic/popular/referrers`);
      },
      async paths() {
        return gh(`${repoPath}/traffic/popular/paths`);
      },
      async releases() {
        return gh(`${repoPath}/releases?per_page=100`);
      },
      // fork 自带创建时间：只取最新一页就够判断「最近有没有人 fork」
      async forks() {
        const rows = await gh(`${repoPath}/forks?per_page=100&sort=newest`);
        if (!Array.isArray(rows)) return null;
        return rows.map((r) => {
          var _a;
          return { login: ((_a = r.owner) == null ? void 0 : _a.login) || "ghost", at: r.created_at, url: r.html_url };
        }).filter((r) => r.at).sort((x, y) => String(y.at).localeCompare(String(x.at)));
      },
      // external-only: everything not authored by the repo owner (or self aliases)
      // 用 REST 列表而不是 search：search 有索引延迟，刚合并/关闭的状态要十几分钟才可见
      // 真的没处理的活：还开着的 issue（含已经有过回复的）、还没合的 PR。
      // 不能从 activity 窗口里筛——窗口外的老 issue 会让概览谎报「都已回复」
      async openWork(selfLogins = []) {
        const self = /* @__PURE__ */ new Set([owner.toLowerCase(), ...selfLogins.map((x) => String(x).toLowerCase())]);
        const [issueRows, pullRows] = await Promise.all([
          listPages(`${repoPath}/issues?state=open&per_page=100`),
          listPages(`${repoPath}/pulls?state=open&per_page=100`)
        ]);
        if (!issueRows || !pullRows) return null;
        const out = { issues: [], pulls: [], at: (/* @__PURE__ */ new Date()).toISOString() };
        const norm = (it, comments) => {
          var _a, _b;
          const author = ((_a = it.user) == null ? void 0 : _a.login) || "ghost";
          if (((_b = it.user) == null ? void 0 : _b.type) === "Bot" || author.endsWith("[bot]")) return null;
          if (self.has(author.toLowerCase())) return null;
          return {
            number: it.number,
            title: it.title || "",
            author,
            comments: comments != null ? comments : 0,
            createdAt: it.created_at,
            updatedAt: it.updated_at,
            url: it.html_url
          };
        };
        for (const it of issueRows || []) {
          if (it.pull_request) continue;
          const row = norm(it, it.comments);
          if (row) out.issues.push(row);
        }
        for (const pr of pullRows || []) {
          const row = norm(pr, pr.comments);
          if (row) out.pulls.push(row);
        }
        const byNew = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
        out.issues.sort(byNew);
        out.pulls.sort(byNew);
        return out;
      },
      async activity(sinceIso, selfLogins = []) {
        const self = /* @__PURE__ */ new Set([owner.toLowerCase(), ...selfLogins.map((s) => String(s).toLowerCase())]);
        const out = { issues: [], pulls: [], selfCount: 0 };
        const byAuthor = (it) => {
          var _a, _b;
          const author = ((_a = it.user) == null ? void 0 : _a.login) || "ghost";
          if (((_b = it.user) == null ? void 0 : _b.type) === "Bot" || author.endsWith("[bot]")) {
            out.botCount = (out.botCount || 0) + 1;
            return null;
          }
          if (self.has(author.toLowerCase())) {
            out.selfCount++;
            return null;
          }
          return author;
        };
        const [issueRows, pullRows] = await Promise.all([
          listPages(`${repoPath}/issues?state=all&since=${sinceIso}&per_page=100&sort=updated&direction=desc`),
          listPages(`${repoPath}/pulls?state=all&sort=updated&direction=desc&per_page=100`, (last) => String(last.updated_at || last.created_at || "").slice(0, 10) < sinceIso)
        ]);
        if (!issueRows || !pullRows) return null;
        for (const it of issueRows || []) {
          if (it.pull_request) continue;
          const author = byAuthor(it);
          if (!author) continue;
          out.issues.push({
            number: it.number,
            title: it.title,
            author,
            state: it.state,
            createdAt: it.created_at,
            closedAt: it.closed_at,
            comments: it.comments,
            url: it.html_url
          });
        }
        for (const pr of pullRows || []) {
          const updated = String(pr.updated_at || pr.created_at || "").slice(0, 10);
          if (sinceIso && updated && updated < sinceIso) continue;
          const author = byAuthor(pr);
          if (!author) continue;
          out.pulls.push({
            number: pr.number,
            title: pr.title,
            author,
            state: pr.state,
            createdAt: pr.created_at,
            closedAt: pr.closed_at,
            merged: Boolean(pr.merged_at),
            mergedAt: pr.merged_at || null,
            comments: pr.comments,
            url: pr.html_url
          });
        }
        return out;
      },
      async alerts() {
        const probe = async (path) => {
          var _a;
          try {
            const rows = await gh(`${path}?state=open&per_page=100`);
            return { available: true, open: Array.isArray(rows) ? rows.length : 0 };
          } catch (e) {
            const reason = e.status === 404 ? "unsupported" : e.status === 403 ? "permission_denied" : "error";
            return { available: false, open: null, reason, status: (_a = e.status) != null ? _a : null };
          }
        };
        const [dependabot, codeScanning, secretScanning] = await Promise.all([
          probe(`${repoPath}/dependabot/alerts`),
          probe(`${repoPath}/code-scanning/alerts`),
          probe(`${repoPath}/secret-scanning/alerts`)
        ]);
        return { dependabot, codeScanning, secretScanning };
      }
    };
  }

  // src/npm.mjs
  var POINT = "https://api.npmjs.org/downloads/point";
  var RANGE = "https://api.npmjs.org/downloads/range";
  var REGISTRY = "https://registry.npmjs.org";
  var day = (d) => d.toISOString().slice(0, 10);
  async function getJson(url) {
    const res = await fetch(url, { headers: { "user-agent": "github-overview" } });
    if (!res.ok) {
      const e = new Error(`npm ${url} \u2192 ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }
  function makeNpm(pkg) {
    const safe = encodeURIComponent(pkg);
    return {
      pkg,
      // 仓库名不等于 npm 包名时，先确认包归谁，别把同名包算进来
      async maintainers() {
        try {
          const meta = await getJson(`${REGISTRY}/${safe}/latest`);
          return { owners: (meta.maintainers || []).map((m) => String(m.name || "").toLowerCase()), version: meta.version || null };
        } catch (e) {
          if (e.status === 404) return { missing: true };
          return null;
        }
      },
      async week() {
        var _a;
        try {
          return (_a = (await getJson(`${POINT}/last-week/${safe}`)).downloads) != null ? _a : null;
        } catch {
          return null;
        }
      },
      // range keeps ~18 months; anything older has no daily series
      async range(fromIso, toIso) {
        try {
          const data = await getJson(`${RANGE}/${day(new Date(fromIso))}:${day(new Date(toIso))}/${safe}`);
          return (data.downloads || []).map((r) => ({ d: r.day, n: r.downloads }));
        } catch (e) {
          return { error: e.status || 0, rows: [] };
        }
      },
      async versions() {
        try {
          const meta = await getJson(`${REGISTRY}/${safe}`);
          const times = meta.time || {};
          return Object.keys(times).filter((v) => !["created", "modified"].includes(v)).map((v) => ({ version: v, at: times[v] })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
        } catch {
          return [];
        }
      }
      // 曾有 perVersion(): 按版本查 last-week 下载。上游现在对 `pkg@ver` 一律回
      // {"error":"package x@1.2.3 not found"}，那条腿永远只能是空数组，已删除。
      // 需要逐版本时间线就用 versions()，它读 registry 文档里的 time 表。
    };
  }

  // src/store-core.mjs
  var emptySlice = () => ({ days: {}, npm: {}, releases: [], meta: {}, stars: [] });
  var emptyStore = () => ({ version: 2, repos: {} });
  function repoStore(store, key) {
    if (!store.repos[key]) store.repos[key] = emptySlice();
    const s = store.repos[key];
    if (!Array.isArray(s.stars)) s.stars = [];
    return s;
  }
  function mergeStars(slice, dates) {
    if (!Array.isArray(dates) || !dates.length) return slice;
    slice.stars = dates.filter(Boolean).map((d) => String(d).slice(0, 10)).sort();
    return slice;
  }
  var keyOf = (iso) => String(iso).slice(0, 10);
  function mergeTraffic(slice, views, clones) {
    var _a, _b, _c, _d;
    const rows = [...(views == null ? void 0 : views.views) || [], ...(clones == null ? void 0 : clones.clones) || []];
    for (const v of (views == null ? void 0 : views.views) || []) {
      const k = keyOf(v.timestamp);
      slice.days[k] = { ...slice.days[k] || {}, d: k, v: v.count, u: v.uniques };
    }
    for (const c of (clones == null ? void 0 : clones.clones) || []) {
      const k = keyOf(c.timestamp);
      slice.days[k] = { ...slice.days[k] || {}, d: k, c: c.count, cu: c.uniques };
    }
    slice.meta.views = { total: (_a = views == null ? void 0 : views.count) != null ? _a : null, uniques: (_b = views == null ? void 0 : views.uniques) != null ? _b : null, at: (/* @__PURE__ */ new Date()).toISOString() };
    slice.meta.clones = { total: (_c = clones == null ? void 0 : clones.count) != null ? _c : null, uniques: (_d = clones == null ? void 0 : clones.uniques) != null ? _d : null, at: (/* @__PURE__ */ new Date()).toISOString() };
    return { slice, rows: rows.length };
  }
  function mergeNpm(slice, daily) {
    if (!Array.isArray(daily)) return slice;
    for (const r of daily) slice.npm[r.d] = r.n;
    return slice;
  }
  function series(slice, days, npmDaily = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    const out = [];
    const today = /* @__PURE__ */ new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (days === 1) {
      const pick = (back) => {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - back);
        return d.toISOString().slice(0, 10);
      };
      const settled = (row2) => row2 && ["v", "u", "c", "cu"].some((f) => Number(row2[f]) > 0);
      let k = pick(1);
      if (!slice.days[k]) k = pick(2);
      else if (!settled(slice.days[k])) {
        for (const back of [2, 3, 4]) {
          if (settled(slice.days[pick(back)])) {
            k = pick(back);
            break;
          }
        }
      }
      const row = slice.days[k] || {};
      return [{ d: k, v: (_a = row.v) != null ? _a : null, u: (_b = row.u) != null ? _b : null, c: (_c = row.c) != null ? _c : null, cu: (_d = row.cu) != null ? _d : null, n: (_g = (_f = npmDaily[k]) != null ? _f : (_e = slice.npm) == null ? void 0 : _e[k]) != null ? _g : null }];
    }
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const k = d.toISOString().slice(0, 10);
      const row = slice.days[k] || {};
      out.push({
        d: k,
        v: (_h = row.v) != null ? _h : null,
        u: (_i = row.u) != null ? _i : null,
        c: (_j = row.c) != null ? _j : null,
        cu: (_k = row.cu) != null ? _k : null,
        n: (_n = (_m = npmDaily[k]) != null ? _m : (_l = slice.npm) == null ? void 0 : _l[k]) != null ? _n : null
      });
    }
    return out;
  }
  function storedDays(slice) {
    return Object.keys(slice.days).length;
  }

  // src/engine.mjs
  var ALL = "all";
  var byAtDesc = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));
  var byUpdatedDesc = (a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  function makeEngine({ store: storeIn, save, cfg: cfgIn, repos, days = 7 } = {}) {
    let cfg = cfgIn || {};
    let store = storeIn || emptyStore();
    const persist = () => {
      if (typeof save === "function") save(store);
    };
    const list = repos || normalizeConfig(cfg).repos || [];
    const buildTargets = (rows, token) => rows.map((r) => {
      const item = typeof r === "string" ? { repo: r } : r;
      const { owner, name } = parseRepo(item.repo);
      const npmPkg = item.npm || name;
      return { key: `${owner}/${name}`, owner, name, npmPkg, npmExplicit: Boolean(item.npm), gh: makeGithub(token, { owner, name }), npm: makeNpm(npmPkg) };
    });
    let targets = buildTargets(list, String(cfg.token || ""));
    let self = [...new Set([cfg.user, ...cfg.selfLogins || []].filter(Boolean))];
    function reload(next) {
      if (next && (next.cfg || next.store)) {
        if (next.cfg) cfg = next.cfg;
        if (next.store) store = next.store;
      } else if (next) {
        cfg = next;
      }
      targets = buildTargets(normalizeConfig(cfg).repos || [], String(cfg.token || ""));
      self = [...new Set([cfg.user, ...cfg.selfLogins || []].filter(Boolean))];
      return targets.length;
    }
    let lastSync = null;
    let syncProgress = { running: false, done: 0, total: 0 };
    async function syncOne(t) {
      var _a, _b;
      const s = repoStore(store, t.key);
      const authed = Boolean(cfg.token);
      const hasContrib = Boolean(((_a = s.meta) == null ? void 0 : _a.activity) || ((_b = s.meta) == null ? void 0 : _b.openWork));
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
        t.gh.forks().catch(() => null)
      ]);
      if (views || clones) mergeTraffic(s, views, clones);
      if (starDates) mergeStars(s, starDates);
      let npmOk = true;
      if (!t.npmExplicit) {
        const own = await t.npm.maintainers().catch(() => null);
        npmOk = (own == null ? void 0 : own.missing) ? false : !own || !own.owners.length || own.owners.includes(t.owner.toLowerCase());
        if (!npmOk) {
          s.npm = {};
          delete s.meta.npmWeek;
          delete s.meta.npmVers;
        }
      }
      s.meta.npmOwned = npmOk;
      let published = null;
      if (npmOk) {
        const [npmRange, week, pub] = await Promise.all([
          t.npm.range(new Date(Date.now() - 400 * 864e5), /* @__PURE__ */ new Date()).catch(() => null),
          t.npm.week().catch(() => null),
          t.npm.versions().catch(() => null)
        ]);
        if (Array.isArray(npmRange)) mergeNpm(s, npmRange);
        if (Number.isFinite(week)) s.meta.npmWeek = week;
        published = pub;
      }
      const prefix = `/${t.owner}/${t.name}`;
      s.meta.repo = repoInfo || s.meta.repo || { owner: t.owner, name: t.name };
      if (forkList) s.meta.forks = { at: (/* @__PURE__ */ new Date()).toISOString(), items: forkList.slice(0, 200) };
      if (paths) {
        s.meta.paths = paths.map((p) => {
          const raw = String(p.path || "");
          const page = raw === prefix || raw === prefix + "/" ? "\u4ED3\u5E93\u4E3B\u9875" : raw.replace(prefix, "");
          return { p: page || "\u4ED3\u5E93\u4E3B\u9875", n: p.count, u: p.uniques };
        });
      }
      if (referrers) s.meta.referrers = referrers.map((r) => ({ from: r.referrer, n: r.count, u: r.uniques }));
      if (alerts) s.meta.alerts = alerts;
      if (activity) s.meta.activity = activity;
      if (openWork) s.meta.openWork = openWork;
      if (activity || openWork) s.meta.contribAt = (/* @__PURE__ */ new Date()).toISOString();
      if (Array.isArray(published) && published.length) {
        s.meta.npmVers = published.map((v) => ({ v: v.version, at: v.at, url: null }));
      }
      if (!npmOk) s.meta.npmVers = [];
      const merged = new Map((s.releases || []).map((r) => [r.tag, r]));
      for (const r of releases || []) merged.set(r.tag_name, { tag: r.tag_name, at: r.published_at, url: r.html_url });
      for (const v of published || []) if (!merged.has(v.version)) merged.set(v.version, { tag: v.version, at: v.at, url: null });
      s.releases = [...merged.values()].filter((r) => r.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
      s.meta.syncedAt = (/* @__PURE__ */ new Date()).toISOString();
      s.meta.error = null;
      return { repo: t.key, ok: true };
    }
    async function refreshContrib(t) {
      const s = repoStore(store, t.key);
      const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
      const [activity, openWork] = await Promise.all([
        t.gh.activity(since, self).catch(() => null),
        t.gh.openWork(self).catch(() => null)
      ]);
      if (activity) s.meta.activity = activity;
      if (openWork) s.meta.openWork = openWork;
      if (activity || openWork) s.meta.contribAt = (/* @__PURE__ */ new Date()).toISOString();
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
        return { ok: results.every((r) => r.ok), at: (/* @__PURE__ */ new Date()).toISOString(), results };
      })();
      try {
        return await contribPromise;
      } finally {
        contribPromise = null;
      }
    }
    let syncPromise = null;
    async function sync() {
      if (syncPromise) return syncPromise;
      if (lastSync && Date.now() - Date.parse(lastSync) < 6e4) return { ok: true, cached: true, syncedAt: lastSync };
      syncPromise = runSync();
      try {
        return await syncPromise;
      } finally {
        syncPromise = null;
      }
    }
    async function runSync() {
      const results = new Array(targets.length);
      const state = { running: true, done: 0, total: targets.length, startedAt: (/* @__PURE__ */ new Date()).toISOString() };
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
            s.meta.syncedAt = (/* @__PURE__ */ new Date()).toISOString();
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
      lastSync = (/* @__PURE__ */ new Date()).toISOString();
      return { ok: results.every((r) => r.ok), syncedAt: lastSync, results };
    }
    function starGrowthOf(from, to, list2) {
      if (!from || !to) return null;
      let delta = 0, seen = 0;
      for (const s of list2) {
        const ds = s.stars || [];
        if (!ds.length) continue;
        seen++;
        delta += ds.filter((d) => d >= from && d <= to).length;
      }
      const span = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
      return seen ? { span, from, to, delta } : null;
    }
    const clampSpan = (sg, cov) => sg && cov ? { ...sg, span: Math.max(1, Math.min(sg.span, cov)) } : sg;
    const coveredDays = (s) => Object.values(s.days || {}).filter((d) => d.u != null).length;
    const firstDay = (s) => Object.values(s.days || {}).filter((d) => d.v != null || d.u != null).map((d) => d.d).sort()[0] || null;
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
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s;
      const slices = targets.map((t) => ({ t, s: repoStore(store, t.key) }));
      const funnelEnd = () => {
        const t = /* @__PURE__ */ new Date();
        t.setUTCHours(0, 0, 0, 0);
        t.setUTCDate(t.getUTCDate() - 1);
        return t.toISOString().slice(0, 10);
      };
      const sum14 = () => {
        const ds = last14Days(funnelEnd());
        return ds.length ? slices.reduce((acc, { s }) => acc + ds.reduce((b, d) => {
          var _a2, _b2, _c2;
          return b + ((_c2 = (_b2 = (_a2 = s.days) == null ? void 0 : _a2[d]) == null ? void 0 : _b2.v) != null ? _c2 : 0);
        }, 0), 0) : null;
      };
      const allSeries = slices.map(({ s }) => series(s, windowDays, s.npm || {}));
      const rows = [];
      if (windowDays === 1) {
        const today = /* @__PURE__ */ new Date();
        today.setUTCHours(0, 0, 0, 0);
        const pick = (back) => new Date(today.getTime() - back * 864e5).toISOString().slice(0, 10);
        const settled = (d) => slices.some(({ s }) => ["v", "u", "c", "cu"].some((f) => {
          var _a2, _b2;
          return Number((_b2 = (_a2 = s.days) == null ? void 0 : _a2[d]) == null ? void 0 : _b2[f]) > 0;
        }));
        let k = pick(1);
        if (!slices.some(({ s }) => {
          var _a2;
          return (_a2 = s.days) == null ? void 0 : _a2[k];
        })) k = pick(2);
        else if (!settled(k)) k = [2, 3, 4].map(pick).find(settled) || k;
        const cell = { d: k, v: null, u: null, c: null, cu: null, n: null };
        for (const { s } of slices) {
          const row = (_a = s.days) == null ? void 0 : _a[k];
          const npmDay = (_c = (_b = s.npm) == null ? void 0 : _b[k]) != null ? _c : row == null ? void 0 : row.n;
          if (npmDay != null) cell.n = ((_d = cell.n) != null ? _d : 0) + npmDay;
          if (!row) continue;
          for (const kk of ["v", "u", "c", "cu"]) if (row[kk] != null) cell[kk] = ((_e = cell[kk]) != null ? _e : 0) + row[kk];
        }
        rows.push(cell);
      }
      for (let i = 0; i < windowDays && windowDays > 1; i++) {
        const cell = { d: (_g = (_f = allSeries[0]) == null ? void 0 : _f[i]) == null ? void 0 : _g.d, v: null, u: null, c: null, cu: null, n: null };
        for (const sr of allSeries) {
          const r = sr[i];
          if (!r) continue;
          for (const k of ["v", "u", "c", "cu", "n"]) if (r[k] != null) cell[k] = ((_h = cell[k]) != null ? _h : 0) + r[k];
        }
        rows.push(cell);
      }
      const paths = /* @__PURE__ */ new Map();
      const referrers = /* @__PURE__ */ new Map();
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
        for (const i of ((_i = m.activity) == null ? void 0 : _i.issues) || []) issues.push({ ...i, repo: t.key });
        for (const p of ((_j = m.activity) == null ? void 0 : _j.pulls) || []) pulls.push({ ...p, repo: t.key });
        for (const k of alertKeys) {
          const cell = (_k = m.alerts) == null ? void 0 : _k[k];
          if (cell == null ? void 0 : cell.available) {
            alerts[k] = {
              available: true,
              open: (alerts[k].open || 0) + (cell.open || 0),
              repos: [...alerts[k].repos || [], { key: t.key, open: cell.open || 0 }]
            };
          } else if (!alerts[k].available && !alerts[k].blocked && (cell == null ? void 0 : cell.status) === 403) {
            alerts[k].blocked = "permission_denied";
          }
        }
      }
      const anyAlert = alertKeys.some((k) => alerts[k].available || alerts[k].blocked);
      const fw = forkWindow(windowDays);
      const repoInfo = slices.reduce(
        (acc, { s }) => {
          var _a2, _b2, _c2, _d2, _e2, _f2;
          return {
            stars: acc.stars + (((_b2 = (_a2 = s.meta) == null ? void 0 : _a2.repo) == null ? void 0 : _b2.stars) || 0),
            forks: acc.forks + (((_d2 = (_c2 = s.meta) == null ? void 0 : _c2.repo) == null ? void 0 : _d2.forks) || 0),
            openIssues: acc.openIssues + (((_f2 = (_e2 = s.meta) == null ? void 0 : _e2.repo) == null ? void 0 : _f2.openIssues) || 0)
          };
        },
        { stars: 0, forks: 0, openIssues: 0 }
      );
      return {
        repo: { fullName: "\u5168\u90E8\u4ED3\u5E93", owner: "", name: "\u5168\u90E8\u4ED3\u5E93", stars: repoInfo.stars, forks: repoInfo.forks, openIssues: repoInfo.openIssues, count: targets.length },
        range: { days: windowDays, from: (_l = rows[0]) == null ? void 0 : _l.d, to: (_m = rows.at(-1)) == null ? void 0 : _m.d, storedDays: Math.max(...slices.map(({ s }) => storedDays(s)), 0), covered: Math.max(...slices.map(({ s }) => coveredDays(s)), 0), first: slices.map(({ s }) => firstDay(s)).filter(Boolean).sort()[0] || null },
        series: rows,
        totals: {
          // 这些是按区间加出来的；views.total 是每仓 14 天的量，当窗口用会把 7 天说成 19 天
          // 和 series 行同源，1 天窗口才不会拿各仓不同的「最近一天」去加
          views: rows.reduce((a, x) => {
            var _a2;
            return a + ((_a2 = x.v) != null ? _a2 : 0);
          }, 0),
          uniques: sumOf((s) => {
            var _a2, _b2;
            return (_b2 = (_a2 = s.meta) == null ? void 0 : _a2.views) == null ? void 0 : _b2.uniques;
          }),
          clones: rows.reduce((a, x) => {
            var _a2;
            return a + ((_a2 = x.c) != null ? _a2 : 0);
          }, 0),
          cloneUniques: sumOf((s) => {
            var _a2, _b2;
            return (_b2 = (_a2 = s.meta) == null ? void 0 : _a2.clones) == null ? void 0 : _b2.uniques;
          }),
          // npm 逐日是按窗口存的，npmWeek 是固定的 7 天滚动值：KPI 要用前者才跟得上范围
          npm: rows.some((x) => x.n != null) ? rows.reduce((a, x) => {
            var _a2;
            return a + ((_a2 = x.n) != null ? _a2 : 0);
          }, 0) : null,
          npmWeek: sumOf((s) => {
            var _a2;
            return (_a2 = s.meta) == null ? void 0 : _a2.npmWeek;
          })
        },
        repos: targets.map((t) => {
          var _a2, _b2, _c2, _d2, _e2, _f2, _g2, _h2, _i2, _j2, _k2, _l2, _m2, _n2, _o2, _p2, _q2, _r2, _s2, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C, _D, _E;
          const r = repoStore(store, t.key);
          const day1 = windowDays === 1 ? (_a2 = rows[0]) == null ? void 0 : _a2.d : null;
          const w = day1 ? [{ d: day1, v: (_d2 = (_c2 = (_b2 = r.days) == null ? void 0 : _b2[day1]) == null ? void 0 : _c2.v) != null ? _d2 : null, u: (_g2 = (_f2 = (_e2 = r.days) == null ? void 0 : _e2[day1]) == null ? void 0 : _f2.u) != null ? _g2 : null, n: (_l2 = (_k2 = (_h2 = r.npm) == null ? void 0 : _h2[day1]) != null ? _k2 : (_j2 = (_i2 = r.days) == null ? void 0 : _i2[day1]) == null ? void 0 : _j2.n) != null ? _l2 : null }] : series(r, windowDays, r.npm || {});
          const sg = starGrowthOf(
            day1 || [((_m2 = w.find((x) => x.v != null || x.u != null)) == null ? void 0 : _m2.d) || "", firstDay(r) || ""].sort().at(-1) || null,
            ((_n2 = w.at(-1)) == null ? void 0 : _n2.d) || null,
            [r]
          );
          return {
            key: t.key,
            name: t.key.split("/")[1] || t.key,
            uniques: windowDays === 1 ? (_p2 = (_o2 = w.at(-1)) == null ? void 0 : _o2.u) != null ? _p2 : null : (_s2 = (_r2 = (_q2 = r.meta) == null ? void 0 : _q2.views) == null ? void 0 : _r2.uniques) != null ? _s2 : null,
            views: w.reduce((a, x) => {
              var _a3;
              return a + ((_a3 = x.v) != null ? _a3 : 0);
            }, 0),
            npm: w.reduce((a, x) => {
              var _a3;
              return a + ((_a3 = x.n) != null ? _a3 : 0);
            }, 0),
            npmWeek: (_u = (_t = r.meta) == null ? void 0 : _t.npmWeek) != null ? _u : null,
            stars: (_x = (_w = (_v = r.meta) == null ? void 0 : _v.repo) == null ? void 0 : _w.stars) != null ? _x : null,
            starDelta: sg ? sg.delta : null,
            forks: (_A = (_z = (_y = r.meta) == null ? void 0 : _y.repo) == null ? void 0 : _z.forks) != null ? _A : null,
            newForks: (((_C = (_B = r.meta) == null ? void 0 : _B.forks) == null ? void 0 : _C.items) || []).filter(inWindow(fw.from, fw.to)).length,
            lastFork: (((_E = (_D = r.meta) == null ? void 0 : _D.forks) == null ? void 0 : _E.items) || [])[0] || null
          };
        }).sort((a, b) => {
          var _a2, _b2;
          return ((_a2 = b.uniques) != null ? _a2 : 0) - ((_b2 = a.uniques) != null ? _b2 : 0);
        }),
        // 漏斗的浏览用「同一段 14 天的逐日和」，别混用 meta 里的接口总数：
        // 两者口径差几次，同时上屏就成两个数
        funnel: {
          views: sum14(),
          home: [...paths.values()].filter((p) => p.p === "\u4ED3\u5E93\u4E3B\u9875").reduce((a, p) => a + p.n, 0) || null,
          // 漏斗是一段固定 14 天的转化：下载也取同一段，混进 7 天的周汇总会让后面两级对不上
          npm: (() => {
            const ds = last14Days(funnelEnd());
            return ds.length ? slices.reduce((acc, { s }) => acc + ds.reduce((b, d) => {
              var _a2, _b2;
              return b + ((_b2 = (_a2 = s.npm) == null ? void 0 : _a2[d]) != null ? _b2 : 0);
            }, 0), 0) : null;
          })()
        },
        impacts: windowDays < 7 ? [] : slices.map(({ t, s }) => {
          var _a2, _b2;
          const im = impactOf(s);
          return im && ((_b2 = (_a2 = im.before) == null ? void 0 : _a2.views) == null ? void 0 : _b2.avg) ? { key: t.key, name: t.key.split("/")[1] || t.key, ...im } : null;
        }).filter((x) => {
          var _a2;
          return x && x.at >= ((_a2 = rows[0]) == null ? void 0 : _a2.d);
        }).sort((a, b) => a.limited === b.limited ? byAtDesc(a, b) : a.limited ? 1 : -1),
        paths: [...paths.values()].sort((a, b) => b.n - a.n),
        referrers: [...referrers.values()].sort((a, b) => b.n - a.n),
        forks: (() => {
          const items = slices.flatMap(({ t, s }) => {
            var _a2, _b2;
            return (((_b2 = (_a2 = s.meta) == null ? void 0 : _a2.forks) == null ? void 0 : _b2.items) || []).filter(inWindow(fw.from, fw.to)).map((x) => ({ ...x, repo: t.key }));
          }).sort(byAtDesc);
          const latest = slices.flatMap(({ t, s }) => {
            var _a2, _b2;
            return (((_b2 = (_a2 = s.meta) == null ? void 0 : _a2.forks) == null ? void 0 : _b2.items) || []).map((x) => ({ ...x, repo: t.key }));
          }).sort(byAtDesc)[0] || null;
          return {
            total: repoInfo.forks,
            from: fw.from,
            to: fw.to,
            inWindow: items.length,
            items: items.slice(0, 100),
            // 窗口里没有新 fork 时，也要能说清最近一次是什么时候
            latest,
            at: slices.map(({ s }) => {
              var _a2, _b2;
              return (_b2 = (_a2 = s.meta) == null ? void 0 : _a2.forks) == null ? void 0 : _b2.at;
            }).filter(Boolean).sort().at(-1) || null
          };
        })(),
        releases: releases.sort(byAtDesc).slice(0, 120),
        impact: windowDays < 7 ? null : (() => {
          const all = slices.map(({ t, s }) => {
            var _a2;
            const im = impactOf(s);
            return im && ((_a2 = im.before) == null ? void 0 : _a2.views) ? { key: t.key, name: t.key.split("/")[1] || t.key, ...im } : null;
          }).filter((x) => {
            var _a2;
            return x && x.at >= ((_a2 = rows[0]) == null ? void 0 : _a2.d);
          });
          const ok = all.filter((x) => !x.limited).sort(byAtDesc);
          return ok[0] || [...all].sort(byAtDesc)[0] || null;
        })(),
        contributions: {
          issues: issues.filter(inWindow((_n = rows[0]) == null ? void 0 : _n.d, (_o = rows.at(-1)) == null ? void 0 : _o.d)),
          pulls: pulls.filter(inWindow((_p = rows[0]) == null ? void 0 : _p.d, (_q = rows.at(-1)) == null ? void 0 : _q.d)),
          open: {
            issues: slices.flatMap(({ t, s }) => {
              var _a2, _b2;
              return (((_b2 = (_a2 = s.meta) == null ? void 0 : _a2.openWork) == null ? void 0 : _b2.issues) || []).map((x) => ({ ...x, repo: t.key }));
            }).sort(byUpdatedDesc),
            pulls: slices.flatMap(({ t, s }) => {
              var _a2, _b2;
              return (((_b2 = (_a2 = s.meta) == null ? void 0 : _a2.openWork) == null ? void 0 : _b2.pulls) || []).map((x) => ({ ...x, repo: t.key }));
            }).sort(byUpdatedDesc)
          },
          alerts: anyAlert ? alerts : null,
          at: slices.map(({ s }) => {
            var _a2;
            return (_a2 = s.meta) == null ? void 0 : _a2.contribAt;
          }).filter(Boolean).sort().at(-1) || null
        },
        starGrowth: clampSpan(starGrowthOf(
          [((_r = rows.find((r) => r.v != null || r.u != null)) == null ? void 0 : _r.d) || "", slices.map(({ s }) => firstDay(s)).filter(Boolean).sort()[0] || ""].sort().at(-1) || null,
          ((_s = rows.at(-1)) == null ? void 0 : _s.d) || null,
          slices.map(({ s }) => s)
        ), Math.max(...slices.map(({ s }) => coveredDays(s)), 0)),
        updatedAt: lastSync
      };
    }
    const shiftDay = (d, n) => {
      const t = /* @__PURE__ */ new Date(`${d}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + n);
      return t.toISOString().slice(0, 10);
    };
    function impactOf(s) {
      var _a, _b, _c, _d;
      const cuts = [
        ...(s.releases || []).filter((r) => r.at).map((r) => ({ version: r.tag, at: String(r.at).slice(0, 10), url: r.url || null })),
        ...(((_a = s.meta) == null ? void 0 : _a.npmVers) || []).filter((v) => v.at).map((v) => ({ version: v.v || v.version, at: String(v.at).slice(0, 10), url: null }))
      ];
      if (!cuts.length) return null;
      cuts.sort(byAtDesc);
      const ev = cuts[0];
      const rows = series(s, 90, s.npm || {});
      const avg = (from, to) => {
        const hit = rows.filter((r) => r.d >= from && r.d <= to);
        const pick = (k) => {
          const got = hit.filter((r) => r[k] !== null && r[k] !== void 0);
          if (!got.length) return null;
          const sum = got.reduce((a, r) => a + r[k], 0);
          return { avg: Math.round(sum / got.length * 10) / 10, days: got.length, from: got[0].d, to: got.at(-1).d };
        };
        return { from, to, views: pick("v"), uniques: pick("u"), npm: pick("n") };
      };
      const at = (x) => ({ before: avg(shiftDay(x.at, -7), shiftDay(x.at, -1)), after: avg(shiftDay(x.at, 1), shiftDay(x.at, 7)) });
      let chosen = null;
      for (const c of cuts.slice(0, 30)) {
        const r = at(c);
        if (((_b = r.before.views) == null ? void 0 : _b.days) >= 3 && ((_c = r.after.views) == null ? void 0 : _c.days) >= 3) {
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
        var _a2, _b2;
        const b = (_a2 = before[k]) == null ? void 0 : _a2.avg, a = (_b2 = after[k]) == null ? void 0 : _b2.avg;
        return b != null && a != null && b !== 0 ? Math.round((a / b - 1) * 100) : null;
      };
      return { ...chosen, limited: (((_d = after.views) == null ? void 0 : _d.days) || 0) < 3, delta: { views: delta("views"), uniques: delta("uniques"), npm: delta("npm") } };
    }
    const inWindow = (from, to) => (x) => {
      const at = String(x.at || x.mergedAt || x.closedAt || x.createdAt || "").slice(0, 10);
      return !from || at >= from && at <= to;
    };
    const forkWindow = (days2) => {
      const to = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const from = new Date(Date.now() - Math.max(0, days2 - 1) * 864e5).toISOString().slice(0, 10);
      return { from, to };
    };
    function buildRepo(windowDays, t) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t;
      const s = repoStore(store, t.key);
      const fw = forkWindow(windowDays);
      const rows = series(s, windowDays, s.npm || {});
      const funnelEnd = () => {
        const t2 = /* @__PURE__ */ new Date();
        t2.setUTCHours(0, 0, 0, 0);
        t2.setUTCDate(t2.getUTCDate() - 1);
        return t2.toISOString().slice(0, 10);
      };
      const sum14 = () => {
        const ds = last14Days(funnelEnd());
        return ds.length ? ds.reduce((b, d) => {
          var _a2, _b2, _c2;
          return b + ((_c2 = (_b2 = (_a2 = s.days) == null ? void 0 : _a2[d]) == null ? void 0 : _b2.v) != null ? _c2 : 0);
        }, 0) : null;
      };
      const meta = s.meta || {};
      const views = meta.views || {};
      const clones = meta.clones || {};
      return {
        repo: { owner: t.owner, name: t.name, npmPkg: meta.npmOwned === false ? null : t.npmPkg, ...meta.repo || {} },
        range: { days: windowDays, from: (_a = rows[0]) == null ? void 0 : _a.d, to: (_b = rows.at(-1)) == null ? void 0 : _b.d, storedDays: storedDays(s), covered: coveredDays(s), first: firstDay(s) },
        series: rows,
        totals: {
          views: rows.reduce((a, x) => {
            var _a2;
            return a + ((_a2 = x.v) != null ? _a2 : 0);
          }, 0),
          uniques: (_c = views.uniques) != null ? _c : null,
          clones: rows.reduce((a, x) => {
            var _a2;
            return a + ((_a2 = x.c) != null ? _a2 : 0);
          }, 0),
          cloneUniques: (_d = clones.uniques) != null ? _d : null,
          npm: rows.some((x) => x.n != null) ? rows.reduce((a, x) => {
            var _a2;
            return a + ((_a2 = x.n) != null ? _a2 : 0);
          }, 0) : null,
          npmWeek: (_e = meta.npmWeek) != null ? _e : null
        },
        paths: meta.paths || [],
        funnel: {
          views: sum14(),
          home: (meta.paths || []).filter((p) => p.p === "\u4ED3\u5E93\u4E3B\u9875").reduce((a, p) => a + (p.n || 0), 0) || null,
          npm: (() => {
            const ds = last14Days(funnelEnd());
            return ds.length ? ds.reduce((b, d) => {
              var _a2, _b2;
              return b + ((_b2 = (_a2 = s.npm) == null ? void 0 : _a2[d]) != null ? _b2 : 0);
            }, 0) : null;
          })()
        },
        starGrowth: clampSpan(starGrowthOf(
          // 单日窗口就锁在那一天：这个仓那天没有流量行时退回自己的第一天，
          // 会把一个月的涨星塞进「近 1 天」
          windowDays === 1 ? ((_f = rows[0]) == null ? void 0 : _f.d) || null : [((_g = rows.find((r) => r.v != null || r.u != null)) == null ? void 0 : _g.d) || "", firstDay(s) || ""].sort().at(-1) || null,
          ((_h = rows.at(-1)) == null ? void 0 : _h.d) || null,
          [s]
        ), coveredDays(s)),
        // fork 是留存信号：谁在什么时候 fork 的，窗口内单独列出来
        forks: {
          total: (_j = (_i = meta.repo) == null ? void 0 : _i.forks) != null ? _j : null,
          from: fw.from,
          to: fw.to,
          inWindow: (((_k = meta.forks) == null ? void 0 : _k.items) || []).filter(inWindow(fw.from, fw.to)).length,
          items: (((_l = meta.forks) == null ? void 0 : _l.items) || []).filter(inWindow(fw.from, fw.to)).slice(0, 30),
          latest: (((_m = meta.forks) == null ? void 0 : _m.items) || [])[0] || null,
          at: ((_n = meta.forks) == null ? void 0 : _n.at) || null
        },
        referrers: meta.referrers || [],
        releases: s.releases || [],
        impact: windowDays < 7 ? null : (() => {
          var _a2;
          const im = impactOf(s);
          return im && im.at >= ((_a2 = rows[0]) == null ? void 0 : _a2.d) ? im : null;
        })(),
        contributions: {
          issues: (((_o = meta.activity) == null ? void 0 : _o.issues) || []).filter(inWindow((_p = rows[0]) == null ? void 0 : _p.d, (_q = rows.at(-1)) == null ? void 0 : _q.d)),
          pulls: (((_r = meta.activity) == null ? void 0 : _r.pulls) || []).filter(inWindow((_s = rows[0]) == null ? void 0 : _s.d, (_t = rows.at(-1)) == null ? void 0 : _t.d)),
          open: meta.openWork ? { issues: meta.openWork.issues || [], pulls: meta.openWork.pulls || [] } : null,
          alerts: meta.alerts || null,
          at: meta.contribAt || null
        },
        updatedAt: meta.syncedAt || lastSync
      };
    }
    function resolveKey(raw) {
      const q = String(raw || "").trim();
      if (!q || q === ALL) return ALL;
      const hit = targets.find((x) => x.key.toLowerCase() === q.toLowerCase());
      if (hit) return hit.key;
      const tail = targets.filter((x) => x.key.toLowerCase().endsWith("/" + q.toLowerCase()));
      return tail.length === 1 ? tail[0].key : null;
    }
    const noRepo = (key) => `\u6CA1\u6709\u7ED1\u5B9A\u8FD9\u4E2A\u4ED3\u5E93\uFF1A${key}\u3002\u53F3\u4E0A\u89D2\u5207\u6362\u8303\u56F4\uFF0C\u6216\u5728 config \u91CC\u52A0\u4E0A\u5B83\u3002`;
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
      if (!t) throw new Error("\u6CA1\u6709\u7ED1\u5B9A\u8FD9\u4E2A\u4ED3\u5E93\uFF1A" + key);
      return t ? buildRepo(windowDays, t) : aggregate(windowDays);
    }
    const repoRows = () => ({
      repos: targets.map((t) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const s = repoStore(store, t.key);
        return {
          key: t.key,
          label: t.key,
          npmPkg: ((_a = s.meta) == null ? void 0 : _a.npmOwned) === false ? null : t.npmPkg,
          stars: (_d = (_c = (_b = s.meta) == null ? void 0 : _b.repo) == null ? void 0 : _c.stars) != null ? _d : null,
          storedDays: storedDays(s),
          syncedAt: (_f = (_e = s.meta) == null ? void 0 : _e.syncedAt) != null ? _f : null,
          error: (_h = (_g = s.meta) == null ? void 0 : _g.error) != null ? _h : null
        };
      }),
      default: ALL
    });
    return {
      get cfg() {
        return cfg;
      },
      get targets() {
        return targets;
      },
      get store() {
        return store;
      },
      get lastSync() {
        return lastSync;
      },
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
      noRepo
    };
  }

  // public/engine-entry.js
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, "at", {
      writable: true,
      configurable: true,
      value: function(n) {
        var i = Math.trunc(Number(n)) || 0;
        return this[i < 0 ? this.length + i : i];
      }
    });
  }
  window.DGO_ENGINE = Object.assign({}, engine_exports, { emptyStore, emptySlice, series });
})();
