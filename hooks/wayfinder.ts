// A wayfinder map's graph document, computed from its issues: the same document the Forgejo source reads
// from `hub-api issue graph <repo> <map> --json` (Forge-Tools), and the same rules, so the two sources draw
// a map alike. Pure: the GitHub source fetches the issues and hands them here.
//
// A map is an issue labelled `wayfinder:map`. Its children, in map order, are the `- #N` lines between
// `<!-- wayfinder:children -->` and `<!-- /wayfinder:children -->` in its body (on GitHub, its sub-issues
// when it has no such block). Its body's `## Destination`, `## Decisions so far`, `## Out of scope` and
// `## Not yet specified` sections index the route. A child's status is derived, never stored:
//   closed, listed under Out of scope      -> out_of_scope   (closed is not resolved: it
//   closed otherwise                       -> resolved        satisfies no blocking edge)
//   open, wayfinder:latent                 -> latent          (open by decision; not work)
//   open, wayfinder:waiting-operator       -> waiting
//   open, assigned, claim not ended        -> claimed
//   open, a blocker not closed             -> blocked
//   open, otherwise                        -> frontier
import type { MapGraph, MapNode } from '../types'

export type Issue = {
  number: number; title: string; body: string | null; open: boolean
  labels: string[]; assignees: string[]; url: string
}
// A child's blockers, each with whether it is still open; `claim`: '' or the claim's state, 'ended' takeable.
export type Child = { issue: Issue; blockers: { number: number; open: boolean }[]; claim?: string }

const BEGIN = '<!-- wayfinder:children -->', END = '<!-- /wayfinder:children -->'
const TYPES = ['research', 'prototype', 'grilling', 'task']
const LATENT = 'wayfinder:latent', WAITING = 'wayfinder:waiting-operator'

// The child numbers in map order. Anything unparseable inside the block is refused, not skipped: a
// skipped line drops a ticket from the frontier, indistinguishable from a complete map.
export function readChildren(body: string | null): number[] | null {
  const text = body ?? ''
  const opens = text.split(BEGIN).length - 1, closes = text.split(END).length - 1
  if (opens === 0 && closes === 0) return null
  if (opens !== 1 || closes !== 1 || text.indexOf(END) < text.indexOf(BEGIN)) {
    throw new Error(`the map's child block is malformed: ${opens} opening and ${closes} closing markers`)
  }
  const out: number[] = []
  for (const line of text.slice(text.indexOf(BEGIN) + BEGIN.length, text.indexOf(END)).split('\n')) {
    if (line.trim() === '') continue
    const m = /^\s*(?:[-*+]\s*)?#(\d+)(?:\s.*)?$/.exec(line)
    if (m === null) throw new Error(`not a child entry, inside the map's child block: ${JSON.stringify(line.slice(0, 80))}`)
    const n = Number(m[1])
    if (out.includes(n)) throw new Error(`#${n} is listed twice in the map's child block`)
    out.push(n)
  }
  return out
}

// `## heading` sections, lowercased, headings inside a code fence not counted.
function sections(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur: string | null = null, fence = ''
  for (const line of body.split('\n')) {
    const run = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (run !== undefined && fence === '') fence = run
    else if (run !== undefined && run[0] === fence[0] && run.length >= fence.length) fence = ''
    else if (fence === '' && /^## \S/.test(line)) { cur = line.slice(3).trim().toLowerCase(); if (!out.has(cur)) out.set(cur, []); continue }
    if (cur !== null) out.get(cur)!.push(line)
  }
  return out
}

// Top-level bullets, indented continuation lines folded in.
function bullets(lines: string[] = []): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (/^[-*+] /.test(line)) out.push(line)
    else if (out.length > 0 && line.trim() !== '' && line[0] === ' ') out[out.length - 1] += `\n${line}`
  }
  return out
}

