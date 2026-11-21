/**
 * dsh-github-overview — let the agent read the local GitHub Overview dashboard.
 *
 * The dashboard (github-overview) already syncs GitHub traffic, npm downloads,
 * stars and external contributions into a local store and serves them over
 * HTTP. This bundle adds one tool that routes a model's question to that
 * running instance instead of guessing: it probes the loopback ports the CLI
 * and the desktop shell bind, reads `/api/data` for the requested window, and
 * hands back the same numbers the page shows.
 *
 * It is deliberately dependency-free and reads nothing from disk: no store
 * parsing, no token, no GitHub call of its own. When no instance is running or
 * the instance is not bound yet, the tool says so and the model asks the user
 * to start it, rather than inventing figures.
 *
 * @module dsh-github-overview
 */

/** Plugin id, as declared by the bundle patch. */
export const name = 'github-overview'

/** The tool registry is the only service this plugin needs. */
export const inject = ['tools']

/** Ports the CLI and the desktop shell bind by default, in probe order. */
const PORTS = [4317, 4318, 4319, 4320, 4321]

/** Windows the dashboard stores and the page offers. */
const DAYS = [1, 7, 30, 90]

/**
 * Ask one candidate origin whether a dashboard answers there.
 *
 * It probes `/api/repos`, which is answered from the local store. `/api/auth`
 * would be the natural choice but it asks GitHub for the account name, so it
 * costs about a second and a short timeout would turn a live dashboard into a
 * false "not running".
 *
 * @param origin - `http://127.0.0.1:<port>`.
 * @returns true when a dashboard answers there.
 */
async function probe(origin) {
  try {
    const res = await fetch(`${origin}/api/repos`, { signal: AbortSignal.timeout(1200) })
    if (!res.ok) return false
    const body = await res.json()
    // Bound: `{ repos: [...] }`. Unbound: a bare `[]`.
    return Array.isArray(body) || Array.isArray(body?.repos)
  } catch {
    return false
  }
}

/**
 * Locate a running dashboard.
 * @returns its origin, or null when none answers.
 */
async function locate() {
  const fixed = process.env.GITHUB_OVERVIEW_URL
  if (fixed) {
    const origin = fixed.replace(/\/$/, '')
    return (await probe(origin)) ? origin : null
  }
  const origins = PORTS.map((port) => `http://127.0.0.1:${port}`)
  const hits = await Promise.all(origins.map(async (origin) => ((await probe(origin)) ? origin : null)))
  return hits.find(Boolean) ?? null
}

/**
 * Read one window of dashboard data.
 * @param origin - dashboard base URL.
 * @param days - window in days.
 * @param repo - repository key, or undefined for the aggregate row.
 * @returns the `/api/data` body.
 */
async function read(origin, days, repo, tries = 2) {
  const url = new URL(`${origin}/api/data`)
  url.searchParams.set('days', String(days))
  if (repo) url.searchParams.set('repo', repo)
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  const body = await res.json()
  if (res.ok) return body
  // The first read after a sync can land while the store is being rewritten.
  if (tries > 0 && res.status >= 500) return read(origin, days, repo, tries - 1)
  throw new Error(body?.error ?? `看板返回 ${res.status}`)
}

/**
 * Drop keys the store did not have, so the tool result survives a JSON round
 * trip: an `undefined` field is not lossless JSON and the host rejects it.
 * @param value - any tool result.
 * @returns the same value with `undefined`-valued keys removed.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Compress the dashboard payload to what a model needs to answer a question:
 * totals, the daily series, the funnel, and the per-repository rows.
 * @param data - `/api/data` body.
 * @returns a small report.
 */
function digest(data) {
  const totals = data.totals ?? {}
  return {
    repo: data.repo?.fullName ?? '全部仓库',
    days: data.range?.days ?? null,
    covered: data.range?.covered ?? null,
    storedDays: data.range?.storedDays ?? null,
    first: data.range?.first ?? null,
    totals: {
      views: totals.views ?? null,
      uniques: totals.uniques ?? null,
      clones: totals.clones ?? null,
      cloneUniques: totals.cloneUniques ?? null,
      npm: totals.npm ?? null,
      npmWeek: totals.npmWeek ?? null,
    },
    series: (data.series ?? []).map((x) => ({ date: x.d, views: x.v ?? null, uniques: x.u ?? null, clones: x.c ?? null, npm: x.n ?? null })),
    funnel: data.funnel ?? null,
    // Rows carry `key`; `fullName` belongs to the aggregate `repo` object.
    repos: (data.repos ?? []).slice(0, 12).map((r) => ({ repo: r.key ?? r.fullName ?? null, uniques: r.uniques ?? null, views: r.views ?? null, npm: r.npm ?? null, stars: r.stars ?? null, starDelta: r.starDelta ?? null })),
    repoCount: (data.repos ?? []).length,
    contributions: contributionsOf(data),
    starGrowth: data.starGrowth ?? null,
    updatedAt: data.updatedAt ?? null,
  }
}

