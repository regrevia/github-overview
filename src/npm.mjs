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
      } catch {
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
    async perVersion() {
      const list = await this.versions();
      const recent = list.slice(0, 3);
      const out = [];
      for (const v of recent) {
        try {
          const r = await getJson(`${POINT}/last-week/${encodeURIComponent(safe + "@" + v.version)}`);
          out.push({ version: v.version, downloads: r.downloads ?? 0 });
        } catch { /* unpublished or scoped edge case */ }
      }
      return out;
    },
  };
}
