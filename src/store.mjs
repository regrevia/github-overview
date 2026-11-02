import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { STORE_PATH } from "./config.mjs";

// GitHub traffic only keeps 14 rolling days, so every sync appends today's row.
const emptySlice = () => ({ days: {}, npm: {}, releases: [], meta: {} });
const emptyStore = () => ({ version: 2, repos: {} });

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

export function repoStore(store, key) {
  if (!store.repos[key]) store.repos[key] = emptySlice();
  return store.repos[key];
}

export function hasRepo(store, key) {
  return Boolean(store.repos[key]);
}

const keyOf = (iso) => String(iso).slice(0, 10);

export function mergeTraffic(slice, views, clones) {
  const rows = [...(views?.views || []), ...(clones?.clones || [])];
  for (const v of views?.views || []) {
    const k = keyOf(v.timestamp);
    slice.days[k] = { ...(slice.days[k] || {}), d: k, v: v.count, u: v.uniques };
  }
  for (const c of clones?.clones || []) {
    const k = keyOf(c.timestamp);
    slice.days[k] = { ...(slice.days[k] || {}), d: k, c: c.count, cu: c.uniques };
  }
  // API window totals are the only correct unique counts; daily uniques must never be summed
  slice.meta.views = { total: views?.count ?? null, uniques: views?.uniques ?? null, at: new Date().toISOString() };
  slice.meta.clones = { total: clones?.count ?? null, uniques: clones?.uniques ?? null, at: new Date().toISOString() };
  return { slice, rows: rows.length };
}

export function mergeNpm(slice, daily) {
  if (!Array.isArray(daily)) return slice;
  for (const r of daily) slice.npm[r.d] = r.n;
  return slice;
}

export function series(slice, days, npmDaily = {}) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    const row = slice.days[k] || {};
    out.push({
      d: k,
      v: row.v ?? null,
      u: row.u ?? null,
      c: row.c ?? null,
      cu: row.cu ?? null,
      n: npmDaily[k] ?? slice.npm[k] ?? null,
    });
  }
  return out;
}

export function storedDays(slice) {
  return Object.keys(slice.days).length;
}
