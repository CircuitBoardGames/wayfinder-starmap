import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { StarProps } from '../types'
import { cellPx } from '../hooks/register'

const SURFACES = ['terminal', 'desktop'] as const
// Settings for a Forgejo tracker read through Forge-Tools' hub-api, as these tests' machine answers it.
const FORGEJO = { options: { source: 'forgejo', repo: 'acme/maps' } }
const MAPS = JSON.stringify([
  { number: 9, title: 'Ship the importer', labels: [{ name: 'wayfinder:map' }] },
  { number: 4, title: 'Move the build to the new runner', labels: [{ name: 'wayfinder:map' }] },
])
// What `hub-api issue graph` prints: one node per derived status, 1 <- 5 <- 4 as the edges.
const GRAPH = JSON.stringify({
  map: 4, name: 'Move the build to the new runner', url: 'https://git.example/o/r/issues/4',
  destination: 'The build runs on the new runner.\nSecond line.',
  counts: { resolved: 1, claimed: 1, blocked: 1, frontier: 1, out_of_scope: 1, latent: 1, waiting: 0, open: 2, total: 6 },
  nodes: [
    { num: 1, title: 'done', type: 'grilling', status: 'resolved', rank: 0, claimedBy: '', claim: '', blockers: [], url: 'https://git.example/o/r/issues/1' },
    { num: 2, title: 'ruled out', type: 'research', status: 'out_of_scope', rank: 0, claimedBy: '', claim: '', blockers: [], url: '' },
    { num: 3, title: 'taken', type: 'task', status: 'claimed', rank: 0, claimedBy: 'claude', claim: 'live', blockers: [], url: '' },
    { num: 4, title: 'blocked', type: 'prototype', status: 'blocked', rank: 2, claimedBy: '', claim: '', blockers: [5, 1], url: '' },
    { num: 5, title: 'takeable', type: 'task', status: 'frontier', rank: 1, claimedBy: '', claim: '', blockers: [1], url: '' },
    { num: 6, title: 'latent', type: '', status: 'latent', rank: 0, claimedBy: '', claim: '', blockers: [], url: '' },
  ],
  edges: [{ from: 5, to: 4, satisfied: false }, { from: 1, to: 5, satisfied: true }],
  fog: [{ title: 'A fog patch', clearsWith: 4 }, { title: '', clearsWith: 0 }],
  lint: [{ level: 'error', num: 2, msg: 'closed but absent from the map' }, { level: 'warn', num: null, msg: 'a fog patch has no bolded lead title' }],
})
const ITEM = JSON.stringify({ title: 'takeable', body: 'Part of #4\r\n\n**Question**\u0007', html_url: 'https://git.example/o/r/issues/5' })
const PANE_PROPS = { title: 'Maps', isFocused: false, bodyColumns: 101, placement: 'dock' as const,
                     scroll: { offset: 0, bodyRows: 40 }, view: {} }
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
// The star map is pixels or nothing, so the tests' box is a Ghostty outside tmux unless a test says otherwise:
// over SSH, so the picture goes inline (a remote terminal cannot read this machine's files).
const GHOSTTY = { HOME: '/home/u', TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty', SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }

// Stands for the engine and the machine beneath the plugin; every argv the plugin runs is recorded.
function box(on: On, graphExit = 0, env: Record<string, string> = GHOSTTY, graph: string | ((map: string) => string | Promise<string>) = GRAPH, deny?: string, clock = true, drawMs = 0) {
  const ran: (readonly string[])[] = []
  const opened: string[] = []
  const closed: string[] = []
  const blits: { key: string; source: Picture }[] = []
  const files = new Map<string, string>()           // the machine's ~/.cache/wayfinder-starmap, in memory
  const drawn: string[] = []                        // each shared picture written: its RGBA, base64
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => { opened.push(e.id); return { value: { isPlaced: true as const } } })
  on('ui.close', ($, e) => { closed.push(e.id); return { value: true } })
  on('ui.blit', ($, e) => { blits.push(e as unknown as { key: string; source: Picture }); return { value: deny === undefined || blits.length < 2 ? {} : { deny } } })   // a deny refuses the second blit on
  if (clock) on('clock.now', () => ({ value: Date.UTC(2026, 9, 12, 19, 30, 0) }))   // else a test's mock.clock answers
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('ui.panes', () => ({ value: [{ id: 'wayfinder-starmap', title: 'Maps', isShown: true, isFocused: false, isPlaced: true }] }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.run', async ($, e) => {
    ran.push(e.argv)
    if (e.argv[0] === 'sh') {
      drawn.push(e.init?.stdin ?? '')
      if (drawMs > 0) await new Promise(r => setTimeout(r, drawMs))   // a draw that takes time, as a real one does
    }
    if (e.argv[0] === 'python3') return { value: ok(env.TTY_CELL ?? '') }   // the pty's cell, in device pixels: `w h`
    if (e.argv[0] !== 'hub-api') return { value: ok('') }
    if (e.argv[1] === 'issue') {
      return { value: { ...ok(graphExit === 0 ? (typeof graph === 'string' ? graph : await graph(String(e.argv[4]))) : JSON.stringify({ error: 'REFUSING: #4 is not labelled wayfinder:map' })), exitCode: graphExit } }
    }
    const path = String(e.argv[1])
    return { value: ok(path.includes('labels=wayfinder:map') ? MAPS : ITEM) }
  })
  return Object.assign(ran, { opened, closed, blits, files, drawn })
}

async function open($: Parameters<TestBody>[0], args = '') {
  await $.session.start({ cwd: '/home/u/work', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wayfinder-starmap:maps', args, origin: { kind: 'composer' },
                        presentation: { isFullscreen: true, columns: 200 } })
}

