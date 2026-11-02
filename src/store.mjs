import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { STORE_PATH } from "./config.mjs";

// GitHub traffic only keeps 14 rolling days, so every sync appends today's row.
const EMPTY = { version: 1, days: {}, npm: {}, releases: [], meta: {} };

export function loadStore(path = STORE_PATH) {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { ...structuredClone(EMPTY), ...data, days: data.days || {} };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveStore(store, path = STORE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
  return store;
}

const keyOf = (iso) => String(iso).slice(0, 10);

export function mergeTraffic(store, views, clones) {
  const rows = [...(views?.views || []), ...(clones?.clones || [])];
  for (const v of views?.views || []) {
    const k = keyOf(v.timestamp);
    store.days[k] = { ...(store.days[k] || {}), d: k, v: v.count, u: v.uniques };
  }
  for (const c of clones?.clones || []) {
    const k = keyOf(c.timestamp);
    store.days[k] = { ...(store.days[k] || {}), d: k, c: c.count, cu: c.uniques };
  }
  // API window totals are the only correct unique counts; daily uniques must never be summed
  store.meta.views = { total: views?.count ?? null, uniques: views?.uniques ?? null, at: new Date().toISOString() };
  store.meta.clones = { total: clones?.count ?? null, uniques: clones?.uniques ?? null, at: new Date().toISOString() };
  return { store, rows: rows.length };
}

export function mergeNpm(store, daily) {
  if (!Array.isArray(daily)) return store;
  for (const r of daily) store.npm[r.d] = r.n;
  return store;
}

export function series(store, days, npmDaily = {}) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    const row = store.days[k] || {};
    out.push({
      d: k,
      v: row.v ?? null,
      u: row.u ?? null,
      c: row.c ?? null,
      cu: row.cu ?? null,
      n: npmDaily[k] ?? store.npm[k] ?? null,
    });
  }
  return out;
}

export function storedDays(store) {
  return Object.keys(store.days).length;
}