// The tickets a bullet indexes: every `.../issues/N` link target, else the bare `#N` it opens with.
function cited(text: string): number[] {
  const links = [...text.matchAll(/\/issues\/(\d+)\b/g)].map(m => Number(m[1]))
  return links.length > 0 ? links : [...text.matchAll(/^[-*+] #(\d+)\b/g)].map(m => Number(m[1]))
}

export function buildGraph(map: Issue, children: Child[]): MapGraph {
  const order = children.map(c => c.issue.number)
  const inMap = new Set(order)
  const raw = map.body ?? ''
  const cut = raw.includes(BEGIN) ? raw.slice(0, raw.indexOf(BEGIN)) + raw.slice(raw.indexOf(END) + END.length) : raw
  const sec = sections(cut)
  const destination = (sec.get('destination') ?? []).join('\n').trim()
  const decisions = bullets(sec.get('decisions so far')).flatMap(cited)
  const scoped = new Set(bullets(sec.get('out of scope')).flatMap(cited))
  const fog = bullets(sec.get('not yet specified')).filter(b => !/^[-*+] ~~/.test(b)).map(b => ({
    title: (/\*\*(.+?)\*\*/.exec(b)?.[1] ?? '').replace(/\.$/, ''),
    clearsWith: Number(/clears-with:\s*#?(\d+)/.exec(b)?.[1] ?? 0),
  }))

  const lint: MapGraph['lint'] = []
  const flag = (level: string, num: number | null, msg: string) => { lint.push({ level, num, msg }) }
  const nodes = new Map<number, MapNode>()
  for (const { issue: it, blockers, claim = '' } of children) {
    const typ = TYPES.find(t => it.labels.includes(`wayfinder:${t}`)) ?? ''
    const status: MapNode['status'] = !it.open ? (scoped.has(it.number) ? 'out_of_scope' : 'resolved')
      : it.labels.includes(LATENT) ? 'latent'
      : it.labels.includes(WAITING) ? 'waiting'
      : it.assignees.length > 0 && claim !== 'ended' ? 'claimed'
      : blockers.some(b => b.open) ? 'blocked'
      : 'frontier'
    nodes.set(it.number, {
      num: it.number, title: it.title, type: typ, status, rank: 0,
      claimedBy: it.assignees.join(','), claim, blockers: blockers.map(b => b.number), url: it.url,
    })
    if (typ === '') flag('warn', it.number, 'no wayfinder:<type> label (research|prototype|grilling|task)')
    if ((status === 'resolved' || status === 'out_of_scope') && !decisions.includes(it.number) && !scoped.has(it.number)) {
      flag('error', it.number, "closed but absent from the map's Decisions-so-far and Out-of-scope -- the map is the index and it now lies")
    }
    if (status === 'frontier' && it.assignees.length > 0) flag('warn', it.number, 'claimed by a session that has ENDED -- takeable, and the frontier says so')
    for (const b of blockers) {
      if (!inMap.has(b.number)) flag('warn', it.number, `blocked by #${b.number}, which is not on this map`)
      else if (scoped.has(b.number) && !b.open) flag('warn', it.number, `blocked by #${b.number}, which was ruled out of scope -- this ticket can never unblock`)
    }
  }

  const seen = new Map<number, number>()
  for (const c of decisions) {
    seen.set(c, (seen.get(c) ?? 0) + 1)
    if (!inMap.has(c)) flag('error', null, `Decisions-so-far links #${c}, which is not on this map`)
    else if (scoped.has(c)) flag('error', null, `Decisions-so-far lists #${c}, which is out of scope -- a scope boundary is not a step on the route`)
    else if (nodes.get(c)!.status !== 'resolved') flag('error', null, `Decisions-so-far lists #${c}, which is ${nodes.get(c)!.status}, not resolved`)
  }
  for (const [c, k] of seen) if (k > 1) flag('warn', null, `Decisions-so-far lists #${c} ${k} times`)
  if (destination === '') flag('error', null, 'no Destination -- every session orients to it before choosing a ticket')
  const live = new Map([...nodes.values()].filter(v => v.status !== 'resolved' && v.status !== 'out_of_scope').map(v => [v.title.toLowerCase(), v.num]))
  for (const f of fog) {
    if (f.title === '') { flag('warn', null, 'a fog patch has no bolded lead title -- it has no identity to render or reference'); continue }
    const dup = live.get(f.title.toLowerCase())
    if (dup !== undefined) flag('error', null, `fog patch '${f.title}' duplicates live ticket #${dup} -- the same question is tracked twice`)
    if (f.clearsWith !== 0 && !inMap.has(f.clearsWith)) flag('error', null, `fog patch '${f.title}' clears-with #${f.clearsWith}, which is not on this map`)
    else if (f.clearsWith !== 0 && ['resolved', 'out_of_scope'].includes(nodes.get(f.clearsWith)!.status)) {
      flag('error', null, `fog patch '${f.title}' clears-with #${f.clearsWith}, already closed -- it should have graduated into a ticket or been struck`)
    }
  }

  // Rank: one past the deepest in-map blocker, so every blocker draws before what it blocks; a cycle
  // contributes no depth and is reported once, as a path.
  const edges = order.flatMap(n => nodes.get(n)!.blockers.filter(b => inMap.has(b)).map(b => [b, n] as const))
  const rank = new Map<number, number>(), cycles = new Set<string>()
  const depth = (n: number, path: number[]): number => {
    if (rank.has(n)) return rank.get(n)!
    if (path.includes(n)) { cycles.add([...path.slice(path.indexOf(n)), n].map(x => `#${x}`).join(' -> ')); return 0 }
    const r = Math.max(0, ...edges.filter(([, t]) => t === n).map(([b]) => depth(b, [...path, n]) + 1))
    rank.set(n, r)
    return r
  }
  for (const n of order) depth(n, [])
  for (const n of order) nodes.get(n)!.rank = rank.get(n)!
  for (const c of [...cycles].sort()) flag('error', null, `blocked_by cycle: ${c}`)

  const counts: Record<string, number> = {}
  for (const k of ['resolved', 'claimed', 'blocked', 'frontier', 'out_of_scope', 'latent', 'waiting']) {
    counts[k] = [...nodes.values()].filter(v => v.status === k).length
  }
  counts.open = counts.blocked! + counts.frontier!
  counts.total = order.length
  return {
    map: map.number, name: map.title, url: map.url, destination, counts,
    nodes: order.map(n => nodes.get(n)!),
    edges: edges.map(([b, n]) => ({ from: b, to: n, satisfied: nodes.get(b)!.status === 'resolved' })),
    fog, lint,
  }
}
