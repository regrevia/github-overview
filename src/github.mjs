const API = "https://api.github.com";

export function makeGithub(token, { owner, name }) {
  async function gh(path, { method = "GET", body, accept } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        accept: accept || "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "github-overview",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status} ${data?.message || ""}`.trim());
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const repoPath = `/repos/${owner}/${name}`;

  // 列表页不会一次给全：翻到不满页为止，最多 5 页（500 条）
  async function listPages(path, stop) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const rows = await gh(`${path}${path.includes("?") ? "&" : "?"}page=${page}`).catch(() => null);
      // 第一页就失败说明这次没拿到，交给调用方保留上一次快照，别写成空
      if (!rows) return page === 1 ? null : out;
      if (!rows.length) break;
      out.push(...rows);
      if (rows.length < 100 || (stop && stop(rows.at(-1)))) break;
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
        owner, name,
        fullName: r.full_name,
        stars: r.stargazers_count,
        forks: r.forks_count,
        watchers: r.subscribers_count,
        openIssues: r.open_issues_count,
        createdAt: r.created_at,
        pushedAt: r.pushed_at,
        htmlUrl: r.html_url,
        description: r.description || "",
      };
    },
    // 星标历史：带 star+json 才回 starred_at，据此算任意窗口的净增
    async stargazers() {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const rows = await gh(`${repoPath}/stargazers?per_page=100&page=${page}`, { accept: "application/vnd.github.star+json" });
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) if (r.starred_at) out.push(String(r.starred_at).slice(0, 10));
        if (rows.length < 100) break;
      }
      return out;
    },
    // traffic endpoints need push access, and only keep 14 rolling days
    async views() { return gh(`${repoPath}/traffic/views?per=day`); },
    async clones() { return gh(`${repoPath}/traffic/clones?per=day`); },
    async referrers() { return gh(`${repoPath}/traffic/popular/referrers`); },
    async paths() { return gh(`${repoPath}/traffic/popular/paths`); },
    async releases() { return gh(`${repoPath}/releases?per_page=100`); },
    // fork 自带创建时间：只取最新一页就够判断「最近有没有人 fork」
    async forks() {
      const rows = await gh(`${repoPath}/forks?per_page=100&sort=newest`);
      if (!Array.isArray(rows)) return null;
      return rows
        .map((r) => ({ login: r.owner?.login || "ghost", at: r.created_at, url: r.html_url }))
        .filter((r) => r.at)
        .sort((x, y) => String(y.at).localeCompare(String(x.at)));
    },
    // external-only: everything not authored by the repo owner (or self aliases)
    // 用 REST 列表而不是 search：search 有索引延迟，刚合并/关闭的状态要十几分钟才可见
    // 真的没处理的活：还开着的 issue（含已经有过回复的）、还没合的 PR。
  // 不能从 activity 窗口里筛——窗口外的老 issue 会让概览谎报「都已回复」
  async openWork(selfLogins = []) {
    const self = new Set([owner.toLowerCase(), ...selfLogins.map((x) => String(x).toLowerCase())]);
    const [issueRows, pullRows] = await Promise.all([
      listPages(`${repoPath}/issues?state=open&per_page=100`),
      listPages(`${repoPath}/pulls?state=open&per_page=100`),
    ]);
    if (!issueRows || !pullRows) return null;
    const out = { issues: [], pulls: [], at: new Date().toISOString() };
    const norm = (it, comments) => {
      const author = it.user?.login || "ghost";
      if (it.user?.type === "Bot" || author.endsWith("[bot]")) return null;
      if (self.has(author.toLowerCase())) return null;
      return {
        number: it.number,
        title: it.title || "",
        author,
        comments: comments ?? 0,
        createdAt: it.created_at,
        updatedAt: it.updated_at,
        url: it.html_url,
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
      const self = new Set([owner.toLowerCase(), ...selfLogins.map(s => String(s).toLowerCase())]);
      const out = { issues: [], pulls: [], selfCount: 0 };
      const byAuthor = (it) => {
        const author = it.user?.login || "ghost";
        if (it.user?.type === "Bot" || author.endsWith("[bot]")) { out.botCount = (out.botCount || 0) + 1; return null; }
        if (self.has(author.toLowerCase())) { out.selfCount++; return null; }
        return author;
      };
      const [issueRows, pullRows] = await Promise.all([
        listPages(`${repoPath}/issues?state=all&since=${sinceIso}&per_page=100&sort=updated&direction=desc`),
        listPages(`${repoPath}/pulls?state=all&sort=updated&direction=desc&per_page=100`, (last) => String(last.updated_at || last.created_at || "").slice(0, 10) < sinceIso),
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
          url: it.html_url,
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
          url: pr.html_url,
        });
      }
      return out;
    },
    async alerts() {
      const probe = async (path) => {
        try {
          const rows = await gh(`${path}?state=open&per_page=100`);
          return { available: true, open: Array.isArray(rows) ? rows.length : 0 };
        } catch (e) {
          // 404: 仓库没开这个功能；403: 多半是 token 没权限；其它按错误处理
          const reason = e.status === 404 ? "unsupported" : e.status === 403 ? "permission_denied" : "error";
          return { available: false, open: null, reason, status: e.status ?? null };
        }
      };
      const [dependabot, codeScanning, secretScanning] = await Promise.all([
        probe(`${repoPath}/dependabot/alerts`),
        probe(`${repoPath}/code-scanning/alerts`),
        probe(`${repoPath}/secret-scanning/alerts`),
      ]);
      return { dependabot, codeScanning, secretScanning };
    },
  };
}
