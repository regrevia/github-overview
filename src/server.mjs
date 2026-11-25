import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants as ZC } from "node:zlib";
import { createHash } from "node:crypto";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig, resolveToken, normalizeConfig } from "./config.mjs";
import { authState, boundExplicit, deviceStart, devicePoll, saveToken, adoptAccount, whoami, loginStart, loginPoll } from "./auth.mjs";
import { loadStore, saveStore, repoStore } from "./store.mjs";
import { aiSummary, askQuestion, readAiConfig, templateSummary } from "./summary.mjs";
import { makeEngine, ALL } from "./engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
// 摘要别拖慢页面：先回模板，AI 结果进缓存下一次带出来
const SUM_CACHE = new Map();

// 静态文件按 mtime 缓存压缩结果：首页 100 KB 裸传，压缩后约 30 KB，
// 手机上差的是这一下。ETag 命中回 304，不重复传。
const ASSET_CACHE = new Map();
const compressible = (type) => /^(text\/|application\/(json|javascript))/.test(type);

function serveAsset(req, res, full, type) {
  const st = statSync(full);
  let hit = ASSET_CACHE.get(full);
  if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
    const body = readFileSync(full);
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
    hit = { mtimeMs: st.mtimeMs, size: st.size, body, etag };
    if (compressible(type)) {
      hit.gzip = gzipSync(body, { level: 6 });
      hit.br = brotliCompressSync(body, { params: { [ZC.BROTLI_PARAM_QUALITY]: 9 } });
    }
    // 首页跟着版本走，旧的别留着；静态文件名不带指纹，所以一律回源校验
    ASSET_CACHE.set(full, hit);
    if (ASSET_CACHE.size > 32) ASSET_CACHE.clear();
  }
  const headers = { "content-type": type, etag: hit.etag, "cache-control": "no-cache", vary: "accept-encoding" };
  if (req.headers["if-none-match"] === hit.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const accept = String(req.headers["accept-encoding"] || "");
  if (hit.br && /\bbr\b/.test(accept)) {
    headers["content-encoding"] = "br";
    res.writeHead(200, { ...headers, "content-length": hit.br.length });
    return res.end(hit.br);
  }
  if (hit.gzip && /\bgzip\b/.test(accept)) {
    headers["content-encoding"] = "gzip";
    res.writeHead(200, { ...headers, "content-length": hit.gzip.length });
    return res.end(hit.gzip);
  }
  res.writeHead(200, { ...headers, "content-length": hit.body.length });
  return res.end(hit.body);
}

