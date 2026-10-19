import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { MapGraph, MapItem, MapNode, MapRow, MapsSnapshot, Star, StarProps } from '../types'
import { fit, hit, layout, raster, signature, wrap, zoomAt } from './raster'
import type { Cam, Layout, Shape, View } from './raster'
import { listMaps, readGraph, readTicket, sourceOf, unset } from './source'
import { fontFrom, fontId, useFont } from './font'

const PANE = 'wayfinder-starmap'
// A ticket row pressed in the maps pane opens its body here, beside it.
// The star map's input layer in the pane: the surface module hooks/starmap.tsx, laid over the picture.
const STARMAP = 'starmap'
// The pane's scrollbar: the surface module hooks/scrollbar.tsx, in the pane's last column.
const SCROLLBAR = 'scrollbar'
// The tracker and repository the maps are read from: the plugin's settings (hooks/source.ts).
let src = sourceOf({})
// A graph read is one dependency call per child (about four seconds on the live map), so the
// pane refreshes itself rarely; Refresh is a press away.
const REFRESH_MS = 180_000
// A ticket's body shown under the star map: 2,000 characters, not 16,000 -- a closed ticket's long body
// re-rendered with every redraw of the pane locked it for seconds; the rest is a link away.
const BODY_CHARS = 2_000
// The picture's pixels per cell, shrunk for a pane whose picture would pass the engine's 2 MiB.
const CELL_W = 8, IMAGE_BYTES = 2 * 1024 * 1024, IMAGE_CELLS = 255
// ONE PICTURE A MACHINE, however many terminals show the map. Where the terminal runs on this machine (no
// SSH_CONNECTION) the picture is a file the terminal reads itself: the pane whose view changed draws it
// once into ~/.cache/wayfinder-starmap/map-<n>-v3.rgb and bumps the generation in map-<n>-v3.json; every
// other pane showing that map polls the json, adopts its camera and the same file, and draws nothing. A
// file has no 2 MiB inline cap, so it is drawn at up to FILE_CELL_W pixels a cell, 2048 a side. Over SSH
// the terminal cannot read this machine's files: the picture goes inline instead.
// The file is RGB, not RGBA (the alpha is always 255): a quarter fewer bytes for a terminal that forwards
// every frame (a browser terminal); cmux drops a picture of more than FILE_BYTES decoded.
// ponytail: last writer wins, and a picture drawn for one pane's size is scaled into the others'.
const FILE_CELL_W = 16, FILE_BYTES = 10_000_000, SHARED_POLL_MS = 300
// width x height: the file's pixels; camW x camH: the picture the camera is in (older mods drew smaller while dragged).
type Shared = { gen: number; width: number; height: number; camW: number; camH: number; cam: Cam; selected: number | null; sig: string }
let sharedDir: string | null = null   // set at /maps where the terminal reads this machine's files
let adopted = 0                       // the generation this pane shows (its own, or another pane's)

const snapshot = atom({ plugin: 'wayfinder-starmap', key: 'snapshot' } as const, null)
const item = atom({ plugin: 'wayfinder-starmap', key: 'item' } as const, null)
const star = atom({ plugin: 'wayfinder-starmap', key: 'star' } as const, { pixels: false, note: '' } as Star)

// THE STAR MAP, DRAWN HERE. wayfinder-maps' canvas view (its layout, fog, stars, hyperlanes, labels),
// rasterized by hooks/raster.ts into RGBA the engine's Image shows as kitty graphics; no browser, no
// sidecar, no file. The Client laid over the picture holds the camera and posts a view back; each view
// is one blit. PIXELS OR NOTHING: where the terminal cannot draw kitty graphics
// -- inside tmux, a plain xterm -- the pane says so in one line and draws no map.
let shape: { sig: string; shape: Shape; layout: Layout } | null = null
let view: View | null = null
let painted = { cols: 0, rows: 0 }
// The wheel zooms the star map at the pointer; elsewhere in the pane it scrolls.
// Over the picture or not is the tick's own pointer cell, read against where the render put the picture:
// not a hover the input layer posts, whose `leave` a terminal may not deliver, so ticks over the list zoomed the
// map to its cap before the pane moved. `paneTop`: the pane's first row on screen; `mapTop`:
// the picture's first row in the pane's tree, -1 when none is drawn; `pix`: the picture's pixels a cell.
let paneTop = 0, mapTop = -1, pix = { cw: 0, ch: 0 }
// The scrollbar: the pane's height as the render counts it (`estimated`), corrected by the engine's own
// count at the last ui.scroll (`calib`); `scrollTo`, the offset the scrollbar asked for, applied by the
// ui.scroll a plugin scroll raises.
// shortcut: the Markdown body and wrapped lint lines are guessed and the correction is as old as the last
// scroll, so the thumb can be a row or two off after a ticket opens; the next tick puts it right.
let estimated = 0, calib = 0, scrollTo: number | null = null
// The scrollbar is drawn in the pane's rows, so the engine's move of them carried it a row off for a few
// frames before the render put it back: a ghost. Every scroll -- the wheel, keys, a
// click or drag on the bar -- blanks it first and
// lets the move through only after that render has had time to land; it is drawn again at the new place
// once the scrolling has rested. Blanked, not removed: the bar keeps holding a drag's pointer. The wait
// is taken only before a scroll this plugin asks for: a ui.scroll hook that waits is passed over (the
// dispatch goes on without it, its offset rewrite lost), so the wheel's blanking does not wait.
// Shown only while the pointer is at it: a wheel tick
// that found it drawn moved the rows with it before its hiding landed, and any later redraw of it was
// carried by the engine's late paint of the move (measured: the move reaches the screen only after the bar's
// next redraw, however long that is put off). So the wheel hides it and nothing but the pointer brings it back.
const barShown = atom({ plugin: 'wayfinder-starmap', key: 'bar' } as const, false)
const BAR_HIDE_MS = 50, BAR_SHOW_MS = 200
let barTimer: Timer | null = null
async function hideBarWhileScrolling($: EngineInterface, wait: boolean) {
  barTimer?.cancel(); barTimer = null
  if (await read($, barShown)) { await update($, barShown, () => false); if (wait) await $.clock.sleep(BAR_HIDE_MS) }
}
// Called once the engine has applied the move, never before: the move reaches the screen late (about half a
// second after the tick, measured in a browser terminal), and a bar drawn again before it was carried by it, a row off.
function showBarAfterMove($: EngineInterface) {
  barTimer?.cancel()
  barTimer = $.clock.after(BAR_SHOW_MS, () => { barTimer = null; void update($, barShown, () => true) })
}
const zoomed = atom({ plugin: 'wayfinder-starmap', key: 'zoomed' } as const, 0)