test('the pane lists the open maps and draws the first one: counts, rows by rank, fog, lint', FORGEJO, async ($, on) => {
  const ran = box(on)
  await open($)
  // The lowest-numbered map is drawn first, by hub-api's graph verb.
  expect(ran).toContainEqual(['hub-api', 'issue', 'graph', 'acme/maps', '4', '--json'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface, component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /Open maps: 2/ })).toBeDefined()
    expect((await ui.find({ key: 'map:4' }))?.text).toBe('▸ #4 Move the build to the new runner')
    expect((await ui.find({ key: 'map:9' }))?.text).toBe('  #9 Ship the importer')
    expect(await ui.find({ type: 'Text', text: /The build runs on the new runner\.$/ })).toBeDefined()   // first line only
    expect(await ui.find({ type: 'Text', text: /1 resolved · 1 claimed · 2 open · 1 out of scope · 1 latent · frontier 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /█+░+ 1\/6/ })).toBeDefined()
    // Rank order: every blocker above what it blocks, indented by depth; the glyph is the status.
    expect((await ui.find({ key: 'open:1' }))?.text).toBe('✓ #1 done [grilling]')
    expect((await ui.find({ key: 'open:3' }))?.text).toBe('● #3 taken [task] (claude, live)')
    expect((await ui.find({ key: 'open:5' }))?.text).toBe('  ★ #5 takeable [task]')   // #1 resolved: no longer holds it
    expect((await ui.find({ key: 'open:4' }))?.text).toBe('    ○ #4 blocked [prototype] ← #5')
    expect((await ui.find({ key: 'open:6' }))?.text).toBe('◌ #6 latent')
    // The order on screen IS the layout: rank first, map order within a rank.
    expect((await ui.findAll({ type: 'Button', text: /^\s*[★●○✓✗◌⏸] #/ })).map(b => b.key)).toEqual(
      ['open:1', 'open:2', 'open:3', 'open:6', 'open:5', 'open:4'])
    expect(await ui.find({ type: 'Text', text: /Fog: 2 patches/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~ A fog patch \(clears with #4\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~ \(untitled\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Lint: 1 error\(s\), 1 warning\(s\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /error: #2: closed but absent/ })).toBeDefined()
    expect(await ui.find({ key: 'close:wayfinder-starmap' })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing a map row reads that map; /maps <n> opens straight into it', FORGEJO, async ($, on) => {
  const ran = box(on)
  await open($, '#9')
  expect(ran).toContainEqual(['hub-api', 'issue', 'graph', 'acme/maps', '9', '--json'])
  const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
  await ui.press({ key: 'map:4' })
  expect(ran.filter(a => a[1] === 'issue').map(a => a[4])).toEqual(['9', '4'])
  await ui.press({ key: 'refresh' })
  expect(ran.filter(a => a[1] === 'issue').map(a => a[4])).toEqual(['9', '4', '4'])   // Refresh keeps the choice
  await ui.unmount()
})

// A picked map shows at once ; a second pick while the first loads wins, whichever graph answers last.
test('a picked map is marked and says Loading at once; the last pick wins over a slower earlier one', FORGEJO, async ($, on) => {
  let release = () => {}
  const slow = new Promise<void>(r => { release = r })
  box(on, 0, GHOSTTY, async map => { if (map === '9') await slow; return JSON.stringify({ ...JSON.parse(GRAPH), map: Number(map), name: `map ${map}` }) })
  await open($)
  const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
  const pending = ui.press({ key: 'map:9' })
  await new Promise(r => setTimeout(r, 50))
  expect(await ui.find({ type: 'Text', text: /Loading map #9/ })).toBeDefined()
  expect((await ui.find({ key: 'map:9' }))?.text).toMatch(/^▸ #9/)
  await ui.press({ key: 'map:4' })                         // picked while #9 still loads
  release(); await pending
  expect(await ui.find({ type: 'Text', text: /#4 map 4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#9 map 9/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Loading/ })).toBeUndefined()
  await ui.unmount()
})

test('pressing a ticket row shows its body under the star map, one at a time; ✕ closes it', FORGEJO, async ($, on) => {
  const ran = box(on)
  await open($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface, component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
    await ui.press({ key: 'open:5' })
    expect(ran).toContainEqual(['hub-api', '/api/v1/repos/acme/maps/issues/5'])
    expect(await ui.find({ type: 'Text', text: /#5 takeable/ })).toBeDefined()
    // CR and the bell are gone; the newline stays.
    expect(await ui.find({ type: 'Markdown', text: 'Part of #4\n\n**Question**' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.press({ key: 'close:item' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
  expect(ran.opened).toEqual(['wayfinder-starmap'])                    // no second pane
})

test('Assign on an open ticket row submits it to this session as the person\'s prompt; a closed one has none', FORGEJO, async ($, on) => {
  box(on)
  const submitted: { text: string; asUser?: boolean }[] = []
  on('prompt.submit', ($, e) => { submitted.push({ text: e.text, asUser: (e.origin as { asUser?: boolean }).asUser }); return { text: e.text } })
  await open($)
  const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
  await ui.press({ key: 'assign:5' })                                   // no URL on the node: the configured repo
  expect(submitted).toEqual([{ text: 'Work on issue acme/maps#5: takeable', asUser: true }])
  expect(await ui.find({ key: 'assign:1' })).toBeUndefined()           // resolved
  expect(await ui.find({ key: 'assign:2' })).toBeUndefined()           // out of scope
  expect(await ui.find({ key: 'assign:4' })).toBeDefined()             // blocked, still open
  await ui.unmount()
})

test('a ticket opened by clicking a star has Assign beside its ✕ while open; a closed one has none', FORGEJO, async ($, on) => {
  box(on)
  const submitted: string[] = []
  on('prompt.submit', ($, e) => { submitted.push(e.text); return { text: e.text } })
  await open($)
  const ui = await starmap($)
  await ui.post({ open: 5 }, { in: 'starmap' })
  await ui.press({ key: 'assign:item' })
  expect(submitted).toEqual(['Work on issue acme/maps#5: takeable'])
  await ui.post({ open: 1 }, { in: 'starmap' })                         // resolved
  expect(await ui.find({ type: 'Text', text: /#1 / })).toBeDefined()
  expect(await ui.find({ key: 'assign:item' })).toBeUndefined()
  await ui.unmount()
})

test('a refusing graph verb shows its reason, not an empty map', FORGEJO, async ($, on) => {
  box(on, 2)
  await open($)
  const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /#4: REFUSING: #4 is not labelled wayfinder:map/ })).toBeDefined()
  expect(await ui.find({ key: 'open:5' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Lint/ })).toBeUndefined()
  await ui.unmount()
})

// --- the star map, as pixels ------------------------------------------------------------------
// The hooks module rasterizes wayfinder-maps' canvas view itself and mounts it as an Image; the
// Client laid over it holds the camera and posts a view back, each view one blit. The pictures are
// read back here pixel by pixel: the sky, the frontier star's core, its label, the selection ring.

type Picture = { rgba: string; width: number; height: number }
const SKY = 0x070a12, FRONTIER_CORE = 0x8ad8ff, FRONTIER_LABEL = 0xb3e5ff, WHITE = 0xffffff
// RGBA inline, RGB in the shared file: the step is the bytes a pixel.
function count(p: Picture, colour: number, tolerance = 20): number {
  const b = Uint8Array.fromBase64(p.rgba), step = b.length / (p.width * p.height)
  const r = colour >> 16, g = (colour >> 8) & 255, bl = colour & 255
  let n = 0
  for (let i = 0; i < b.length; i += step) if (Math.abs(b[i]! - r) <= tolerance && Math.abs(b[i + 1]! - g) <= tolerance && Math.abs(b[i + 2]! - bl) <= tolerance) n++
  return n
}
// The pane is 100 columns; the region is 24 rows (60% of 40), its picture 23 rows at 8x16 px a cell.
const W = 800, H = 368

const $mount = ($: Parameters<TestBody>[0]) => $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
async function starmap($: Parameters<TestBody>[0]) {
  const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
  await ui.resize({ columns: 100, rows: 24, in: 'starmap' })
  return ui
}
// Asked as a boolean on purpose: an Image element carries a megabyte of base64, and a failed expectation that
// prints it ends the runner without a report.
const hasImage = async (ui: Awaited<ReturnType<typeof starmap>> | Awaited<ReturnType<typeof $mount>>) => (await ui.find({ type: 'Image', key: 'view' })) !== undefined
const pictureOf = async (ui: Awaited<ReturnType<typeof starmap>>): Promise<Picture> => (await ui.find({ type: 'Image', key: 'view' }))?.props?.source as Picture

test('on Ghostty the star map is a picture: sky, a frontier star, its label, the fog; no browser anywhere', FORGEJO, async ($, on) => {
  const ran = box(on)
  await open($)
  const ui = await starmap($)
  expect(ran.some(a => a[0] === 'node' || a[0] === 'chromium')).toBe(false)
  const pic = await pictureOf(ui)
  expect(pic !== undefined).toBe(true)
  expect([pic.width, pic.height]).toEqual([W, H])
  expect(Uint8Array.fromBase64(pic.rgba).length).toBe(W * H * 4)
  expect(count(pic, SKY, 2)).toBeGreaterThan(W * H * 0.5)        // mostly sky
  expect(count(pic, FRONTIER_CORE, 12)).toBeGreaterThan(8)        // #5's core, a disc a few pixels wide
  expect(count(pic, FRONTIER_LABEL, 12)).toBeGreaterThan(40)      // "#5 takeable" in its label colour
  expect(count(pic, WHITE, 8)).toBe(0)                             // nothing selected yet
  expect(await ui.find({ type: 'Client', key: 'starmap' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^drag or arrows pan  wheel or \+ - zoom .* tab select/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /the star map:/ })).toBeUndefined()
  expect((await ui.find({ key: 'pixels' }))?.text).toMatch(/Star map: on/)
  await ui.unmount()
})

test('Tab selects and centres the first frontier star (a blit with a ring); Enter opens it', FORGEJO, async ($, on) => {
  const ran = box(on)
  await open($)
  const ui = await starmap($)
  await ui.key({ key: 'tab', in: 'starmap' })
  const blit = ran.blits[ran.blits.length - 1]
  expect(blit !== undefined).toBe(true)
  expect(blit?.key).toBe('view')
  expect([blit!.source.width, blit!.source.height]).toEqual([W, H])
  expect(count(blit!.source, WHITE, 8)).toBeGreaterThan(20)        // the selection ring
  // The selected star sits at the picture's centre: its core colour within a few pixels of it.
  const b = Uint8Array.fromBase64(blit!.source.rgba)
  let core = 0
  for (let y = H / 2 - 6; y <= H / 2 + 6; y++) for (let x = W / 2 - 6; x <= W / 2 + 6; x++) {
    const i = (y * W + x) * 4
    if (Math.abs(b[i]! - 0x8a) <= 12 && Math.abs(b[i + 1]! - 0xd8) <= 12 && Math.abs(b[i + 2]! - 0xff) <= 12) core++
  }
  expect(core).toBeGreaterThan(4)
  await ui.key({ key: 'return', in: 'starmap' })
  expect(ran).toContainEqual(['hub-api', '/api/v1/repos/acme/maps/issues/5'])
  expect(ran.filter(a => a[0] === 'hub-api' && /\/issues\/\d+$/.test(String(a[1]))).length).toBeGreaterThan(0)
  // Tab again walks on past the frontier into the rest, in map order: #1, no longer the ring on #5.
  const before = ran.blits.length
  await ui.key({ key: 'tab', in: 'starmap' })
  expect(ran.blits.length).toBeGreaterThan(before)
  await ui.unmount()
})

test('a posted number that names no star opens nothing; a malformed view paints nothing', FORGEJO, async ($, on) => {
  const ran = box(on)
  await open($)
  const ui = await starmap($)
  const blits = ran.blits.length
  await ui.post({ open: 404 }, { in: 'starmap' })
  await ui.post({ open: 'five' }, { in: 'starmap' })
  await ui.post({ view: { cam: { x: 'a', y: 0, s: 1 }, selected: null } }, { in: 'starmap' })
  expect(ran.filter(a => a[0] === 'hub-api' && /\/issues\/\d+$/.test(String(a[1])))).toHaveLength(0)
  expect(ran.blits.length).toBe(blits)
  await ui.post({ open: 5 }, { in: 'starmap' })
  expect(ran.filter(a => a[0] === 'hub-api' && /\/issues\/\d+$/.test(String(a[1]))).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('a click on a star opens it; a drag pans the picture and opens nothing', FORGEJO, async ($, on) => {
  const ran = box(on)
  await open($)
  const ui = await starmap($)
  const blits = ran.blits.length
  await ui.pointer({ type: 'down', x: 10, y: 3, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'move', x: 30, y: 8, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'up', x: 30, y: 8, button: 'left', in: 'starmap' })
  expect(ran.filter(a => a[0] === 'hub-api' && /\/issues\/\d+$/.test(String(a[1])))).toHaveLength(0)
  expect(ran.blits.length).toBeGreaterThan(blits)   // the camera moved: a repaint
  // Pressing on empty sky opens nothing either.
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'starmap' })
  expect(ran.filter(a => a[0] === 'hub-api' && /\/issues\/\d+$/.test(String(a[1])))).toHaveLength(0)
  // Tab centres #5 on the picture; a click on the centre cell is a click on the star, even when the hand
  // wobbles a cell between down and up (the page forwards motion, and that read as a drag).
  await ui.key({ key: 'tab', in: 'starmap' })
  await ui.pointer({ type: 'down', x: 50, y: 11, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'move', x: 51, y: 11, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'up', x: 51, y: 11, button: 'left', in: 'starmap' })
  expect(ran).toContainEqual(['hub-api', '/api/v1/repos/acme/maps/issues/5'])
  expect(ran.filter(a => a[0] === 'hub-api' && /\/issues\/\d+$/.test(String(a[1]))).length).toBeGreaterThan(0)
  await ui.unmount()
})

// The wheel zooms at the pointer: over the picture a tick redraws it zoomed and
// the pane keeps its rows; elsewhere in the pane the wheel scrolls it. PANE_PROPS draws the picture from
// row 8: the close row, "Open maps", two maps, the title, the destination, the bar, the counts.
const tick = (by: number, row = 8) => ({ component: 'Pane' as const, requestId: 'wayfinder-starmap', offset: 1, by, bodyRows: 40,
                                         contentRows: 80, origin: { kind: 'person' as const }, pointer: { column: 30, row } })
test('the wheel over the star map zooms it at the pointer; off the map it scrolls the pane', FORGEJO, async ($, on) => {
  const ran = box(on)
  let scrolled = 0                                                 // ticks that reached the pane's own scroll
  on('ui.scroll', () => { scrolled++; return { value: {} } })
  await open($)
  const ui = await starmap($)
  // The frontier star's core as the picture's fingerprint: a zoom grows it, a pan or a pane scroll does not
  // (sky pixels were, until the fog's wide haze made a pan move as many of them as a zoom does).
  const sky = async () => count(await pictureOf(ui), FRONTIER_CORE, 12)
  const before = await sky()
  await ui.pointer({ type: 'move', x: 30, y: 8, in: 'starmap' })                  // hover: where the wheel would zoom
  expect((await $.ui.scroll(tick(-1)))?.deny).toBeUndefined()
  const zoomed = await sky()
  expect(zoomed).not.toBe(before)                                 // the picture zoomed...
  expect(scrolled).toBe(0)                                         // ...and the pane did not scroll
  // A drag after the zoom starts from the zoomed camera: the input layer took it from its props.
  await ui.pointer({ type: 'down', x: 30, y: 8, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'move', x: 33, y: 8, button: 'left', in: 'starmap' })   // past the press's cell: a drag
  await ui.pointer({ type: 'up', x: 33, y: 8, button: 'left', in: 'starmap' })
  const dragged = count(ran.blits.at(-1)!.source, FRONTIER_CORE, 12)
  expect(Math.abs(dragged - zoomed)).toBeLessThan(Math.abs(dragged - before))
  // Over the map list the wheel is the pane's, though the input layer was last told of a pointer over the
  // picture and never that it left (a terminal dropped the leave, and ticks zoomed the map to its cap).
  // The picture stays where the drag left it (its last blit); a re-render, as the scrollbar's hiding asks,
  // draws that same camera.
  await ui.pointer({ type: 'move', x: 30, y: 8, in: 'starmap' })
  await $.ui.scroll(tick(-1, 2))
  await ui.redraw()                                         // the render now draws the camera there is
  expect(await sky()).toBe(dragged)
  expect(scrolled).toBe(1)
  // Below the picture (its hint row, then the rows) too.
  await $.ui.scroll(tick(1, 8 + 23))
  expect(scrolled).toBe(2)
  await ui.unmount()
})

// Center after a zoom, the picture is the one the pane first drew.
test('Center puts the star map back where it first opened', FORGEJO, async ($, on) => {
  box(on)
  on('ui.scroll', () => ({ value: {} }))
  await open($)
  const ui = await starmap($)
  const sky = async () => count(await pictureOf(ui), SKY, 2)
  const before = await sky()
  await $.ui.scroll(tick(-1)); await $.ui.scroll(tick(-1))
  expect(await sky()).not.toBe(before)
  await ui.press({ key: 'center' })
  expect(await sky()).toBe(before)
  await ui.unmount()
})

// The scrollbar: drawn in the last column where the pane is taller than its window;
// the offset it posts is where the pane goes.
test('a pane taller than its window has a scrollbar; what it posts scrolls the pane there', FORGEJO, async ($, on) => {
  box(on)
  const offsets: number[] = []
  on('ui.scroll', ($, e) => { offsets.push(e.offset); return { value: {} } })
  await open($)
  const ui = await starmap($)
  expect(await ui.find({ key: 'scrollbar' })).toBeDefined()
  await ui.resize({ columns: 1, rows: 40, in: 'scrollbar' })
  // A press at the track's foot asks for the pane's end. The plugin asks the engine to scroll its pane; the
  // kit has no engine for that call, so the test raises what the engine would: ui.scroll, origin plugin.
  await ui.pointer({ type: 'down', x: 0, y: 39, button: 'left', in: 'scrollbar' })
  await ui.pointer({ type: 'up', x: 0, y: 39, button: 'left', in: 'scrollbar' })
  const raised = { ...tick(0), pointer: undefined, offset: 0, origin: { kind: 'plugin' as const, name: 'wayfinder-starmap' } }
  await $.ui.scroll(raised)
  expect(offsets).toHaveLength(1)
  expect(offsets[0]).toBeGreaterThan(0)                    // landed where the scrollbar asked, not at the start
  await $.ui.scroll(raised)                               // the ask is spent: a later scroll goes where it says
  expect(offsets[1]).toBe(0)
  await ui.unmount()
  // A window that holds the whole pane draws none.
  const tall = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 200 } } })
  expect(await tall.find({ key: 'scrollbar' })).toBeUndefined()
  await tall.unmount()
})

// A hidden bar stays mounted (it holds a drag's pointer, and the pointer brings it back) and draws no cells.
const barHidden = async (ui: { find: (q: { key: string }) => Promise<{ props?: Record<string, unknown> } | undefined> }) =>
  ((await ui.find({ key: 'scrollbar' }))?.props?.props as { hidden?: boolean } | undefined)?.hidden === true
// The scrollbar shows only while the pointer is at it: a
// wheel tick that found it drawn moved the rows with it before its hiding landed.
test('the scrollbar shows while the pointer is at it; a wheel scroll hides it until the pointer comes back', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  box(on, 0, GHOSTTY, GRAPH, undefined, false)
  const blankAtMove: boolean[] = []
  on('ui.scroll', async () => { blankAtMove.push(await barHidden(ui)); return { value: {} } })
  await open($)
  const ui = await starmap($)
  await ui.resize({ columns: 1, rows: 40, in: 'scrollbar' })
  expect(await barHidden(ui)).toBe(true)                    // hidden until the pointer comes to it
  await ui.pointer({ type: 'enter', x: 0, y: 5, in: 'scrollbar' })
  expect(await barHidden(ui)).toBe(false)
  await ui.pointer({ type: 'leave', x: 0, y: 5, in: 'scrollbar' })
  expect(await barHidden(ui)).toBe(true)
  await ui.pointer({ type: 'enter', x: 0, y: 5, in: 'scrollbar' })
  const moving = $.ui.scroll(tick(1, 2))
  await clock.advance(50)
  await moving
  expect(blankAtMove).toEqual([true])                       // blank before the engine moved the rows
  await clock.advance(2000)
  expect(await barHidden(ui)).toBe(true)                    // and no timer brings it back
  await ui.pointer({ type: 'move', x: 0, y: 6, in: 'scrollbar' })
  expect(await barHidden(ui)).toBe(false)                   // the pointer does
  await ui.unmount()
})

// A click on the bar too: blank before the plugin asks the engine to move the pane.
test('a click on the scrollbar blanks it before the pane moves there', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  box(on, 0, GHOSTTY, GRAPH, undefined, false)
  on('ui.scroll', () => ({ value: {} }))
  await open($)
  const ui = await starmap($)
  await ui.resize({ columns: 1, rows: 40, in: 'scrollbar' })
  const pressed = ui.pointer({ type: 'down', x: 0, y: 39, button: 'left', in: 'scrollbar' })
  await clock.advance(50)
  await pressed
  expect(await barHidden(ui)).toBe(true)                    // blank by the time the scroll is asked for
  await ui.pointer({ type: 'up', x: 0, y: 39, button: 'left', in: 'scrollbar' })
  await clock.advance(850)
  expect(await barHidden(ui)).toBe(false)
  await ui.unmount()
})

// Over the picture the wheel only zooms, at the cap too: a tick there neither scrolls the pane nor redraws.
// Passed on, it scrolled the rows under a picture the terminal moved only once the wheel stopped.
test('at the zoom cap a tick over the star map neither scrolls the pane nor redraws', FORGEJO, async ($, on) => {
  box(on)
  let scrolled = 0
  on('ui.scroll', () => { scrolled++; return { value: {} } })
  await open($)
  const ui = await starmap($)
  for (let i = 0; i < 60; i++) await $.ui.scroll(tick(-1))   // past the cap
  const capped = count(await pictureOf(ui), SKY, 2)
  await $.ui.scroll(tick(-1))
  expect(count(await pictureOf(ui), SKY, 2)).toBe(capped)
  expect(scrolled).toBe(0)
  await ui.unmount()
})

// One picture a machine: where the terminal reads this machine's files (no SSH_CONNECTION) a pane draws the map once into ~/.cache/wayfinder-starmap, at up to 16 px a cell, and
// every other pane adopts that file and its camera without drawing.
const CMUX = { HOME: '/home/u', TERM: 'xterm-256color', CMUX_TUI_TERMINAL_ID: 'term_abc', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }
const SHARED = { rgba: '/home/u/.cache/wayfinder-starmap/map-4-v3.rgb', meta: '/home/u/.cache/wayfinder-starmap/map-4-v3.json' }
type FileSource = { file: string; format: string; width: number; height: number; generation: number }

// The `fontFile` option: read as /maps opens, and part of the shared picture's signature, so a picture drawn in
// another font is redrawn rather than adopted. One that is not a font keeps the built-in and the pane says so.
const BLOCKS = JSON.stringify({ h: 13, left: 0, adv: Array(95).fill(8), rows: Array.from({ length: 95 }, () => Array(13).fill(0x7f)) })
const sigOf = (ran: ReturnType<typeof box>) => (JSON.parse(ran.files.get(SHARED.meta)!) as { sig: string }).sig
test('with no fontFile the shared picture is signed with the built-in font', FORGEJO, async ($, on) => {
  const ran = box(on, 0, CMUX)
  await open($)
  const ui = await starmap($)
  expect(sigOf(ran)).toMatch(/\|builtin$/)
  await ui.unmount()
})
test('a fontFile font is read from ~ and signs the shared picture with itself', { options: { ...FORGEJO.options, fontFile: '~/fonts/blocks.json' } }, async ($, on) => {
  const ran = box(on, 0, CMUX)
  ran.files.set('/home/u/fonts/blocks.json', BLOCKS)
  await open($)
  const ui = await starmap($)
  expect(sigOf(ran)).toMatch(/\|file-[0-9a-z]+$/)
  expect(await ui.find({ type: 'Text', text: /fontFile/ })).toBeUndefined()
  await ui.unmount()
})
test('a fontFile that is not a font keeps the built-in, and the pane says why', { options: { ...FORGEJO.options, fontFile: '/nope.json' } }, async ($, on) => {
  const ran = box(on, 0, CMUX)
  await open($)
  const ui = await starmap($)
  expect(await ui.find({ type: 'Text', text: /fontFile \/nope\.json: not JSON -- the labels use the built-in font/ })).toBeDefined()
  expect(sigOf(ran)).toMatch(/\|builtin$/)
  await ui.unmount()
})
test('in a local pane the star map is one shared file: drawn once, adopted by another pane, redrawn by a drag here', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })   // the hooks module's poll runs on it
  const ran = box(on, 0, CMUX, GRAPH, undefined, false)
  await open($)
  const ui = await starmap($)
  const src = async () => (await ui.find({ type: 'Image', key: 'view' }))?.props?.source as unknown as FileSource
  const first = await src()
  expect(first.file).toBe(SHARED.rgba)
  expect(first.format).toBe('rgb')                          // the alpha is always 255: not sent
  expect(first.width).toBe(100 * 16)                         // twice the 8 px a cell the inline cap allows
  expect(ran.drawn.length).toBe(1)                          // drawn once, into the file
  expect(Uint8Array.fromBase64(ran.drawn[0]!).length).toBe(first.width * first.height * 3)
  const meta = JSON.parse(ran.files.get(SHARED.meta)!) as { gen: number; sig: string; width: number; height: number; cam: { x: number; y: number; s: number } }
  expect(meta.gen).toBe(first.generation)
  // Another pane moved the map and wrote a newer generation: this pane adopts it and draws nothing.
  ran.files.set(SHARED.meta, JSON.stringify({ ...meta, gen: meta.gen + 5, cam: { ...meta.cam, x: meta.cam.x + 40 }, selected: 5 }))
  await clock.advance(300)                                  // the hooks module's poll
  expect((await src()).generation).toBe(meta.gen + 5)
  expect(ran.drawn.length).toBe(1)
  // A drag here draws (small while it moves, whole when it ends) and moves the shared generation past the other pane's.
  await ui.pointer({ type: 'down', x: 10, y: 3, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'move', x: 30, y: 8, button: 'left', in: 'starmap' })
  await ui.advance(33)                                      // a frame of the glide
  await ui.pointer({ type: 'up', x: 30, y: 8, button: 'left', in: 'starmap' })
  expect(ran.drawn.length).toBe(3)
  expect((JSON.parse(ran.files.get(SHARED.meta)!) as { gen: number }).gen).toBe(meta.gen + 7)
  await ui.unmount()
})

// The wheel on the shared picture: a tick draws the zoomed picture at once, a new generation, as a drag
// does.
test('on the shared picture a wheel tick draws the zoom at once', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  const ran = box(on, 0, CMUX, GRAPH, undefined, false)
  on('ui.scroll', () => ({ value: {} }))
  await open($)
  const ui = await starmap($)
  const gen = async () => ((await ui.find({ type: 'Image', key: 'view' }))?.props?.source as unknown as FileSource).generation
  const drawn = ran.drawn.length, before = await gen()
  await ui.pointer({ type: 'move', x: 30, y: 8, in: 'starmap' })
  await $.ui.scroll(tick(-1))
  expect(ran.drawn.length).toBe(drawn + 1)                  // drawn now, not at the next drag
  expect(await gen()).toBe(before + 1)                      // and this pane shows it
  void clock
  await ui.unmount()
})

// Open tickets only: #1 (resolved) and #2 (out of scope) are not stars, and the lane from #1 to #5 goes with
// #1; the rows below the map still list every ticket. Faint closed blockers: #1 is resolved but blocks open
// #5, so it stays as an unlabeled ghost with its lane; #2 blocks nothing open and is left out.
test('the star map lays out open tickets and the closed ones blocking them, faint; the rows still list the closed ones', FORGEJO, async ($, on) => {
  box(on)
  await open($)
  const ui = await starmap($)
  const props = (await ui.find({ type: 'Client', key: 'starmap' }))?.props?.props as unknown as StarProps
  expect(Object.keys(props.layout.pos).map(Number).sort()).toEqual([1, 3, 4, 5, 6])
  expect(props.nodes.filter(n => n.ghost === true).map(n => n.num)).toEqual([1])
  // Each star's repo, its label's prefix: from its URL (…/o/r/issues/1), else the configured repo's.
  expect(props.nodes.map(n => [n.num, n.repo])).toEqual([[1, 'r'], [3, 'maps'], [4, 'maps'], [5, 'maps'], [6, 'maps']])
  expect(props.edges).toEqual([{ from: 5, to: 4, satisfied: false }, { from: 1, to: 5, satisfied: true }])
  expect((await ui.find({ key: 'open:1' }))?.text).toBeDefined()
  await ui.unmount()
})

// A drag draws every frame whole, so text and stars stay sharp while the map moves.
test('a drag on the shared picture draws every frame whole, as the picture it lets go on', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  const ran = box(on, 0, { ...CMUX, TTY_CELL: '9 16' }, GRAPH, undefined, false)
  await open($)
  const ui = await starmap($)
  const size = () => { const m = JSON.parse(ran.files.get(SHARED.meta)!) as { width: number; camW: number }; return [m.width, m.camW] }
  const rest = size(), whole = Uint8Array.fromBase64(ran.drawn.at(-1)!).length
  await ui.pointer({ type: 'down', x: 10, y: 3, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'move', x: 30, y: 8, button: 'left', in: 'starmap' })
  const before = ran.drawn.length
  await ui.advance(33 * 3)                                  // frames of the glide toward the pointer
  expect(ran.drawn.length).toBeGreaterThan(before)
  expect(ran.drawn.slice(before).every(b => Uint8Array.fromBase64(b).length === whole)).toBe(true)
  expect(size()).toEqual(rest)
  await ui.pointer({ type: 'up', x: 30, y: 8, button: 'left', in: 'starmap' })
  expect(Uint8Array.fromBase64(ran.drawn.at(-1)!).length).toBe(whole)
  void clock
  await ui.unmount()
})

// The picture takes the cell the terminal reports: a browser terminal can report the browser's own cell in
// device pixels, so the picture is that shape exactly, pixel for pixel, and its bytes are no more than the 16x32 RGBA picture's
// were.
test('in a pane that reports its cell the picture is that cell, exactly, in no more bytes than before', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  const ran = box(on, 0, { ...CMUX, TTY_CELL: '16 34' }, GRAPH, undefined, false)
  await open($)
  const ui = await starmap($)
  const src = (await ui.find({ type: 'Image', key: 'view' }))?.props?.source as unknown as FileSource
  expect([src.width, src.height]).toEqual([100 * 16, 23 * 34])     // a 16x34 cell, not 16x32
  const props = (await ui.find({ type: 'Client', key: 'starmap' }))?.props?.props as unknown as StarProps
  expect([props.cw, props.ch]).toEqual([16, 34])                  // the input layer maps cells to the same pixels
  expect(Uint8Array.fromBase64(ran.drawn[0]!).length).toBeLessThanOrEqual(1600 * 736 * 4)
  void clock
  await ui.unmount()
})

test('the picture size: a third more pixels in the same bytes, the cell kept exact, cmux\'s cap never passed', FORGEJO, async () => {
  const before = (cols: number, rows: number) => { const cw = Math.min(16, Math.floor(2048 / cols), Math.floor(1024 / rows)); return cols * cw * rows * cw * 2 * 4 }
  // A wide pane was cut to 10 px a cell by the 2048 side; RGB carries a third more pixels in its bytes.
  const wide = cellPx(200, 40, true, null)
  expect(wide.W * wide.H * 3).toBeLessThanOrEqual(before(200, 40))
  expect(wide.W * wide.H).toBeGreaterThan(200 * 10 * 40 * 20 * 1.3)
  // A 3x display's cell is scaled down whole: its shape kept, its bytes no more than before.
  const dense = cellPx(100, 23, true, { w: 24, h: 51 })
  expect(Math.abs(dense.ch / dense.cw - 51 / 24)).toBeLessThan(0.01)
  expect(dense.W * dense.H * 3).toBeLessThanOrEqual(before(100, 23))
  // A tall pane stays under the 10,000,000 decoded bytes past which cmux drops the picture (2048x2048 RGBA was 16.8 MB).
  const tall = cellPx(255, 200, true, { w: 16, h: 34 })
  expect(tall.W * tall.H * 3).toBeLessThanOrEqual(10_000_000)
  // Inline (over SSH): the 8x16 RGBA picture's pixels, in the reported cell's shape.
  const inline = cellPx(100, 23, false, { w: 16, h: 34 })
  expect(inline.W * inline.H).toBeLessThanOrEqual(800 * 368)
  expect(Math.abs(inline.ch / inline.cw - 34 / 16)).toBeLessThan(0.01)
})

// A 40-column pane takes the hint on three rows, each control whole, and the picture gives those rows up: the
// region stays the 24 rows it was.
test('the controls hint wraps at the controls to a narrow pane, and the picture gives it the rows', FORGEJO, async ($, on) => {
  box(on)
  await open($)
  const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: { ...PANE_PROPS, bodyColumns: 41 } })
  await ui.resize({ columns: 40, rows: 24, in: 'starmap' })
  const image = await ui.find({ type: 'Image', key: 'view' })
  expect(image?.props?.rows).toBe(24 - 3)
  const text = (await ui.findAll({ type: 'Text', text: /^(drag|f fit|click a star)/ })).map(t => t.text)
  expect(text).toEqual(['drag or arrows pan  wheel or + - zoom', 'f fit  tab select  enter opens', 'click a star  esc leave'])
  const props = (await ui.find({ type: 'Client', key: 'starmap' }))?.props?.props as unknown as StarProps
  expect(props.hint).toBe(3)
  await ui.unmount()
})

test('inside tmux the star map is off -- no Image, no Client, a line saying why; the button draws it anyway', FORGEJO, async ($, on) => {
  const ran = box(on, 0, { ...GHOSTTY, TMUX: '/tmp/tmux-1001/default,1,0' })
  await open($)
  const ui = await $.ui.mount({ plugin: 'wayfinder-starmap', surface: 'terminal', component: 'Pane', requestId: 'wayfinder-starmap', props: PANE_PROPS })
  expect(await hasImage(ui)).toBe(false)
  expect(await ui.find({ type: 'Client', key: 'starmap' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /star map: pixels only .* not here/ })).toBeDefined()
  expect((await ui.find({ key: 'open:5' }))?.text).toBe('  ★ #5 takeable [task]')   // the rest of the pane is whole
  expect((await ui.find({ key: 'pixels' }))?.text).toMatch(/Star map: off/)
  await ui.press({ key: 'pixels' })
  expect(await hasImage(ui)).toBe(true)
  expect((await ui.find({ key: 'pixels' }))?.text).toMatch(/Star map: on/)
  await ui.press({ key: 'pixels' })
  expect(await hasImage(ui)).toBe(false)
  expect(ran.blits).toEqual([])
  await ui.unmount()
})

// A cmux pane draws pixels: its env -- TERM xterm-256color, CLAUDE_CODE_FORCE_TERMINAL_IMAGES set -- draws the
// star map.
test('in a cmux pane the star map is drawn: the force-images flag set there', FORGEJO, async ($, on) => {
  box(on, 0, { HOME: '/home/u', TERM: 'xterm-256color', CMUX_TUI_TERMINAL_ID: 'term_abc', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  await open($)
  const ui = await $mount($)
  expect(await hasImage(ui)).toBe(true)
  await ui.unmount()
})

test('a refused blit ends the star map and says why; the force flag had drawn it despite tmux', FORGEJO, async ($, on) => {
  box(on, 0, { HOME: '/home/u', TMUX: 'x', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1', SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }, GRAPH, 'the Image draws its alt there')
  await open($)
  const ui = await starmap($)   // the input layer's fitted view: the first blit, taken
  expect(await hasImage(ui)).toBe(true)
  await ui.key({ key: 'tab', in: 'starmap' })   // the second: refused
  expect(await hasImage(ui)).toBe(false)
  expect(await ui.find({ type: 'Client', key: 'starmap' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /star map: pixels only .* pixels refused: the Image draws its alt there/ })).toBeDefined()
  expect((await ui.find({ key: 'pixels' }))?.text).toMatch(/Star map: off/)
  await ui.unmount()
})

// --- a big map --------------------------------------------------------------------------------- The layout
// pass is O(iterations x n^2) and a render has a budget; a 95-star map once overran the surface
// module's, so the pass is capped by the clock.

function bigGraph(n: number): string {
  const nodes = [], edges = []
  for (let i = 1; i <= n; i++) {
    nodes.push({ num: i, title: `t${i}`, type: 'task', status: i % 3 === 0 ? 'resolved' : i % 3 === 1 ? 'frontier' : 'blocked', rank: i % 5, claimedBy: '', claim: '', blockers: i > 1 ? [i - 1] : [], url: '' })
    if (i > 1) edges.push({ from: i - 1, to: i, satisfied: i % 2 === 0 })
  }
  return JSON.stringify({ map: 4, name: 'big', url: '', destination: '', counts: { total: n }, nodes, edges, fog: [{ title: 'f', clearsWith: 2 }], lint: [] })
}

test('a map of 160 stars is drawn, and a Tab on it repaints', FORGEJO, async ($, on) => {
  const ran = box(on, 0, GHOSTTY, bigGraph(160))
  await open($)
  const t = Date.now()
  const ui = await starmap($)
  const pic = await pictureOf(ui)
  expect(pic !== undefined).toBe(true)
  expect(count(pic, FRONTIER_CORE, 12)).toBeGreaterThan(100)   // 54 frontier stars
  await ui.key({ key: 'tab', in: 'starmap' })
  expect(ran.blits.length).toBeGreaterThan(0)
  console.log(`160 stars: first picture, one blit: ${Date.now() - t} ms`)
  await ui.unmount()
})

// A map switch the input layer's handlers, registered on the first render, hit-tested the first map's stars.
// Map 9 here is 75's shape: #80 closed, blocking #81.
const G75 = JSON.stringify({
  map: 9, name: 'cmux is a pixel target', url: 'https://git.example/o/r/issues/9', destination: 'Pixels.',
  counts: { resolved: 1, claimed: 0, blocked: 0, frontier: 1, out_of_scope: 0, latent: 0, waiting: 0, open: 1, total: 2 },
  nodes: [
    { num: 80, title: 'build from the fork', type: 'task', status: 'resolved', rank: 2, claimedBy: '', claim: '', blockers: [], url: '' },
    { num: 81, title: 'paints and clicks', type: 'task', status: 'frontier', rank: 3, claimedBy: '', claim: '', blockers: [80], url: '' },
  ],
  edges: [{ from: 80, to: 81, satisfied: true }], fog: [], lint: [],
})
test('after switching maps a click on a star of the new map opens it', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  const ran = box(on, 0, CMUX, m => m === '9' ? G75 : GRAPH, undefined, false)
  await open($, '#9')
  const ui = await starmap($)
  await ui.press({ key: 'map:4' })
  const props = (await ui.find({ type: 'Client', key: 'starmap' }))?.props?.props as unknown as StarProps
  expect(Object.keys(props.layout.pos).map(Number).sort()).toEqual([1, 3, 4, 5, 6])
  const { cam } = JSON.parse(ran.files.get(SHARED.meta)!) as { cam: { x: number; y: number; s: number } }
  const q = props.layout.pos[5]!
  const x = Math.floor((q.x * cam.s + cam.x) / props.cw), y = Math.floor((q.y * cam.s + cam.y) / props.ch)
  await ui.pointer({ type: 'down', x, y, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'up', x, y, button: 'left', in: 'starmap' })
  expect(ran).toContainEqual(['hub-api', '/api/v1/repos/acme/maps/issues/5'])
  // Tab walks this map's frontier too, not the first map's: Enter opens #5 again.
  ran.splice(0)
  await ui.key({ key: 'tab', in: 'starmap' })
  await ui.key({ key: 'return', in: 'starmap' })
  expect(ran).toContainEqual(['hub-api', '/api/v1/repos/acme/maps/issues/5'])
  void clock
  await ui.unmount()
})

// A burst of wheel ticks: each redraw of the shared picture goes to every view of it, so the ticks draw one
// at a time with the latest winning, each whole, and nothing is drawn again once the wheel rests.
test('a burst of wheel ticks draws a few whole pictures, one at a time, and nothing more once the wheel rests', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  const ran = box(on, 0, CMUX, GRAPH, undefined, false, 50)
  on('ui.scroll', () => ({ value: {} }))
  await open($)
  const ui = await starmap($)
  const drawn = ran.drawn.length
  const width = () => (JSON.parse(ran.files.get(SHARED.meta)!) as { width: number }).width
  await ui.pointer({ type: 'move', x: 30, y: 8, in: 'starmap' })
  for (let i = 0; i < 10; i++) await $.ui.scroll(tick(-1))
  await new Promise(r => setTimeout(r, 400))                // the draws in flight finish
  const burst = ran.drawn.slice(drawn)
  expect(burst.length).toBeGreaterThan(0)
  expect(burst.length).toBeLessThanOrEqual(3)
  expect(burst.every(b => Uint8Array.fromBase64(b).length === 1600 * 736 * 3)).toBe(true)
  expect(width()).toBe(1600)
  await clock.advance(600)                                  // two polls: the wheel has rested
  await new Promise(r => setTimeout(r, 200))
  expect(ran.drawn.length).toBe(drawn + burst.length)
  await ui.unmount()
})

// A diagonal drag: the pointer comes in whole cells, so a diagonal arrives
// as a staircase -- four right, one down on a shallow one, which a mean of the last three positions still
// drew as runs of right-only steps. The picture glides on the frame clock, so every frame moves it both ways;
// the drag's end lands on the pointer.
test('a staircase drag moves the picture diagonally at every frame, and ends where the pointer let go', FORGEJO, async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 19, 30, 0) })
  const ran = box(on, 0, CMUX, GRAPH, undefined, false)
  await open($)
  const ui = await starmap($)
  const cam = () => (JSON.parse(ran.files.get(SHARED.meta)!) as { cam: { x: number; y: number } }).cam
  const start = cam()
  await ui.pointer({ type: 'down', x: 10, y: 5, button: 'left', in: 'starmap' })
  await ui.pointer({ type: 'move', x: 13, y: 5, button: 'left', in: 'starmap' })   // past a cell: a drag
  const steps: [number, number][] = [[13, 6], [14, 6], [15, 6], [16, 6], [17, 6], [17, 7], [18, 7], [19, 7], [20, 7], [21, 7], [21, 8]]
  let last = cam()
  for (const [i, [x, y]] of steps.entries()) {
    await ui.pointer({ type: 'move', x, y, button: 'left', in: 'starmap' })
    await ui.advance(33)
    const now = cam()
    if (i >= 1) { expect(now.x).not.toBe(last.x); expect(now.y).not.toBe(last.y) }
    last = now
  }
  await ui.pointer({ type: 'up', x: 21, y: 8, button: 'left', in: 'starmap' })
  const end = cam()
  expect(Math.abs(end.x - start.x - 11 * 16)).toBeLessThan(1e-6)  // 11 cells right at 16 px a cell
  expect(Math.abs(end.y - start.y - 3 * 32)).toBeLessThan(1e-6)   // 3 rows down at 32
  void clock
  await ui.unmount()
})