/**
 * Turn the payload into the few lines a person reads in the transcript.
 * The full numbers are in the tool result; this is the summary card.
 * @param value - executed tool result.
 * @returns printable text.
 */
function card(value) {
  if (!value || typeof value !== 'object') return '没有拿到数据'
  if (value.ok === false) return value.reason ?? '读不到看板'
  const t = value.totals ?? {}
  const head = `${value.repo ?? '全部仓库'} · 近 ${value.days ?? 7} 天`
  const line = (label, n, extra) => (n === null || n === undefined ? null : `${label} ${Number(n).toLocaleString('en')}${extra ? ` ${extra}` : ''}`)
  const rows = [
    line('浏览', t.views),
    line('去重访客', t.uniques),
    line('克隆', t.clones),
    line('npm', t.npm),
  ].filter(Boolean)
  // `starGrowth.delta` is the change inside the window; `span` is the window itself.
  const g = value.starGrowth ?? {}
  if (typeof g.delta === 'number') rows.push(`star ${g.delta >= 0 ? '+' : ''}${g.delta}`)
  const c = value.contributions ?? {}
  if (c.issues || c.pulls) rows.push(`外部 issue ${c.issues ?? 0} · PR ${c.pulls ?? 0}`)
  const stored = typeof value.storedDays === 'number' ? `已存 ${value.storedDays} 天` : ''
  const tail = [stored, value.updatedAt ? `同步于 ${value.updatedAt}` : ''].filter(Boolean).join(' · ')
  return `${head}\n${rows.join(' · ') || '没有数据'}${tail ? `\n${tail}` : ''}`
}

/**
 * Fold the contributions block into counts, which is all a question needs.
 * @param data - `/api/data` body.
 * @returns counts, or null when the window did not collect them.
 */
function contributionsOf(data) {
  const c = data.contributions
  if (!c) return null
  const open = c.open ?? {}
  return {
    issues: Array.isArray(c.issues) ? c.issues.length : 0,
    pulls: Array.isArray(c.pulls) ? c.pulls.length : 0,
    openIssues: Array.isArray(open.issues) ? open.issues.length : 0,
    openPulls: Array.isArray(open.pulls) ? open.pulls.length : 0,
    dependabot: c.alerts?.dependabot?.open ?? null,
    at: c.at ?? null,
  }
}

/** Tool definition: one read of the running dashboard. */
const definition = {
  name: 'github_overview',
  description:
    'Read the local GitHub Overview dashboard: traffic views and unique visitors, git clones, npm downloads, the 14-day funnel, per-repository rows, external contributions and star growth. Use it whenever the user asks about their GitHub repos\' traffic, downloads or growth instead of estimating. Requires the dashboard to be running (npx github-overview start); it reports that when nothing answers.',
  parameters: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository as owner/name, or 全部仓库 for the aggregate row. Omit for the aggregate.',
      },
      days: {
        type: 'integer',
        enum: DAYS,
        description: 'Window in days. Defaults to 7. Windows beyond the stored snapshots only cover recorded days.',
      },
    },
    required: [],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        reason: { type: 'string' },
        origin: { type: 'string' },
        repo: { type: 'string' },
        repoCount: { type: 'integer' },
        days: { type: 'integer' },
        covered: { type: 'integer' },
        storedDays: { type: 'integer' },
        first: { type: 'string' },
        totals: { type: 'object' },
        series: { type: 'array', items: { type: 'object' } },
        repos: { type: 'array', items: { type: 'object' } },
        funnel: { type: 'object' },
        contributions: { type: 'object' },
        starGrowth: { type: 'object' },
        updatedAt: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: card(value) }],
  },
  async execute(args) {
    const days = DAYS.includes(args?.days) ? args.days : 7
    const repo = typeof args?.repo === 'string' && args.repo.trim() && args.repo.trim() !== '全部仓库' ? args.repo.trim() : undefined

    const found = await locate()
    if (!found) return { ok: false, reason: '看板没在运行：先 npx github-overview start，或打开桌面端' }

    try {
      const data = await read(found, days, repo)
      if (data.needsBinding) return { ok: false, reason: '看板还没绑定账号：在页面里用 GitHub 登录一次' }
      if (data.empty) return plain({ ok: true, reason: '还没有同步数据：在页面上点一次刷新', repo: repo ?? '全部仓库', days })
      return plain({ ok: true, origin: found, ...digest(data) })
    } catch (error) {
      return plain({ ok: false, reason: String(error?.message ?? error) })
    }
  },
}

/**
 * Register the dashboard tool.
 * @param ctx - registrant context carrying the `tools` service.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(definition, {}), 'github-overview.tool')
}