// Where the engine would draw pixels: forced by its own env flag, or a kitty-graphics terminal with
// no multiplexer between (the engine will not even ask inside tmux or screen).
async function wantPixels($: EngineInterface): Promise<boolean> {
  if (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) return true
  if (await $.env.get('TMUX') || await $.env.get('STY')) return false
  return (await $.env.get('TERM_PROGRAM')) === 'ghostty' || /ghostty|kitty/.test((await $.env.get('TERM')) ?? '') || Boolean(await $.env.get('KITTY_WINDOW_ID'))
}

// The star map draws open tickets only, plus each closed ticket that directly blocks
// an open one, as a faint unlabeled dot with its lane (a map whose open tickets block each other through
// closed ones drew no lanes at all, open-only). Other closed stars are left out; the rows still list them.
// A fog patch anchored on a closed ticket sits where an unanchored one would.
const isOpen = (n: MapNode) => n.status !== 'resolved' && n.status !== 'out_of_scope'
// The repository a ticket lives in, from its URL (…/<owner>/<repo>/issues/<n>); the configured repo's where it has none.
const repoOf = (n: MapNode) => /\/([^/]+)\/issues\/\d+$/.exec(n.url)?.[1] ?? src.repo.split('/')[1] ?? ''
function shapeOf(g: MapGraph): Shape {
  const open = new Set(g.nodes.filter(isOpen).map(n => n.num))
  const feeds = new Set(g.edges.filter(e => open.has(e.to) && !open.has(e.from)).map(e => e.from))
  return { nodes: g.nodes.filter(n => open.has(n.num) || feeds.has(n.num))
             .map(n => ({ num: n.num, title: n.title, status: n.status, rank: n.rank, repo: repoOf(n), ...(open.has(n.num) ? {} : { ghost: true }) })),
           edges: g.edges.filter(e => (open.has(e.from) || feeds.has(e.from)) && open.has(e.to)), fog: g.fog }
}
// The layout is laid once per graph (it is the slow part) and kept until the graph changes.
function layoutOf(g: MapGraph): { sig: string; shape: Shape; layout: Layout } {
  const s = shapeOf(g), sig = `${signature(s)}|${fontId()}`   // the font too: a shared picture in another is redrawn
  if (shape === null || shape.sig !== sig) { shape = { sig, shape: s, layout: layout(s) }; view = null }
  return shape
}
// The terminal's cell in device pixels, as its pty reports them (ws_xpixel / ws_col); null where it reports
// none. A browser terminal can report the browser's own, the cell's CSS size times its devicePixelRatio, so
// a picture of exactly that shape is shown pixel for pixel: the 2:1 guess was stretched 9% on 7.8x17 cells.
// shortcut: read as /maps opens, so a browser zoom changed after that is picked up at the next /maps.
let ttyCell: { w: number; h: number } | null = null
// The pty of the nearest process above the probe that holds one: the claude session's terminal.
const TTY_CELL = `import os,fcntl,termios,struct
p=os.getppid()
while p>1:
  for fd in (0,1,2):
    try:
      t=os.readlink(f'/proc/{p}/fd/{fd}')
      if not t.startswith('/dev/pts/'): continue
      r,c,x,y=struct.unpack('HHHH',fcntl.ioctl(os.open(t,os.O_RDONLY|os.O_NOCTTY|os.O_NONBLOCK),termios.TIOCGWINSZ,bytes(8)))
      if r and c and x and y: print(x/c,y/r)
      raise SystemExit
    except OSError: pass
  p=int(open(f'/proc/{p}/stat').read().rsplit(')',1)[1].split()[1])`