export function createApp({ repo, repos, days = 7, intervalHours = 6, contribMinutes = 15, cfg: cfgIn } = {}) {
  // 空配置也要能起来：先给绑定页，绑完 reload() 再按新配置建目标
  const cfg = cfgIn || readConfig();
  // token 只在这一层定（环境变量优先）：engine 不读 process，也不读盘
  const withToken = (c) => ({ ...c, token: resolveToken(c) });
  // 抓取与聚合全在 engine.mjs：浏览器侧跑同一份，这里只剩 HTTP 路由和落盘
  const engine = makeEngine({
    store: loadStore(),
    save: (s) => saveStore(s),
    cfg: withToken(cfg),
    repos: repos || normalizeConfig(cfg).repos || (repo ? [{ repo, npm: cfg.npm }] : []),
    days,
  });
  const { build, resolveKey, noRepo, repoRows, progress, sync, syncOne, syncContribs } = engine;
  // 绑完账号立刻换成新 token、新仓库列表和新 store，不用重启进程
  const reload = () => engine.reload({ cfg: withToken(readConfig()), store: loadStore() });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json; charset=utf-8") => {
      const buf = typeof body === "string" || Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
      const head = { "content-type": type, "cache-control": "no-store" };
      // 90 天窗口的 JSON 有 50 KB 上下，手机走 Wi-Fi 也该压一下；小回包不压，省了反而慢
      const accept = String(req.headers["accept-encoding"] || "");
      if (buf.length > 1024 && compressible(type)) {
        if (/\bbr\b/.test(accept)) {
          const z = brotliCompressSync(buf, { params: { [ZC.BROTLI_PARAM_QUALITY]: 5 } });
          res.writeHead(code, { ...head, "content-encoding": "br", vary: "accept-encoding", "content-length": z.length });
          return res.end(z);
        }
        if (/\bgzip\b/.test(accept)) {
          const z = gzipSync(buf, { level: 6 });
          res.writeHead(code, { ...head, "content-encoding": "gzip", vary: "accept-encoding", "content-length": z.length });
          return res.end(z);
        }
      }
      res.writeHead(code, { ...head, "content-length": buf.length });
      res.end(buf);
    };
    try {
      // 绑定账号：设备码流不需要用户手抄 token，也支持直接粘贴 PAT
      if (url.pathname === "/api/auth") {
        if (req.method === "POST") {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw || "{}");
          const token = String(body.token || "").trim();
          if (!token) return send(400, { error: "没有收到 token" });
          const me = await whoami(token);
          if (!me) return send(400, { error: "这个 token 读不到 GitHub 账号" });
          saveToken(token, me.login);
          const adopted = await adoptAccount(token, me.login).catch(() => ({ added: 0, total: 0 }));
          const count = reload();
          return send(200, { bound: true, login: me.login, repos: count, adopted: adopted.added });
        }
        return send(200, await authState());
      }
      // 保留给命令行/打包脚本：本机已经登录过 gh 时直接接管这个账号，界面不再提供这条路
      if (url.pathname === "/api/auth/gh" && req.method === "POST") {
        const token = resolveToken(readConfig());
        const me = await whoami(token);
        if (!me) return send(400, { error: "这台机器上没有可用的 gh 登录" });
        saveToken(token, me.login);
        const adopted = await adoptAccount(token, me.login).catch(() => ({ added: 0 }));
        return send(200, { bound: true, login: me.login, repos: reload(), adopted: adopted.added });
      }
      // 浏览器授权：一次点击 → 屏幕上给一次性码 + 打开 GitHub 确认页。
      // 谁登的 GitHub 就绑谁，不读本机已有登录，别人打开不会绑到这台机器的账号上。
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        try {
          return send(200, await loginStart());
        } catch (e) {
          return send(400, { error: String(e.message || e) });
        }
      }
      if (url.pathname === "/api/auth/login/poll" && req.method === "POST") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        if (body.mode === "device") {
          if (!body.deviceCode) return send(400, { error: "缺 deviceCode" });
          const out = await devicePoll(body.deviceCode);
          if (out.status === "ok") {
            await adoptAccount(resolveToken(readConfig()), out.login).catch(() => null);
            return send(200, { ...out, repos: reload(), ...(await authState()) });
          }
          return send(200, out);
        }
        const out = loginPoll(body.id);
        if (out.status === "ok") return send(200, { ...out, repos: reload(), ...(await authState()) });
        return send(200, out);
      }
      if (url.pathname === "/api/auth/device" && req.method === "POST") {
        try {
          return send(200, await deviceStart());
        } catch (e) {
          return send(400, { error: String(e.message || e) });
        }
      }
      if (url.pathname === "/api/auth/poll" && req.method === "POST") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        if (!body.deviceCode) return send(400, { error: "缺 deviceCode" });
        const out = await devicePoll(body.deviceCode);
        if (out.status === "ok") {
          await adoptAccount(resolveToken(readConfig()), out.login).catch(() => null);
          return send(200, { ...out, repos: reload(), ...(await authState()) });
        }
        return send(200, out);
      }
      if (url.pathname === "/api/repos") {
        return send(200, engine.targets.length && boundExplicit() ? repoRows() : []);
      }
      // 没绑账号（或只剩本机 gh 的登录，用户自己没授权过）时给空载荷，前端只显示绑定页
      const bound = boundExplicit();
      if ((!engine.targets.length || !bound) && /^\/api\/(data|summary|ask|sync)$/.test(url.pathname)) {
        return send(200, { empty: true, needsBinding: true, totals: {}, series: [], range: { days } });
      }
      if (url.pathname === "/api/data") {
        const windowDays = Number(url.searchParams.get("days") || days);
        const rawKey = url.searchParams.get("repo");
        const key = resolveKey(rawKey);
        if (key === null) return send(404, { error: noRepo(rawKey), repo: rawKey });
        // 绑定之后、第一次同步落盘之前快照是空的：标出来，让前端显示进度而不是一屏 0
        const seeded = Object.values(engine.store.repos).some((r) => Object.keys(r?.days || {}).length || (r?.stars || []).length);
        return send(200, seeded ? build(windowDays, key) : { ...build(windowDays, key), empty: true });
      }
      if (url.pathname === "/api/progress") {
        return send(200, { ...progress(), intervalHours, contribMinutes });
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
          // 1 天窗口的访客是当天去重，不能按 14 天去重去折算用户规模
          uniqSpan: single ? 1 : Math.min(data.range.covered || 14, 14),
          views: single ? single.v : winViews,
          external: data.contributions,
          stars: data.repo.stars,
          starGrowth: data.starGrowth,
          npmWeek: data.totals.npmWeek,
          // 漏斗自带 14 天窗口；没有 npm 包的仓把下载写成 null，别拿 0 冒充
          funnel: data.funnel ? { ...data.funnel, npm: data.repo?.npmPkg === null ? null : data.funnel.npm } : null,
          paths: data.paths,
          scope: key === ALL ? `你的 ${engine.targets.length} 个仓库` : key,
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
          const scope = key === ALL ? `全部 ${engine.targets.length} 个仓库` : key;
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
          engine.targets
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
          // 下载逐日按窗口存，问几天就答几天；没采到就说没采到，不拿 7 天滚动值顶
          const spanTxt = data.range?.covered ? `近 ${Math.min(data.range.days, data.range.covered)} 天` : "最近";
          if (key !== ALL) {
            const w = data.totals.npm;
            if (data.repo && data.repo.npmPkg === null) {
              return send(200, { answer: `${key} 没有关联 npm 包。`, links: [{ label: key, url: `https://github.com/${key}` }], source: "data" });
            }
            if (w == null) return send(200, { answer: `${key} 这段窗口还没采集到 npm 下载。`, links: [{ label: key, url: `https://github.com/${key}` }], source: "data" });
            return send(200, {
              answer: w ? `${key} ${spanTxt} npm 下载 ${num(w)} 次。` : `${key} 这段窗口没有 npm 下载。`,
              links: [{ label: key, url: `https://github.com/${key}` }],
              source: "data",
            });
          }
          const rows = rankBy((d) => d.totals.npm);
          if (!rows.length) return send(200, { answer: `${spanTxt}还没有 npm 下载数据。`, source: "data" });
          const body = rows.map((r, i) => `${["", "其次 ", "再次 ", "还有 "][Math.min(i, 3)]}${r.name} ${num(r.v)} 次`).join("，");
          return send(200, { answer: `全站 ${spanTxt} npm 下载最多：${body}。`, links: rows.map((r) => ({ label: r.name, url: `https://github.com/${r.key}` })), source: "data" });
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
        const topRepos = key === ALL ? null : engine.targets
          .map((t) => ({ name: t.name, u: repoStore(engine.store, t.key).meta?.views?.uniques ?? 0 }))
          .sort((a, b) => b.u - a.u)
          .slice(0, 5);
        const ans = await askQuestion(
          {
            allTotal: allData ? allData.totals.uniques : null,
            topRepos,
            days: windowDays,
            covered: data.range.covered,
            day: data.range.days === 1 ? data.series[0]?.d ?? null : null,
            // 单日窗口的访客是当天去重，估算跨度得跟着它走，否则会被当成 14 天去重量
            uniqSpan: data.range.days === 1 ? 1 : Math.min(data.range.covered || 14, 14),
            uniques: data.range.days === 1 ? data.series[0]?.u ?? data.totals.uniques : data.totals.uniques,
            views: data.range.days === 1 ? data.series[0]?.v ?? data.totals.views : data.totals.views,
            external: data.contributions,
            impact: data.impact,
            funnel: data.funnel,
            impacts: data.impacts,
            stars: data.repo.stars,
            starGrowth: data.starGrowth,
            npmWeek: data.totals.npmWeek,
            paths: data.paths,
            scope: key === ALL ? `你的 ${engine.targets.length} 个仓库` : key,
          },
          question,
          [
            {
              name: "traffic",
              description: "查一段时间内某个仓库或全部仓库的访客、浏览、外部 issue/PR、stars、npm 周下载",
              parameters: { type: "object", properties: { days: { type: "integer", description: "7、30 或 90" }, repo: { type: "string", description: "owner/name，不填就是当前面板范围" } } },
              run: ({ days: d, repo }) => {
                const dd = [7, 30, 90].includes(Number(d)) ? Number(d) : windowDays;
                const k2 = repo && engine.targets.some((t) => t.key === repo) ? repo : key;
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
            { name: "list_repos", description: "列出看板绑定的所有仓库", parameters: { type: "object", properties: {} }, run: () => engine.targets.map((t) => t.key) },
            {
              name: "daily",
              description: "按天查浏览/访客曲线，用来回答哪天下滑或上涨",
              parameters: { type: "object", properties: { days: { type: "integer", description: "7、30 或 90" }, repo: { type: "string", description: "owner/name，不填就是当前面板范围" } } },
              run: ({ days: d, repo }) => {
                const dd = [7, 30, 90].includes(Number(d)) ? Number(d) : windowDays;
                const k2 = repo && engine.targets.some((t) => t.key === repo) ? repo : key;
                return build(dd, k2).series.map((r) => `${r.d.slice(5)} 浏览${r.v ?? 0} 访客${r.u ?? 0}`).join("，")
                  + "（访客是当天去重人数，加起来会大于整段去重人数；最后一天常是当天，还没同步完，别当成下滑）";
              },
            },
            {
              name: "activity",
              description: "查外部 issue 和 PR 的明细：编号、标题、作者、状态、是否合并、时间、链接",
              parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name，不填就是当前面板范围" } } },
              run: ({ repo }) => {
                const k2 = repo && engine.targets.some((t) => t.key === repo) ? repo : key;
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
                const t = engine.targets.find((x) => x.key === repo);
                if (!t) return "没有这个仓库";
                await syncOne(t);
                const s2 = repoStore(engine.store, t.key);
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
      return serveAsset(req, res, full, MIME[extname(full)] || "application/octet-stream");
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  });

  return {
    server,
    sync,
    syncContribs,
    build,
    reload,
    count: () => engine.targets.length,
    listen(port = 4317, host = "127.0.0.1") {
      // 端口被占时往上找一个空的：npx 起第二次不该直接崩在 listen 上
      return new Promise((resolve, reject) => {
        let tries = 0;
        const attempt = (p) => {
          const onError = (e) => {
            server.removeListener("listening", onReady);
            if (e.code === "EADDRINUSE" && port !== 0 && tries < 12) { tries += 1; attempt(p + 1); return; }
            reject(e);
          };
          const onReady = () => {
            server.removeListener("error", onError);
            const addr = server.address();
            resolve({ ...addr, moved: port !== 0 && addr.port !== port });
          };
          server.once("error", onError);
          server.once("listening", onReady);
          server.listen(p, host);
        };
        attempt(port);
      });
    },
  };
}
