const API = "https://api.github.com";

export function makeGithub(token, { owner, name }) {
  async function gh(path, { method = "GET", body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
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
    // traffic endpoints need push access, and only keep 14 rolling days
    async views() { return gh(`${repoPath}/traffic/views?per=day`); },
    async clones() { return gh(`${repoPath}/traffic/clones?per=day`); },
    async referrers() { return gh(`${repoPath}/traffic/popular/referrers`); },
    async paths() { return gh(`${repoPath}/traffic/popular/paths`); },
    async releases() { return gh(`${repoPath}/releases?per_page=100`); },
    // external-only: everything not authored by the repo owner (or self aliases)
    async activity(sinceIso, selfLogins = []) {
      const self = new Set([owner.toLowerCase(), ...selfLogins.map(s => String(s).toLowerCase())]);
      const out = { issues: [], pulls: [], selfCount: 0 };
      for (let page = 1; page <= 5; page++) {
        const rows = await gh(
          `/search/issues?q=${encodeURIComponent(`repo:${owner}/${name} created:>=${sinceIso}`)}&per_page=100&page=${page}`
        );
        const items = rows.items || [];
        for (const it of items) {
          const kind = it.pull_request ? "pulls" : "issues";
          const author = it.user?.login || "ghost";
          // 机器人（dependabot[bot]、github-actions[bot]、CI app）不算外部反馈
          if (it.user?.type === "Bot" || author.endsWith("[bot]")) { out.botCount = (out.botCount || 0) + 1; continue; }
          if (self.has(author.toLowerCase())) { out.selfCount++; continue; }
          out[kind].push({
            number: it.number,
            title: it.title,
            author,
            state: it.state,
            createdAt: it.created_at,
            closedAt: it.closed_at,
            merged: Boolean(it.pull_request?.merged_at),
            mergedAt: it.pull_request?.merged_at || null,
            comments: it.comments,
            url: it.html_url,
          });
        }
        if (items.length < 100) break;
      }
      for (const pr of out.pulls) {
        try {
          const detail = await gh(`${repoPath}/pulls/${pr.number}`);
          pr.additions = detail.additions;
          pr.deletions = detail.deletions;
        } catch { /* older PRs can 404 on details; keep the row */ }
      }
      return out;
    },
    async alerts() {
      const probe = async (path) => {
        try {
          const rows = await gh(`${path}?state=open&per_page=100`);
          return { available: true, open: Array.isArray(rows) ? rows.length : 0 };
        } catch (e) {
          // 403/404 means the feature is off or the token lacks scope: report, never throw
          return { available: false, open: null, reason: e.status === 404 ? "no-analysis" : "disabled" };
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