async function readTtyCell($: EngineInterface): Promise<{ w: number; h: number } | null> {
  const r = await $.process.run(['python3', '-c', TTY_CELL], { timeoutMs: 5_000 })
  const [w, h] = r.stdout.trim().split(' ').map(Number)
  return w !== undefined && h !== undefined && w >= 2 && w <= 256 && h >= 2 && h <= 512 ? { w, h } : null
}
// Pixels per cell for a picture of `cols` x `rows` cells: the terminal's own cell, else 2:1, scaled as a
// whole into the bytes the picture took before -- inline 8x16 RGBA a cell; a file 16x32 RGBA (2048 a
// side), now RGB, so a third more pixels for the same bytes -- and never past the engine's 2 MiB inline or
// cmux's FILE_BYTES. The picture keeps the cell's shape exactly, so a cell's pixels can be fractional.
export function cellPx(cols: number, rows: number, file = false, cell = ttyCell): { cw: number; ch: number; W: number; H: number } {
  const was = file ? Math.max(2, Math.min(FILE_CELL_W, Math.floor(2048 / cols), Math.floor(1024 / rows))) : CELL_W
  const want = cell ?? (file ? { w: FILE_CELL_W, h: 2 * FILE_CELL_W } : { w: CELL_W, h: 2 * CELL_W })
  const most = Math.min(file ? 2 * was * was * 4 / 3 : 2 * was * was, (file ? FILE_BYTES / 3 : IMAGE_BYTES / 4) / (cols * rows))
  const side = file ? 4096 : 2048
  const k = Math.min(1, Math.sqrt(most / (want.w * want.h)), side / (cols * want.w), side / (rows * want.h))
  const W = Math.max(cols, Math.floor(cols * want.w * k)), H = Math.max(rows, Math.floor(rows * want.h * k))
  return { cw: W / cols, ch: H / rows, W, H }
}
// RGBA to RGB, for the file.
function rgbOf(px: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(px.length / 4 * 3)
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { out[j] = px[i]!; out[j + 1] = px[i + 1]!; out[j + 2] = px[i + 2]! }
  return out
}
type Source = { rgba: string; width: number; height: number } | { file: string; format: 'rgb'; width: number; height: number; generation: number }
type Picture = { source: Source; width: number; height: number; layout: Layout; cam: Cam }
// Every frame is drawn whole, a drag's and a wheel tick's too, so text and stars stay sharp while the map
// moves. A terminal that forwards raw pixels to a browser pays about 1 MB a frame for that; one that deflates
// them on the way (a cmux built with deflated pictures) about a tenth.
function rasterOf(g: MapGraph, cols: number, rows: number, file: boolean) {
  const full = cellPx(cols, rows, file), { W, H } = full
  const l = layoutOf(g)
  const fitted = fit(l.layout, l.shape, full.W, full.H)
  const v = view ?? { cam: fitted, selected: null }
  return { px: raster(l.shape, l.layout, v, W, H, fitted.s, (W / cols) / CELL_W), W, H, full, l, fitted, v }
}
// `v3`: claude sessions still running an older mod keep writing `map-<n>-v2.*` (RGBA) and `map-<n>.*`
// (last writer wins); a new name keeps their old picture out of this one's panes. Bump on a drawing change.
const sharedPaths = (dir: string, map: number) => ({ rgba: `${dir}/map-${map}-v3.rgb`, meta: `${dir}/map-${map}-v3.json` })
async function readShared($: EngineInterface, map: number): Promise<Shared | null> {
  if (sharedDir === null) return null
  try { return JSON.parse(await $.fs.read(sharedPaths(sharedDir, map).meta)) as Shared } catch { return null }
}
// This pane's view, drawn once for the machine: the file swapped in whole (a reader never sees half a
// frame), then the generation that names it.
async function drawShared($: EngineInterface, g: MapGraph, cols: number, rows: number): Promise<Picture> {
  const r = rasterOf(g, cols, rows, true)
  const p = sharedPaths(sharedDir!, g.map)
  await $.process.run(['sh', '-c', 'mkdir -p "${1%/*}" && base64 -d > "$1.tmp" && mv -f "$1.tmp" "$1"', 'sh', p.rgba],
                      { stdin: rgbOf(r.px).toBase64(), timeoutMs: 20_000 })
  const gen = Math.max(adopted, (await readShared($, g.map))?.gen ?? 0) + 1
  const meta: Shared = { gen, width: r.W, height: r.H, camW: r.full.W, camH: r.full.H, cam: r.v.cam, selected: r.v.selected, sig: r.l.sig }
  await $.fs.write(p.meta, JSON.stringify(meta))
  adopted = gen
  view = r.v                            // the input layer takes this camera, rather than fitting and drawing again
  return { source: { file: p.rgba, format: 'rgb', width: r.W, height: r.H, generation: gen }, width: r.full.W, height: r.full.H, layout: r.l.layout, cam: r.fitted }
}
async function picture($: EngineInterface, g: MapGraph, cols: number, rows: number): Promise<Picture> {
  if (sharedDir !== null) {
    // Another pane's picture of this map, current for this layout: shown as it is, nothing drawn here.
    const s = await readShared($, g.map)
    const l = layoutOf(g)
    if (s !== null && s.sig === l.sig && (view === null || s.gen >= adopted)) {
      if (s.gen !== adopted) { view = { cam: s.cam, selected: s.selected }; adopted = s.gen }
      const p = sharedPaths(sharedDir, g.map)
      const cw = s.camW ?? s.width, ch = s.camH ?? s.height
      return { source: { file: p.rgba, format: 'rgb', width: s.width, height: s.height, generation: s.gen }, width: cw, height: ch,
               layout: l.layout, cam: fit(l.layout, l.shape, cw, ch) }
    }
    return drawShared($, g, cols, rows)
  }
  const r = rasterOf(g, cols, rows, false)
  return { source: { rgba: new Uint8Array(r.px.buffer, r.px.byteOffset, r.px.byteLength).toBase64(), width: r.W, height: r.H },
           width: r.W, height: r.H, layout: r.l.layout, cam: r.fitted }
}
// Another pane moved the shared picture: adopt it (a redraw hands its camera to the input layer).
async function pollShared($: EngineInterface) {
  const g = (await read($, snapshot))?.graph
  if (sharedDir === null || g == null || painted.cols === 0) return
  const s = await readShared($, g.map)
  if (s !== null && s.gen > adopted && s.sig === layoutOf(g).sig) await update($, zoomed, n => n + 1)
}

