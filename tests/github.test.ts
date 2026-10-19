import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

// A GitHub tracker read through `gh api`: the map's children are its sub-issues (it has no child block),
// each child's blockers its "blocked by" dependencies, and the graph is computed by the plugin.
const GITHUB = { options: { source: 'github', repo: 'acme/maps' } }
const PANE_PROPS = { title: 'Maps', isFocused: false, bodyColumns: 101, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: exitCode === 0 ? '' : 'HTTP 404: Not Found', isStdoutTruncated: false, isStderrTruncated: false })
const gh = (n: number, state: string, title: string, labels: string[] = ['wayfinder:task'], assignees: string[] = []) => ({
  number: n, title, state, body: '', html_url: `https://github.com/acme/maps/issues/${n}`,
  labels: labels.map(name => ({ name })), assignees: assignees.map(login => ({ login })),
})
const MAP = { ...gh(10, 'open', 'Ship the importer', ['wayfinder:map']),
  body: '## Destination\n\nThe importer reads every export.\n\n## Decisions so far\n\n- #1 the format\n' }

// The tracker beneath the plugin: each `gh api` path answered, every argv recorded.
function tracker(on: On, blockedByFails = false) {
  const ran: (readonly string[])[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 12, 19, 30, 0) }))
  on('env.get', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'wayfinder-starmap', title: 'Maps', isShown: true, isFocused: false, isPlaced: true }] }))
  on('process.run', ($, e) => {
    ran.push(e.argv)
    if (e.argv[0] !== 'gh' || e.argv[1] !== 'api') return { value: ok('') }
    const path = String(e.argv[2])
    const answer: Record<string, unknown> = {
      'repos/acme/maps/issues?state=open&labels=wayfinder:map&per_page=50': [MAP, { ...gh(11, 'open', 'a pull request'), pull_request: {} }],
      'repos/acme/maps/issues/10': MAP,
      'repos/acme/maps/issues/10/sub_issues?per_page=100': [gh(1, 'closed', 'pick the format'), gh(2, 'open', 'read the exports'), gh(3, 'open', 'wire it up', ['wayfinder:task'], ['ana'])],
      'repos/acme/maps/issues/1/dependencies/blocked_by?per_page=100': [],
      'repos/acme/maps/issues/2/dependencies/blocked_by?per_page=100': [gh(1, 'closed', 'pick the format')],
      'repos/acme/maps/issues/3/dependencies/blocked_by?per_page=100': [gh(2, 'open', 'read the exports')],
    }
    if (blockedByFails && path.startsWith('repos/acme/maps/issues/2/dependencies')) return { value: ok('', 1) }
    return { value: path in answer ? ok(JSON.stringify(answer[path])) : ok('', 1) }
  })
  return ran
}

async function open($: Parameters<TestBody>[0]) {
  await $.session.start({ cwd: '/home/u/work', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wayfinder-starmap:maps', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  return $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
}

test('a GitHub map is read through gh: its sub-issues, their blocked-by links, statuses and ranks', GITHUB, async ($, on) => {
  const ran = tracker(on)
  const ui = await open($)
  expect(await ui.find({ type: 'Text', text: /Open maps: 1/ })).toBeDefined()       // the pull request is not a map
  expect((await ui.find({ key: 'map:10' }))?.text).toBe('▸ #10 Ship the importer')
  expect(await ui.find({ type: 'Text', text: /The importer reads every export\.$/ })).toBeDefined()
  expect((await ui.find({ key: 'open:1' }))?.text).toBe('✓ #1 pick the format [task]')
  expect((await ui.find({ key: 'open:2' }))?.text).toBe('  ★ #2 read the exports [task]')   // its blocker is closed
  expect((await ui.find({ key: 'open:3' }))?.text).toBe('    ● #3 wire it up [task] (ana) ← #2')
  expect(ran).toContainEqual(['gh', 'api', 'repos/acme/maps/issues/10/sub_issues?per_page=100'])
  expect(ran.filter(a => a[0] === 'hub-api')).toHaveLength(0)
  await ui.unmount()
})

test('an unreadable blocked-by list fails the map, rather than drawing a ticket with no blockers', GITHUB, async ($, on) => {
  tracker(on, true)
  const ui = await open($)
  expect(await ui.find({ type: 'Text', text: /^#10: gh repos\/acme\/maps\/issues\/2\/dependencies\/blocked_by\?per_page=100 exited 1: HTTP 404/ })).toBeDefined()
  expect(await ui.find({ key: 'open:2' })).toBeUndefined()
  await ui.unmount()
})

test('with no repository set, the pane says which setting to set and runs nothing', async ($, on) => {
  const ran = tracker(on)
  const ui = await open($)
  expect(await ui.find({ type: 'Text', text: /No repository is set: set this plugin's "repo" option to owner\/repo/ })).toBeDefined()
  expect(ran.filter(a => a[0] === 'gh' || a[0] === 'hub-api')).toHaveLength(0)
  await ui.unmount()
})
