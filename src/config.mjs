import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

export const CONFIG_DIR = process.env.GITHUB_OVERVIEW_HOME || join(homedir(), ".config", "github-overview");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STORE_PATH = join(CONFIG_DIR, "store.json");

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(next) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {}
  return next;
}

// Token order: env → config → gh CLI (most people already have gh logged in)
export function resolveToken(cfg = readConfig()) {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (cfg.token) return cfg.token;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

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