// A view the input layer posted: the picture is redrawn and swapped in place. A refusal (the terminal
// draws the Image's alt: no pixels here) ends the star map and says why; the button tries again.
// ponytail: every deny ends it, "not mounted" included; a per-reason rule if that ever flaps.
// One draw at a time, the latest wins: one asked for while a draw runs is drawn once after it (every
// redraw of the shared picture goes to each view of it, and a burst of them overflowed cmux's 32 MiB
// stream buffer and 128 MiB outbound budget).
let drawing = false, again = false
async function repaint($: EngineInterface) {
  if (drawing) { again = true; return }
  drawing = true
  try { await draw($) } finally { drawing = false }
  if (again) { again = false; await repaint($) }
}
async function draw($: EngineInterface) {
  const g = (await read($, snapshot))?.graph
  if (g == null || painted.cols === 0 || !(await read($, star)).pixels) return
  const p = sharedDir !== null ? await drawShared($, g, painted.cols, painted.rows) : await picture($, g, painted.cols, painted.rows)
  const r = await $.ui.blit({ requestId: PANE, key: 'view', source: p.source })
  if (r.deny !== undefined) await update($, star, () => ({ pixels: false, note: `pixels refused: ${String(r.deny).slice(0, 120)}` }))
}

// A click at picture pixel (x, y): the star within a cell of it on the picture this pane shows -- this map's
// layout and the camera it was drawn (or adopted) at -- is selected, redrawn with its ring, and returned.
async function clicked($: EngineInterface, x: number, y: number): Promise<number | null> {
  const g = (await read($, snapshot))?.graph
  if (g == null || painted.cols === 0) return null
  const l = layoutOf(g), full = cellPx(painted.cols, painted.rows, sharedDir !== null)
  const cam = view?.cam ?? fit(l.layout, l.shape, full.W, full.H)
  const num = hit(l.layout, cam, x, y, Math.max(14, full.ch))
  if (num !== null) { view = { cam, selected: num }; await repaint($) }
  return num
}

// The default view: the whole map fitted to the
// picture, as it first opened; the selection stays. Handed to the input layer as the wheel's camera is.
async function center($: EngineInterface) {
  const g = (await read($, snapshot))?.graph
  if (g == null || painted.cols === 0) return
  const l = layoutOf(g), full = cellPx(painted.cols, painted.rows, sharedDir !== null)
  view = { cam: fit(l.layout, l.shape, full.W, full.H), selected: view?.selected ?? null }
  if (sharedDir !== null) await repaint($)
  await update($, zoomed, n => n + 1)
}

// The controls under the picture, packed into lines of the pane's width at the boundaries between them
//; one longer than a line is split at words.
const CONTROLS = ['drag or arrows pan', 'wheel or + - zoom', 'f fit', 'tab select', 'enter opens', 'click a star', 'esc leave']
export function hintLines(cols: number): string[] {
  const lines: string[] = []
  for (const c of CONTROLS.flatMap(c => c.length > cols ? wrap(c, cols, 99) : [c])) {
    const last = lines.at(-1)
    if (last !== undefined && last.length + 2 + c.length <= cols) lines[lines.length - 1] = `${last}  ${c}`
    else lines.push(c)
  }
  return lines
}

// What a star is in wayfinder-maps' star-map, as one glyph: status drives the whole mark.
const GLYPH: Record<MapNode['status'], string> = {
  frontier: '★', claimed: '●', blocked: '○', resolved: '✓', out_of_scope: '✗', latent: '◌', waiting: '⏸',
}
const LEGEND = '★ frontier  ● claimed  ○ blocked  ✓ resolved  ✗ out of scope  ◌ latent  ⏸ waiting'

