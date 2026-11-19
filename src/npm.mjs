const POINT = "https://api.npmjs.org/downloads/point";
const RANGE = "https://api.npmjs.org/downloads/range";
const REGISTRY = "https://registry.npmjs.org";

const day = (d) => d.toISOString().slice(0, 10);
export const shiftDays = (n, from = new Date()) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "github-overview" } });
  if (!res.ok) {
    const e = new Error(`npm ${url} → ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

export function makeNpm(pkg) {
  const safe = encodeURIComponent(pkg);
  return {
    pkg,
    // 仓库名不等于 npm 包名时，先确认包归谁，别把同名包算进来
    async maintainers() {
      try {
        const meta = await getJson(`${REGISTRY}/${safe}/latest`);
        return { owners: (meta.maintainers || []).map((m) => String(m.name || "").toLowerCase()), version: meta.version || null };
      } catch (e) {
        // 包不存在和网络抖不一样：前者说明这个仓库没有 npm 包，别当成「有包但没采到」
        if (e.status === 404) return { missing: true };
        return null;
      }
    },
    async week() {
      try {
        return (await getJson(`${POINT}/last-week/${safe}`)).downloads ?? null;
      } catch {
        return null;
      }
    },
    // range keeps ~18 months; anything older has no daily series
    async range(fromIso, toIso) {
      try {
        const data = await getJson(`${RANGE}/${day(new Date(fromIso))}:${day(new Date(toIso))}/${safe}`);
        return (data.downloads || []).map((r) => ({ d: r.day, n: r.downloads }));
      } catch (e) {
        return { error: e.status || 0, rows: [] };
      }
    },
    async versions() {
      try {
        const meta = await getJson(`${REGISTRY}/${safe}`);
        const times = meta.time || {};
        return Object.keys(times)
          .filter((v) => !["created", "modified"].includes(v))
          .map((v) => ({ version: v, at: times[v] }))
          .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      } catch {
        return [];
      }
    },
    // 曾有 perVersion(): 按版本查 last-week 下载。上游现在对 `pkg@ver` 一律回
    // {"error":"package x@1.2.3 not found"}，那条腿永远只能是空数组，已删除。
    // 需要逐版本时间线就用 versions()，它读 registry 文档里的 time 表。
  };
}
