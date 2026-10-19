import { expect, test } from 'claude-code/testing'
import { buildGraph, readChildren } from '../hooks/wayfinder'
import type { Child, Issue } from '../hooks/wayfinder'

const url = (n: number) => `https://github.com/acme/maps/issues/${n}`
const issue = (number: number, more: Partial<Issue> = {}): Issue =>
  ({ number, title: `ticket ${number}`, body: '', open: true, labels: ['wayfinder:task'], assignees: [], url: url(number), ...more })
const child = (n: number, more: Partial<Issue> = {}, blockers: [number, boolean][] = [], claim?: string): Child =>
  ({ issue: issue(n, more), blockers: blockers.map(([number, open]) => ({ number, open })), claim })

const MAP_BODY = `## Destination

The importer reads every export.

## Decisions so far

- #1 settled the format

## Out of scope

- [the old API](${url(2)})

## Not yet specified

- **Which exports are large.** clears-with: #4
- ~~**Struck.** graduated~~

## Children

<!-- wayfinder:children -->
- #1
- #2
- #3 the claimed one
- #4
- #5
- #6
<!-- /wayfinder:children -->
`
const MAP = issue(10, { title: 'Ship the importer', body: MAP_BODY, labels: ['wayfinder:map'] })

test('a map\'s children are its child block, in order; a damaged block is refused, not skipped', () => {
  expect(readChildren(MAP_BODY)).toEqual([1, 2, 3, 4, 5, 6])
  expect(readChildren('no block here')).toBeNull()
  expect(() => readChildren('<!-- wayfinder:children -->\n- #1\nsee notes\n<!-- /wayfinder:children -->')).toThrow(/not a child entry/)
  expect(() => readChildren('<!-- wayfinder:children -->\n- #1\n- #1\n<!-- /wayfinder:children -->')).toThrow(/listed twice/)
  expect(() => readChildren('<!-- wayfinder:children -->\n- #1\n')).toThrow(/malformed/)
})

test('each child\'s status is derived from its issue: closed, latent, waiting, claimed, blocked, frontier', () => {
  const g = buildGraph(MAP, [
    child(1, { open: false }),                                        // closed, a decision
    child(2, { open: false }),                                        // closed, out of scope
    child(3, { assignees: ['ana'] }, [[1, false]]),                   // assigned
    child(4, {}, [[3, true], [1, false]]),                            // an open blocker
    child(5, { labels: ['wayfinder:research', 'wayfinder:latent'] }), // open by decision
    child(6, { assignees: ['bo'] }, [], 'ended'),                     // a claim that ended: takeable
  ])
  expect(g.nodes.map(v => [v.num, v.status])).toEqual(
    [[1, 'resolved'], [2, 'out_of_scope'], [3, 'claimed'], [4, 'blocked'], [5, 'latent'], [6, 'frontier']])
  expect(g.destination).toBe('The importer reads every export.')
  expect(g.counts).toEqual({ resolved: 1, claimed: 1, blocked: 1, frontier: 1, out_of_scope: 1, latent: 1, waiting: 0, open: 2, total: 6 })
  expect(g.fog).toEqual([{ title: 'Which exports are large', clearsWith: 4 }])      // the struck patch is history
  // Rank: one past the deepest blocker on the map, so a blocker draws before what it blocks.
  expect(g.nodes.map(v => [v.num, v.rank])).toEqual([[1, 0], [2, 0], [3, 1], [4, 2], [5, 0], [6, 0]])
  expect(g.edges).toEqual([{ from: 1, to: 3, satisfied: true }, { from: 3, to: 4, satisfied: false }, { from: 1, to: 4, satisfied: true }])
  expect(g.nodes[2]!.claimedBy).toBe('ana')
  expect(g.lint.map(l => l.msg)).toContain('claimed by a session that has ENDED -- takeable, and the frontier says so')
})

test('lint flags a map that lies: a closed ticket it does not index, a blocker off the map, a cycle, no destination', () => {
  const g = buildGraph(issue(10, { body: '<!-- wayfinder:children -->\n- #7\n- #8\n- #9\n<!-- /wayfinder:children -->', labels: ['wayfinder:map'] }), [
    child(7, { open: false }),
    child(8, {}, [[9, true], [99, true]]),
    child(9, { labels: [] }, [[8, true]]),
  ])
  const msgs = g.lint.map(l => `${l.level} ${l.num ?? '-'} ${l.msg}`)
  expect(msgs).toContain("error 7 closed but absent from the map's Decisions-so-far and Out-of-scope -- the map is the index and it now lies")
  expect(msgs).toContain('warn 8 blocked by #99, which is not on this map')
  expect(msgs).toContain('warn 9 no wayfinder:<type> label (research|prototype|grilling|task)')
  expect(msgs).toContain('error - no Destination -- every session orients to it before choosing a ticket')
  expect(msgs.some(m => /blocked_by cycle: #[89] -> #[89] -> #[89]/.test(m))).toBe(true)
})