// The open maps, by number.
async function openMaps($: EngineInterface): Promise<{ maps: MapRow[]; error: string | null }> {
  const why = unset(src)
  if (why !== null) return { maps: [], error: why }
  try { return { maps: await listMaps($, src), error: null } } catch (err) { return { maps: [], error: `maps: ${(err as Error).message}` } }
}

// One map's graph document.
async function graphOf($: EngineInterface, map: number): Promise<{ graph: MapGraph | null; error: string | null }> {
  if (unset(src) !== null) return { graph: null, error: null }
  try { return { graph: await readGraph($, src, map), error: null } } catch (err) { return { graph: null, error: `#${map}: ${(err as Error).message}` } }
}

// The latest refresh writes; one overtaken by another (a second map picked while the first loads) drops
// its answer. `wanted`: the map last picked, set before any wait, so a refresh begun after a pick reads it.
let asked = 0, wanted: number | null = null
async function refresh($: EngineInterface, want?: number) {
  const mine = ++asked
  if (want !== undefined) wanted = want
  const pick = wanted
  const prior = await read($, snapshot)
  // A picked map shows at once: its row marked, the old map gone, "Loading" until its graph lands
  // (a click gave no sign until the map had drawn).
  if (mine === asked && want !== undefined && prior !== null && want !== prior.chosen) {
    await update($, snapshot, s => s === null ? s : { ...s, chosen: want, graph: null, loading: true })
    await update($, item, () => null)
  }
  const [found, early] = await Promise.all([openMaps($), pick === null ? null : graphOf($, pick)])
  const chosen = pick ?? prior?.chosen ?? found.maps[0]?.number ?? null
  const got = early ?? (chosen === null ? { graph: null, error: null } : await graphOf($, chosen))
  if (mine !== asked) return
  const snap: MapsSnapshot = {
    at: await $.clock.now(), maps: found.maps, chosen, graph: got.graph,
    errors: [found.error, got.error, fontError].filter((x): x is string => x !== null),
  }
  await update($, snapshot, () => snap)
}

// The `fontFile` option: a font font-gen.html saved, read as /maps opens (so an edited file is picked up then).
// One that cannot be read or is not a font keeps the built-in font, and the pane says why.
let fontError: string | null = null
async function loadFont($: EngineInterface, path: string) {
  fontError = null
  if (path === '') { useFont(null); return }
  const full = path.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}${path.slice(1)}` : path
  let f: ReturnType<typeof fontFrom>
  try { f = fontFrom(await $.fs.read(full)) } catch (err) { f = (err as Error).message }
  useFont(typeof f === 'string' ? null : f)
  if (typeof f === 'string') fontError = `fontFile ${full}: ${f} -- the labels use the built-in font`
}

async function refreshIfOpen($: EngineInterface) {
  if ((await $.ui.panes()).some(p => p.id === PANE)) await refresh($)
}

// The pane draws text the engine refuses if it holds control characters; keep newlines only.
function printable(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
}

async function openItem($: EngineInterface, node: MapNode) {
  const label = `#${node.num}`
  let shown: MapItem
  try {
    const row = await readTicket($, src, node.num)
    const body = printable(row.body)
    shown = {
      label, title: row.title || node.title, url: row.url || node.url,
      body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}\n\n*(cut at ${BODY_CHARS} characters; the rest is at the link)*` : body,
      error: null, node,
    }
  } catch (err) {
    shown = { label, title: node.title, url: node.url, body: '', error: `${label}: ${(err as Error).message}`, node }
  }
  // Shown under the star map, one at a time, not in a pane of its own.
  await update($, item, () => shown)
}

// [Assign] hands an open ticket to the session this pane is drawn in, as the person's own prompt: it
// runs as a turn of its own once the session is idle.
async function assign($: EngineInterface, node: MapNode) {
  const repo = /\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(node.url)?.[1] ?? src.repo
  await $.prompt.submit({ text: `Work on issue ${repo}#${node.num}: ${node.title}`, asUser: true })
  $.ui.toast(`#${node.num} assigned to this session`)
}
const ASSIGN_COLS = '[ Assign ]'.length + 1

function CloseRow($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, id: string) {
  const { Box, Button } = ui
  return (
    <Box>
      <Box flexGrow={1} />
      <Button key={`close:${id}`} label="  ✕  Close  " onPress={() => $.ui.close({ id })} />
    </Box>
  )
}

// ponytail: counts UTF-16 units, not cells; a title of wide characters can overrun by a few.
function fitText(text: string, cols: number): string {
  return text.length <= cols ? text : `${text.slice(0, Math.max(cols - 1, 0))}…`
}

// One ticket as one row: indented by its rank (a blocker always draws above what it blocks), the
// status glyph, the number and title, its type, and the blockers still holding it.
function row(node: MapNode, open: Set<number>): string {
  const held = node.blockers.filter(b => open.has(b))
  return `${'  '.repeat(Math.min(node.rank, 8))}${GLYPH[node.status]} #${node.num} ${node.title}`
    + `${node.type === '' ? '' : ` [${node.type}]`}`
    + `${node.status === 'claimed' ? ` (${node.claimedBy}${node.claim === '' ? '' : `, ${node.claim}`})` : ''}`
    + `${held.length === 0 ? '' : ` ← ${held.map(b => `#${b}`).join(' ')}`}`
}

