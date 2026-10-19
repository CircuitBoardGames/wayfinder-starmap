// Where the maps come from: the plugin's settings name a tracker and a repository.
//   github  -- GitHub issues through the `gh` CLI (signed in with `gh auth login`); children are the map's
//              child block or else its sub-issues, blockers its "blocked by" dependencies, and the graph is
//              computed here (hooks/wayfinder.ts).
//   forgejo -- a Forgejo forge through Forge-Tools' `hub-api`, whose `issue graph --json` computes the graph
//              by the same rules (and reads claims' liveness, which GitHub has no record of).
// Every read is a command the plugin runs; the plugin itself holds no token.
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { MapGraph, MapRow } from '../types'
import { buildGraph, readChildren } from './wayfinder'
import type { Child, Issue } from './wayfinder'

export type Source = { kind: 'github' | 'forgejo'; repo: string; gh: string; hubApi: string }
export type Ticket = { title: string; body: string; url: string }

export function sourceOf(options: PluginOptions): Source {
  const s = (k: string, d: string) => (typeof options[k] === 'string' && options[k] !== '' ? options[k] as string : d)
  return { kind: s('source', 'github') === 'forgejo' ? 'forgejo' : 'github', repo: s('repo', '').trim(), gh: s('ghCommand', 'gh'), hubApi: s('hubApiCommand', 'hub-api') }
}

// Why the source cannot be read at all, or null: checked before any command runs.
export function unset(src: Source): string | null {
  if (src.repo === '') return 'No repository is set: set this plugin\'s "repo" option to owner/repo (in /config, or under pluginConfigs in settings).'
  if (!/^[\w.-]+\/[\w.-]+$/.test(src.repo)) return `The "repo" option is ${JSON.stringify(src.repo)}, not owner/repo.`
  return null
}

const json = <T>(stdout: string): T => JSON.parse(stdout) as T

async function run($: EngineInterface, argv: string[], timeoutMs = 20_000): Promise<string> {
  const r = await $.process.run(argv, { timeoutMs })
  if (r.exitCode !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n').at(-1)?.slice(0, 160) ?? ''
    throw new Error(`${argv[0]} ${argv[1] === 'api' ? argv[2] : argv[1] ?? ''} exited ${r.exitCode}${why === '' ? '' : `: ${why}`}`)
  }
  return r.stdout
}

type GhIssue = {
  number: number; title: string; body: string | null; state: string; html_url: string
  labels?: { name: string }[]; assignees?: { login: string }[]; pull_request?: unknown
}
const issueOf = (g: GhIssue): Issue => ({
  number: g.number, title: g.title ?? '', body: g.body, open: g.state === 'open',
  labels: (g.labels ?? []).map(l => l.name), assignees: (g.assignees ?? []).map(a => a.login), url: g.html_url ?? '',
})

// Up to eight commands at a time: a graph is one dependency read per child.
async function pooled<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!) }
  }))
  return out
}

// The open maps, by number (the listing caps at 50).
export async function listMaps($: EngineInterface, src: Source): Promise<MapRow[]> {
  const rows = src.kind === 'github'
    ? json<GhIssue[]>(await run($, [src.gh, 'api', `repos/${src.repo}/issues?state=open&labels=wayfinder:map&per_page=50`])).filter(i => i.pull_request === undefined)
    : json<GhIssue[]>(await run($, [src.hubApi, `/api/v1/repos/${src.repo}/issues?state=open&type=issues&labels=wayfinder:map&limit=50`]))
  return rows.map(m => ({ number: m.number, title: m.title })).sort((a, b) => a.number - b.number)
}

export async function readGraph($: EngineInterface, src: Source, map: number): Promise<MapGraph> {
  if (src.kind === 'forgejo') {
    const r = await $.process.run([src.hubApi, 'issue', 'graph', src.repo, String(map), '--json'], { timeoutMs: 120_000 })
    let doc: MapGraph & { error?: string }
    try { doc = JSON.parse(r.stdout) as MapGraph & { error?: string } } catch { throw new Error(`${src.hubApi} issue graph exited ${r.exitCode} without a graph`) }
    if (r.exitCode !== 0 || doc.error !== undefined) throw new Error(doc.error ?? `${src.hubApi} issue graph exited ${r.exitCode}`)
    return doc
  }
  const api = async <T>(path: string) => json<T>(await run($, [src.gh, 'api', path]))
  const mapIssue = await api<GhIssue>(`repos/${src.repo}/issues/${map}`)
  if (!(mapIssue.labels ?? []).some(l => l.name === 'wayfinder:map')) throw new Error(`#${map} is not labelled wayfinder:map`)
  const listed = readChildren(mapIssue.body)
  const kids = listed !== null
    ? await pooled(listed, n => api<GhIssue>(`repos/${src.repo}/issues/${n}`))
    : await api<GhIssue[]>(`repos/${src.repo}/issues/${map}/sub_issues?per_page=100`)
  // An unreadable dependency list is not "no blockers": the read fails, and the map with it.
  const children: Child[] = await pooled(kids, async k => ({
    issue: issueOf(k),
    blockers: (await api<GhIssue[]>(`repos/${src.repo}/issues/${k.number}/dependencies/blocked_by?per_page=100`))
      .map(b => ({ number: b.number, open: b.state === 'open' })),
  }))
  return buildGraph(issueOf(mapIssue), children)
}

export async function readTicket($: EngineInterface, src: Source, num: number): Promise<Ticket> {
  const row = src.kind === 'github'
    ? json<GhIssue>(await run($, [src.gh, 'api', `repos/${src.repo}/issues/${num}`]))
    : json<GhIssue>(await run($, [src.hubApi, `/api/v1/repos/${src.repo}/issues/${num}`]))
  return { title: row.title ?? '', body: row.body ?? '', url: row.html_url ?? '' }
}
