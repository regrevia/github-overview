import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { STORE_PATH } from "./config.mjs";
import { emptyStore } from "./store-core.mjs";

// 纯逻辑在 store-core.mjs（浏览器侧也要用），这一层只负责读盘/写盘
export * from "./store-core.mjs";

export function loadStore(path = STORE_PATH) {
  if (!existsSync(path)) return emptyStore();
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.version === 2 && data.repos) return { version: 2, repos: data.repos };
    return migrateV1(data);
  } catch {
    return emptyStore();
  }
}

// 旧版是单仓库平铺结构，升级时按 meta.repo.fullName 挂到仓库键下
function migrateV1(data) {
  const store = emptyStore();
  const key = data?.meta?.repo?.fullName;
  if (key) {
    store.repos[key] = {
      days: data.days || {},
      npm: data.npm || {},
      releases: data.releases || [],
      meta: data.meta || {},
    };
  }
  return store;
}

export function saveStore(store, path = STORE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
  return store;
}