function bar(done: number, total: number, cells: number): string {
  const n = total === 0 ? 0 : Math.round((done / total) * cells)
  return `${'█'.repeat(n)}${'░'.repeat(cells - n)} ${done}/${total}`
}

const isView = (v: unknown): v is View => {
  const x = v as { cam?: { x?: unknown; y?: unknown; s?: unknown }; selected?: unknown } | null
  return x != null && typeof x.cam?.x === 'number' && typeof x.cam.y === 'number' && typeof x.cam.s === 'number' && x.cam.s > 0
    && (x.selected === null || typeof x.selected === 'number')
}

export const register: Register = (on, options) => {
  src = sourceOf(options)
  const fontFile = typeof options.fontFile === 'string' ? options.fontFile.trim() : ''
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'maps', description: 'Open the maps pane: the open wayfinder maps, each as its star map, frontier, claims, blockers, fog and lint' })
    $.clock.every(REFRESH_MS, () => {
      void refreshIfOpen($)
    })
    $.clock.every(SHARED_POLL_MS, () => {
      void pollShared($)
    })
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'maps' && e.command !== 'wayfinder-starmap:maps') return next(e)
    await $.ui.open({ id: PANE, title: 'Maps' })
    // Decided as the pane opens: the environment's word, until the button says otherwise.
    const pixels = await wantPixels($)
    await update($, star, () => ({ pixels, note: '' }))
    ttyCell = await readTtyCell($)
    await loadFont($, fontFile)
    const home = await $.env.get('HOME')
    sharedDir = (await $.env.get('SSH_CONNECTION')) || !home ? null : `${home}/.cache/wayfinder-starmap`
    const want = /^\s*#?(\d+)\s*$/.exec(e.args ?? '')
    await refresh($, want === null ? undefined : Number(want[1]))
    return { text: 'Maps pane opened.' }
  }).catch(($, e, next) => next(e))   // a failure here must not swallow the event

  // The input layer posts `{ open }` for a clicked or Enter-ed star and `{ view }` for a moved camera
  // or a changed selection; `data` is the module's word, so only a number naming a node of the drawn
  // graph opens anything, and only a well-formed view is painted.
  on('ui.message', async ($, e, next) => {
    if (e.requestId === PANE && e.element === SCROLLBAR) {
      const to = (e.data as { scrollTo?: unknown } | null)?.scrollTo
      // `start` raises ui.scroll from this plugin; the hook below lands it on the asked offset instead.
      const reveal = (e.data as { reveal?: unknown } | null)?.reveal
      if (typeof reveal === 'boolean') { barTimer?.cancel(); barTimer = null; await update($, barShown, () => reveal); return {} }
      if (typeof to === 'number' && Number.isFinite(to)) { scrollTo = to; await hideBarWhileScrolling($, true); try { await $.ui.scroll({ in: PANE, to: 'start' }) } finally { showBarAfterMove($) } }
      return {}
    }
    if (e.requestId !== PANE || e.element !== STARMAP) return next(e)
    const data = e.data as { open?: unknown; view?: unknown; click?: { x?: unknown; y?: unknown } } | null
    const c = data?.click
    const open = typeof c?.x === 'number' && typeof c.y === 'number' ? await clicked($, c.x, c.y) : data?.open
    const node = (await read($, snapshot))?.graph?.nodes.find(n => n.num === open)
    if (node !== undefined) await openItem($, node)
    if (isView(data?.view)) { view = { cam: { ...data.view.cam }, selected: data.view.selected }; await repaint($) }
    return {}
  })

  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    calib = e.contentRows - estimated
    if (e.origin.kind === 'plugin' && scrollTo !== null) {
      const to = Math.max(0, Math.min(Math.round(scrollTo), e.contentRows - e.bodyRows))
      scrollTo = null; paneTop = to
      return next({ ...e, offset: to })
    }
    const p = e.pointer
    const row = p === undefined || mapTop < 0 ? -1 : paneTop + p.row - mapTop
    const over = p !== undefined && row >= 0 && row < painted.rows && p.column >= 0 && p.column < painted.cols
    // Wheel up (`by` < 0) zooms in, 1.25x a tick, about the pixel under the pointer.
    const cam = over && view !== null && e.origin.kind === 'person' && e.by !== 0
      ? zoomAt(view.cam, (p.column + 0.5) * pix.cw, (row + 0.5) * pix.ch, view.cam.s * 1.25 ** -e.by) : null
    // Off the picture the tick scrolls the pane.
    if (cam === null || view === null) {
      if (e.origin.kind === 'person' && e.contentRows > e.bodyRows) await hideBarWhileScrolling($, false)
      paneTop = Math.max(0, Math.min(e.offset, e.contentRows - e.bodyRows))
      return next(e)
    }
    // Over it the wheel only ever zooms: at the cap the tick is spent here. Passed on, it scrolled the rows
    // under a picture the terminal moved only once the wheel stopped.
    if (cam.s === view.cam.s) return {}
    view = { ...view, cam }
    // The shared picture is drawn here, as a drag's is: a redraw alone would show the file as it
    // was (its generation unchanged) until something else drew -- the zoom that "took effect late". Not
    // waited for, so a burst of ticks is a few draws.
    if (sharedDir !== null) void repaint($)
    await update($, zoomed, n => n + 1)          // a redraw: the picture (inline), the camera handed down
    return {}                                    // no `next`: the pane keeps its rows
  }).catch(($, e, next) => next(e))   // a failure here must not swallow the event

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) { view = null; mapTop = -1; painted = { cols: 0, rows: 0 } }
    return next(e)
  }).catch(($, e, next) => next(e))   // a failure here must not swallow the event

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Client, Image, Link, Markdown, Text } = ui
    const snap = await read($, snapshot)
    const shown = await read($, item)
    const side = await read($, star)
    const camSeq = await read($, zoomed)
    const barOn = await read($, barShown)
    // The last column is the scrollbar's.
    const cols = Math.max(1, e.props.bodyColumns - 1)
    if (snap === null) return <Text dimColor>Loading...</Text>
    paneTop = e.props.scroll?.offset ?? 0
    const g = snap.graph
    const c = g?.counts ?? {}
    const open = new Set((g?.nodes ?? []).filter(n => n.status !== 'resolved').map(n => n.num))
    // Rank order, map order within a rank: the star-map's radial layout, read top to bottom.
    const nodes = (g?.nodes ?? []).map((n, i) => ({ n, i })).sort((a, b) => a.n.rank - b.n.rank || a.i - b.i).map(x => x.n)
    // The star map takes the upper part of the pane; the rows below it scroll. A map of one star
    // still gets room to be a map. The picture is the region less its last rows, the hint's.
    const starRows = Math.max(12, Math.min(30, Math.floor((e.props.scroll?.bodyRows ?? 30) * 0.6)))
    const hint = hintLines(cols)
    const picCols = Math.min(IMAGE_CELLS, cols), picRows = Math.min(IMAGE_CELLS, starRows - hint.length)
    let pic: Picture | null = null
    if (g !== null && side.pixels && picCols > 0) { painted = { cols: picCols, rows: picRows }; pic = await picture($, g, picCols, picRows) }
    // The rows above the picture, each one row (truncated where it could wrap): the close row, "Open
    // maps", the map rows (or "none"), the map's title, its destination, the bar and the counts.
    // shortcut: a map title of wide characters fitText under-counts can wrap a row and put this one off; a
    // measured position from the engine if that is ever seen.
    mapTop = pic === null || g === null ? -1 : 3 + Math.max(1, snap.maps.length) + (g.destination !== '' ? 1 : 0) + 2
    if (pic !== null) pix = { cw: pic.width / picCols, ch: pic.height / picRows }
    // The pane's rows, counted as the tree below lays them out, for the scrollbar.
    const wrapped = (t: string) => t.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cols)), 0)
    estimated = 3 + Math.max(1, snap.maps.length) + (snap.loading === true ? 1 : 0) + snap.errors.length + (g === null ? 0
      : 3 + (g.destination !== '' ? 1 : 0) + (pic !== null ? starRows : 0) + (side.pixels ? 0 : 2)
        + (shown === null ? 0 : wrapped(`${shown.label} ${shown.title}`) + (shown.url !== '' ? 2 : 0) + (shown.error !== null ? 1 : wrapped(shown.body || ' ')))
        + 1 + nodes.length + 1 + g.fog.length + 1 + g.lint.reduce((n, d) => n + wrapped(`${d.level}: ${d.num === null ? '' : `#${d.num}: `}${d.msg}`), 0))
    const body = e.props.scroll?.bodyRows ?? 0, rows = estimated + calib
    const props: StarProps | null = g === null || pic === null ? null
      : { nodes: shapeOf(g).nodes, edges: shapeOf(g).edges, fog: g.fog, layout: pic.layout, cw: pic.width / picCols, ch: pic.height / picRows, cam: view?.cam ?? null, camSeq, startCam: sharedDir !== null ? view?.cam ?? null : null, shared: sharedDir !== null, hint: hint.length }

    return (
      // `cols` wide: right-aligned buttons (Close, Center) end left of the scrollbar, not under it.
      <Box flexDirection="column" width={cols}>
        {CloseRow($, ui, PANE)}
        <Text bold>Open maps: {snap.maps.length}</Text>
        {snap.maps.length === 0 && <Text dimColor>none</Text>}
        {snap.maps.map(m => (
          <Button key={`map:${m.number}`} plain onPress={() => refresh($, m.number)}>
            {fitText(`${m.number === snap.chosen ? '▸' : ' '} #${m.number} ${m.title}`, cols)}
          </Button>
        ))}
        {snap.loading === true && snap.chosen !== null && <Text dimColor>Loading map #{snap.chosen}...</Text>}
        {g !== null && (
          <Box flexDirection="column">
            <Text bold wrap="truncate">#{g.map} {g.name}</Text>
            {g.destination !== '' && <Text dimColor>{fitText(g.destination.split('\n')[0] ?? '', cols)}</Text>}
            <Text wrap="truncate">{bar(c.resolved ?? 0, c.total ?? 0, Math.max(10, Math.min(40, cols - 12)))}</Text>
            <Box>
            <Text wrap="truncate">
              {c.resolved ?? 0} resolved · {c.claimed ?? 0} claimed · {c.open ?? 0} open · {c.out_of_scope ?? 0} out of scope
              {(c.latent ?? 0) > 0 ? ` · ${c.latent} latent` : ''}{(c.waiting ?? 0) > 0 ? ` · ${c.waiting} waiting` : ''}
              {' '}· frontier {c.frontier ?? 0}
            </Text>
            <Box flexGrow={1} />
            {pic !== null && <Button key="center" label=" Center " onPress={() => center($)} />}
            </Box>
            {pic !== null && props !== null && (
              <Box flexDirection="column" height={starRows}>
                <Image key="view" source={pic.source} columns={picCols} rows={picRows} alt="the star map, as pixels" />
                {hint.map((line, i) => <Text key={`hint:${i}`} dimColor wrap="truncate">{line}</Text>)}
                <Box position="absolute" top={0} left={0}>
                  <Client key={STARMAP} module="./starmap.tsx" props={props} width={picCols} height={starRows} />
                </Box>
              </Box>
            )}
            {!side.pixels && (
              <Text dimColor wrap="wrap">
                star map: pixels only -- a kitty-graphics terminal outside tmux (Ghostty, kitty, WezTerm)
                {side.note === '' ? '; not here' : `; ${side.note}`}
              </Text>
            )}
            {shown !== null && (
              <Box flexDirection="column">
                <Box>
                  <Text bold wrap="wrap">{shown.label} {shown.title}</Text>
                  <Box flexGrow={1} />
                  {isOpen(shown.node) && <Button key="assign:item" label="Assign" onPress={() => assign($, shown.node)} />}
                  <Button key="close:item" label=" ✕ " onPress={() => update($, item, () => null)} />
                </Box>
                {/* The URL alone on its row: a terminal's Ctrl/Cmd+click reads a link out of the row's text, and a
                    hint beside it ran on into the URL (and opened a 404). */}
                {shown.url !== '' && <Link href={shown.url}>{shown.url}</Link>}
                {shown.url !== '' && <Text dimColor>Ctrl/Cmd+click the link to open it</Text>}
                {shown.error !== null && <Text color="error">{shown.error}</Text>}
                {shown.error === null && (shown.body === ''
                  ? <Text dimColor>(no description)</Text>
                  : <Markdown key="body" text={shown.body} />)}
              </Box>
            )}
            <Text dimColor>{fitText(LEGEND, cols)}</Text>
            {nodes.map(n => (
              <Box key={`row:${n.num}`}>
                <Button key={`open:${n.num}`} plain onPress={() => openItem($, n)}>
                  <Text dimColor={!isOpen(n)}
                        color={n.status === 'frontier' ? 'warning' : n.status === 'claimed' ? 'success' : undefined}>
                    {fitText(row(n, open), cols - (isOpen(n) ? ASSIGN_COLS : 0))}
                  </Text>
                </Button>
                <Box flexGrow={1} />
                {isOpen(n) && (
                  <Box flexShrink={0}>
                    <Button key={`assign:${n.num}`} label="Assign" onPress={() => assign($, n)} />
                  </Box>
                )}
              </Box>
            ))}
            <Text bold>Fog: {g.fog.length} patch{g.fog.length === 1 ? '' : 'es'}</Text>
            {g.fog.map((f, i) => (
              <Text key={`fog:${i}`} dimColor>
                {fitText(`~ ${f.title === '' ? '(untitled)' : f.title}${f.clearsWith === 0 ? '' : ` (clears with #${f.clearsWith})`}`, cols)}
              </Text>
            ))}
            <Text bold>
              Lint: {g.lint.length === 0 ? `clean -- ${g.nodes.length} tickets, no drift`
                : `${g.lint.filter(d => d.level === 'error').length} error(s), ${g.lint.filter(d => d.level !== 'error').length} warning(s)`}
            </Text>
            {g.lint.map((d, i) => (
              <Text key={`lint:${i}`} color={d.level === 'error' ? 'error' : 'warning'} wrap="wrap">
                {d.level}: {d.num === null ? '' : `#${d.num}: `}{d.msg}
              </Text>
            ))}
          </Box>
        )}
        {snap.errors.map(err => <Text key={`err:${err}`} color="error">{err}</Text>)}
        {rows > body && (
          <Box position="absolute" top={paneTop} left={cols}>
            <Client key={SCROLLBAR} module="./scrollbar.tsx" props={{ offset: paneTop, bodyRows: body, contentRows: rows, hidden: !barOn }} width={1} height={body} />
          </Box>
        )}
        <Box>
          <Text dimColor>updated {new Date(snap.at).toISOString().slice(11, 19)} UTC </Text>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          {g !== null && (
            <Button key="pixels" label={side.pixels ? ' Star map: on ' : ' Star map: off '}
                    onPress={() => update($, star, s => ({ pixels: !s.pixels, note: '' }))} />
          )}
        </Box>
      </Box>
    )
  })
}
