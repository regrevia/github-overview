import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
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
