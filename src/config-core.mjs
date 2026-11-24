// 配置里不碰盘的那一半：仓库写法解析与归一化。
// config.mjs 在这里加读写文件的壳，浏览器侧（mobile 客户端）只引这一份。

export function parseRepo(spec) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(spec || "").trim());
  if (!m) throw new Error(`仓库写法应为 owner/repo，收到：${spec}`);
  return { owner: m[1], name: m[2] };
}

// 统一成 { user, repos: [{ repo, npm }] }，并兼容旧的单仓库字段
export function normalizeConfig(raw = {}) {
  const cfg = { ...raw };
  let repos = cfg.repos;
  if (!Array.isArray(repos) || !repos.length) {
    repos = cfg.repo ? [{ repo: cfg.repo, npm: cfg.npm }] : [];
  }
  cfg.repos = repos
    .map((r) => (typeof r === "string" ? { repo: r } : r))
    .filter((r) => r && r.repo)
    .map((r) => {
      const { owner, name } = parseRepo(r.repo);
      // 只有手工写了 npm 才算绑定，否则留给 registry 核对归属
      return { repo: `${owner}/${name}`, ...(r.npm ? { npm: r.npm } : {}) };
    });
  if (!cfg.user && cfg.repos.length) cfg.user = cfg.repos[0].repo.split("/")[0];
  return cfg;
}

export function parseRepos(spec) {
  return String(spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const { owner, name } = parseRepo(s);
      return { repo: `${owner}/${name}` };
    });
}
