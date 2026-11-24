import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const CONFIG_DIR = process.env.GITHUB_OVERVIEW_HOME || join(homedir(), ".config", "github-overview");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STORE_PATH = join(CONFIG_DIR, "store.json");

// parseRepo/normalizeConfig/parseRepos 在 config-core.mjs（浏览器侧也要用），这里补回同样的导出
export { parseRepo, normalizeConfig, parseRepos } from "./config-core.mjs";

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

// Token order: env → config. Never the gh CLI: that login may belong to someone else.
export function resolveToken(cfg = readConfig()) {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (cfg.token) return cfg.token;
  // 不借本机 gh 的登录：那可能是别人的账号，绑错比不绑更糟
  return "";
}
