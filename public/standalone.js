// 手机 / 桌面独立模式：页面里没有 node 进程，/api/* 由这一层在浏览器里答。
// 数据来自 GitHub 与 npm 的公开接口，快照存 localStorage；凭据只存在这台设备上。
// 与服务器同一条数据通路：都用 window.DGO_ENGINE 里的引擎和同一份 store 结构。
(function () {
  "use strict";
  var E = window.DGO_ENGINE;
  if (!E) {
    console.error("standalone: 缺少引擎包");
    return;
  }
  var K_CFG = "dgo.cfg.v1";
  var K_STORE = "dgo.store.v2";
  var GH = "https://api.github.com";

  function readJSON(k, fallback) {
    try {
      var raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  var saveTimer = 0;
  function writeJSON(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch (e) {
      // 配额满时丢掉最旧的一天，不能让整次同步白跑
      console.warn("standalone: 存不下，已跳过这次落盘", e && e.name);
      return false;
    }
  }

  var cfg = readJSON(K_CFG, null) || { user: "", token: "", repos: [] };
  if (!Array.isArray(cfg.repos)) cfg.repos = [];
  var store = readJSON(K_STORE, null);
  if (!store || !store.repos) store = E.emptyStore();

  var engine = E.makeEngine({
    store: store,
    cfg: cfg,
    repos: cfg.repos,
    // 一次同步会存三十次，落盘合并成一次
    save: function (next) {
      store = next;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        writeJSON(K_STORE, store);
      }, 900);
    },
  });
  store = engine.store || store;

  var meta = { login: "", repos: 0, publicOnly: false, note: "", at: 0 };

  function json(body, code) {
    return new Response(JSON.stringify(body), {
      status: code || 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // 引擎内部抛的是英文 TypeError，不能原样贴到屏上；
  // 自己写的提示都是中文句子，按这个区分
  function human(e, fallback) {
    var m = e && e.message ? String(e.message) : "";
    return /[\u4e00-\u9fa5]/.test(m) ? m : fallback;
  }

  function authHeaders() {
    var h = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (cfg.token) h.authorization = "Bearer " + cfg.token;
    return h;
  }

  async function ghGet(path) {
    var res = await fetch(GH + path, { headers: authHeaders() });
    if (res.status === 404) throw new Error("没有这个用户名");
    if (res.status === 401) throw new Error("这个令牌无效");
    if (res.status === 403 || res.status === 429) throw new Error("免费额度用完了，填访问令牌可以接着看");
    if (!res.ok) throw new Error("GitHub 返回 " + res.status);
    return res.json();
  }

  // 未登录时每小时 60 次，一次同步一个仓库要十来个请求：按剩余额度决定同步几个
  async function budget() {
    if (cfg.token) return Infinity;
    try {
      var r = await fetch(GH + "/rate_limit", { headers: authHeaders() });
      var j = await r.json();
      return j.resources.core.remaining;
    } catch (e) {
      return 20;
    }
  }

  var syncing = null;
  async function bind(user) {
    var name = String(user || "").trim().replace(/^@/, "");
    if (!name) throw new Error("先填用户名");
    var me = await ghGet("/users/" + encodeURIComponent(name));
    var list = await ghGet("/users/" + encodeURIComponent(name) + "/repos?per_page=100&sort=pushed&direction=desc");
    if (!Array.isArray(list) || !list.length) throw new Error("这个账号没有公开仓库");
    cfg.user = me.login;
    cfg.repos = [];
    engine.reload(cfg);
    writeJSON(K_CFG, cfg);
    meta.login = me.login;
    meta.publicOnly = !cfg.token;
    // 未登录只同步额度够用的前几个仓；全部 31 个会立刻把 60 次用完
    var left = await budget();
    if (Number.isFinite(left) && left < 11) {
      throw new Error("免费额度用完了，填访问令牌可以接着看");
    }
    var cap = Number.isFinite(left) ? Math.max(1, Math.min(4, Math.floor((left - 4) / 11))) : list.length;
    var pick = list.slice(0, cap);
    cfg.repos = pick.map(function (r) {
      return { repo: r.full_name };
    });
    engine.reload(cfg);
    writeJSON(K_CFG, cfg);
    meta.repos = cfg.repos.length;
    meta.note = pick.length < list.length ? "看公开数据 · 已取最近推送的 " + pick.length + " 个仓库" : "";
    store = engine.store || store;
    // 不等同步跑完：卡片上已经能看到进度，等在这里只会让按钮一直灰着
    syncing = engine.sync().then(
      function (r) {
        syncing = null;
        meta.at = Date.now();
        writeJSON(K_STORE, store);
        return r;
      },
      function (e) {
        syncing = null;
        writeJSON(K_STORE, store);
        throw e;
      }
    );
    return { login: meta.login, repos: meta.repos, note: meta.note };
  }

  async function bindToken(token) {
    var t = String(token || "").trim();
    if (!t) throw new Error("先填访问令牌");
    var res = await fetch(GH + "/user", { headers: { accept: "application/vnd.github+json", authorization: "Bearer " + t } });
    if (!res.ok) throw new Error("这个令牌读不到账号");
    var me = await res.json();
    cfg.token = t;
    cfg.user = me.login;
    cfg.repos = [];
    engine.reload(cfg);
    var list = await ghGet("/users/" + encodeURIComponent(me.login) + "/repos?per_page=100&sort=pushed&direction=desc");
    cfg.repos = (list || []).map(function (r) {
      return { repo: r.full_name };
    });
    engine.reload(cfg);
    writeJSON(K_CFG, cfg);
    meta.login = me.login;
    meta.repos = cfg.repos.length;
    meta.publicOnly = false;
    meta.note = "";
    store = engine.store || store;
    syncing = engine.sync().then(
      function (r) { syncing = null; meta.at = Date.now(); writeJSON(K_STORE, store); return r; },
      function (e) { syncing = null; writeJSON(K_STORE, store); throw e; }
    );
    return { login: meta.login, repos: meta.repos, note: "" };
  }

  function authState() {
    var bound = Boolean(cfg.user && cfg.repos.length);
    return {
      bound: bound,
      login: cfg.user || null,
      name: "",
      source: cfg.token ? "config" : bound ? "public" : "none",
      deviceFlow: false,
      // 手机上先给用户名这条路：不用登录就能看公开数据，令牌是可选解锁
      loginMode: "user",
      repos: cfg.repos.length,
      publicOnly: !cfg.token,
      note: meta.note || "",
    };
  }

  function progress() {
    var p = engine.progress ? engine.progress() : { running: false, done: 0, total: 0 };
    return Object.assign({}, p, {
      intervalHours: 0,
      contribMinutes: 0,
      bound: Boolean(cfg.user),
      login: cfg.user || "",
      publicOnly: !cfg.token,
    });
  }

  async function ask(question) {
    // 手机上没有代答的模型，直说，不要假装在查
    return {
      answer: "手机上没配模型，摘要用规则生成。",
      links: [{ label: "在 GitHub 上搜索", url: "https://github.com/search?q=" + encodeURIComponent(question) }],
      source: "none",
    };
  }

  // 贡献数据的年龄：超过 20 分钟才算过期，匿名额度要给同步留够
  function staleContrib() {
    var times = [];
    var keys = Object.keys(store.repos || {});
    for (var i = 0; i < keys.length; i++) {
      var m = store.repos[keys[i]] && store.repos[keys[i]].meta;
      if (m && m.contribAt) times.push(Date.parse(m.contribAt) || 0);
    }
    if (!times.length) return true;
    return Date.now() - Math.max.apply(null, times) > 20 * 60 * 1000;
  }

  function body(init) {
    if (!init || !init.body) return null;
    try {
      return JSON.parse(init.body);
    } catch (e) {
      return {};
    }
  }

  async function route(url, init) {
    var p = url.pathname;
    var method = (init.method || "GET").toUpperCase();
    if (p === "/api/auth" && method === "POST") {
      try {
        return json(Object.assign({ bound: true }, await bindToken(body(init).token)));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    if (p === "/api/auth") return json(authState());
    if (p === "/api/user" && method === "POST") {
      try {
        return json(Object.assign({ bound: true }, await bind(body(init).user)));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    if (p === "/api/auth/login" || p === "/api/auth/login/poll" || p === "/api/auth/device" || p === "/api/auth/poll") {
      return json({ error: "这台设备上改用用户名或访问令牌" }, 400);
    }
    if (p === "/api/repos") return json(engine.repoRows());
    if (p === "/api/progress") return json(progress());
    if (p === "/api/sync" && method === "POST") {
      if (!cfg.repos.length) return json({ ok: false, error: "还没有绑定账号" });
      try {
        var out = await engine.sync();
        writeJSON(K_STORE, store);
        // 匿名下同步不再顺带刷 issue/PR（那是每仓两个请求），
        // 换成过期才补，免得贡献那块停在第一次的数上
        if (!cfg.token && staleContrib()) {
          engine.syncContribs().then(function () { writeJSON(K_STORE, store); }, function () {});
        }
        return json(out);
      } catch (e) {
        return json({ ok: false, error: e.message });
      }
    }
    if (p === "/api/data") {
      var days = Number(url.searchParams.get("days") || 7);
      var key = url.searchParams.get("repo");
      var k = engine.resolveKey(key);
      if (k === null) return json({ error: engine.noRepo(key), repo: key }, 404);
      var seeded = Object.values(store.repos).some(function (r) {
        return Object.keys(r && r.days ? r.days : {}).length || (r && r.stars ? r.stars.length : 0);
      });
      var payload = engine.build(days, k);
      if (!seeded) payload.empty = true;
      return json(payload);
    }
    if (p === "/api/summary") {
      var d = Number(url.searchParams.get("days") || 7);
      var kk = engine.resolveKey(url.searchParams.get("repo"));
      if (kk === null) return json({ error: engine.noRepo(url.searchParams.get("repo")) }, 404);
      return json(E.summary ? E.summary(engine.build(d, kk), d, kk) : { source: "none", lines: [] });
    }
    if (p === "/api/ask" && method === "POST") return json(await ask(body(init).question || ""));
    if (p === "/api/config") {
      var local = readJSON(K_CFG, {}) || {};
      var ai = { baseurl: local.baseurl || "", model: local.model || "", apikey: local.apikey ? "已保存" : "" };
      if (method === "POST") {
        var next = body(init);
        local.baseurl = next.baseurl || local.baseurl || "";
        local.model = next.model || local.model || "";
        if (next.apikey) local.apikey = next.apikey;
        writeJSON(K_CFG, local);
        cfg.baseurl = local.baseurl;
        cfg.model = local.model;
        cfg.apikey = local.apikey;
        engine.reload(cfg);
        ai = { baseurl: local.baseurl, model: local.model, apikey: local.apikey ? "已保存" : "" };
      }
      return json(ai);
    }
    return json({ error: "不支持" }, 404);
  }

  var realFetch = window.fetch.bind(window);
  var solo = document.documentElement.dataset.solo === "1";
  window.fetch = function (input, init) {
    var raw = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    var url;
    try {
      url = new URL(raw, location.href);
    } catch (e) {
      return realFetch(input, init);
    }
    // file:// 页面的 origin 是字符串 "null"，按 origin 比对会把 /api/* 漏出去；
    // 独立模式下凡是 /api/ 一律本机答
    var mine = solo ? true : url.origin === location.origin;
    if (!mine || !/^\/api\//.test(url.pathname)) return realFetch(input, init);
    return route(url, init || {}).catch(function (e) {
      return json({ error: human(e, "这台设备上没取到数据") }, 500);
    });
  };

  // 页面绑定入口：绑完直接进看板
  window.DGO_BIND_USER = async function (user) {
    var out = await bind(user);
    await gateDone({ login: out.login, repos: out.repos });
    return out;
  };

  // 关掉页面时把还没落盘的快照写下去
  addEventListener("pagehide", function () {
    clearTimeout(saveTimer);
    writeJSON(K_STORE, store);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      clearTimeout(saveTimer);
      writeJSON(K_STORE, store);
    }
  });

  window.DGO_STANDALONE = { bind: bind, bindToken: bindToken, state: authState, engine: engine };
})();
