import { expect, test } from 'claude-code/testing'
import { textWidth } from '../hooks/font'
import { fit, glyphsSampled, layout, raster, wrap } from '../hooks/raster'
import type { Shape } from '../hooks/raster'

// The star map's labels: they grow with zoom as the stars do, and a title is cut only to the room the picture
// has for it.
const LABEL = 0xb3e5ff                                     // a frontier star's label
function labelPixels(title: string, zoom: number, W = 1600, H = 736, scale = 2): number {
  const shape: Shape = { nodes: [{ num: 7, title, status: 'frontier', rank: 0 }, { num: 8, title: 'b', status: 'frontier', rank: 1 }],
                         edges: [{ from: 7, to: 8, satisfied: false }], fog: [] }
  const l = layout(shape), f = fit(l, shape, W, H), q = l.pos[7]!
  const s = f.s * zoom, cam = { s, x: W * 0.05 - q.x * s, y: H / 2 - q.y * s }   // star 7 at the left edge
  const px = raster(shape, l, { cam, selected: null }, W, H, f.s, scale)
  let n = 0
  for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i]! - (LABEL >> 16)) <= 20 && Math.abs(px[i + 1]! - ((LABEL >> 8) & 255)) <= 20 && Math.abs(px[i + 2]! - (LABEL & 255)) <= 20) n++
  return n
}

test('a label keeps growing with zoom past 16x, as its star does', async () => {
  expect(labelPixels('Image budgets', 36) / labelPixels('Image budgets', 16)).toBeGreaterThan(1.5)
})


//
const SKY = 0x070a12, FOG = 0x8c70d8
const rgb = (c: number) => [c >> 16, (c >> 8) & 255, c & 255] as const
function draw(title: string, zoom: number, fogTitle = '', W = 1600, H = 736) {
  const shape: Shape = { nodes: [{ num: 7, title, status: 'frontier', rank: 0, repo: 'TrackerApp' }, { num: 8, title: 'b', status: 'claimed', rank: 1, repo: 'TrackerApp' }],
                         edges: [{ from: 7, to: 8, satisfied: false }], fog: fogTitle === '' ? [] : [{ title: fogTitle, clearsWith: 0 }] }
  const l = layout(shape), f = fit(l, shape, W, H), q = l.pos[7]!
  const s = f.s * zoom, cam = { s, x: W * 0.05 - q.x * s, y: H / 2 - q.y * s }
  return { px: raster(shape, l, { cam, selected: null }, W, H, f.s, 2), W }
}
// Pixels of `c` itself, and pixels part way between the sky and `c` (an antialiased edge over the sky).
function tally(px: Uint8ClampedArray, c: number) {
  const [r, g, b] = rgb(c), [sr, sg, sb] = rgb(SKY)
  let full = 0, part = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
  for (let i = 0; i < px.length; i += 4) {
    const t = (px[i]! - sr) / (r - sr)
    const on = Math.abs(px[i + 1]! - (sg + (g - sg) * t)) <= 6 && Math.abs(px[i + 2]! - (sb + (b - sb) * t)) <= 6
    if (Math.abs(px[i]! - r) <= 20 && Math.abs(px[i + 1]! - g) <= 20 && Math.abs(px[i + 2]! - b) <= 20) {
      full++; const p = i / 4; x0 = Math.min(x0, p % 1600); x1 = Math.max(x1, p % 1600); y0 = Math.min(y0, Math.floor(p / 1600)); y1 = Math.max(y1, Math.floor(p / 1600))
    } else if (on && t > 0.2 && t < 0.8) part++
  }
  return { full, part, w: x1 - x0, h: y1 - y0 }
}

// The label font is a pixel font: at a whole size each of its pixels is drawn whole, never blended part way
// into the sky. (A dozen pixels of the star's feathered core fall between those colours too, a larger share
// of a 1x label.) Between whole sizes it grows smoothly, twice its size only past 6x the fitted zoom.
function labelAt(zoom: number, scale: number) {
  const shape: Shape = { nodes: [{ num: 7, title: 'x', status: 'frontier', rank: 0, repo: 'TrackerApp' }, { num: 8, title: 'b', status: 'claimed', rank: 1, repo: 'TrackerApp' }],
                         edges: [{ from: 7, to: 8, satisfied: false }], fog: [] }
  const W = 1600, H = 736, l = layout(shape), f = fit(l, shape, W, H), q = l.pos[7]!
  const s = f.s * zoom, cam = { s, x: W * 0.05 - q.x * s, y: H / 2 - q.y * s }
  return tally(raster(shape, l, { cam, selected: null }, W, H, f.s, scale), LABEL)
}
test('a label at a whole size is whole font pixels, and between sizes grows smoothly to 2x past 6x zoom', async () => {
  const one = 13 / 11                                       // the scale at which the fitted label is 1 px a font pixel
  for (const zoom of [1, 2 ** (8 / 3)]) {                   // 1 and 2 px a font pixel
    const t = labelAt(zoom, one)
    expect(t.full).toBeGreaterThan(0)
    expect(t.part / t.full).toBeLessThan(0.03)              // the core's few; a blended label measured 68%
  }
  const heights = [1, 1.5, 2, 3, 4, 2 ** (8 / 3)].map(zoom => labelAt(zoom, one).h)
  for (let i = 1; i < heights.length; i++) {
    expect(heights[i]!).toBeGreaterThan(heights[i - 1]!)    // every step grows it
    expect(heights[i]! / heights[i - 1]!).toBeLessThan(1.35) // and none jumps
  }
  expect(heights[4]! / heights[0]!).toBeLessThan(1.9)       // still short of twice the size at 4x zoom
})

test('a fog patch title wraps whole rather than being cut at 26 characters', async () => {
  const fog = 'The roll-up report Artifact and everything it reads'   // 51 characters
  const whole = tally(draw('b', 1, fog).px, FOG).full, cut = tally(draw('b', 1, fog.slice(0, 26)).px, FOG).full
  expect(whole / cut).toBeGreaterThan(1.3)
})

test('wrap breaks at words, splits a word longer than a line, and ends what does not fit with "..."', async () => {
  expect(wrap('#81 Task (with a teammate): /maps in a new cmux terminal', 24, 6)).toEqual(['#81 Task (with a', 'teammate): /maps in a', 'new cmux terminal'])
  expect(wrap('profiles/node_modules/adapter', 10, 6)).toEqual(['profiles/n', 'ode_module', 's/adapter'])
  expect(wrap('one two three four five six', 9, 2)).toEqual(['one two', 'three...'])
})

// Sampling every pixel of every character each frame made a drag's frame 13x slower; a glyph's mask is drawn
// once a size and reused.
test('a redraw at the same text size reuses its glyphs: it samples none from the master', async () => {
  const title = 'Infra: point the deploy tool at the auth broker through its account config and a systemd credential'
  const before = glyphsSampled()
  draw(title, 2.25)                                       // a text size no test above draws
  const first = glyphsSampled() - before
  draw(title, 2.25); draw(title, 2.25)
  expect(first).toBeGreaterThan(5)
  expect(glyphsSampled() - before).toBe(first)
})

//
test('a star is labelled with its repo and number only: a long title draws exactly as a one-letter one', async () => {
  const long = tally(draw('Upstream flags on `tool run test` and the rest', 1).px, LABEL)
  const short = tally(draw('b', 1).px, LABEL)
  expect(long.full).toBe(short.full)
  expect(long.w).toBe(short.w)
  expect(short.w).toBeGreaterThan(textWidth('TrackerApp') * 2)      // "TrackerApp#7": past the ten letters of the repo, 2 px a font pixel
})

// A star's core is solid only at its heart and fades into its bloom over the outer part, not a disc with a
// hard rim.
test('a star core is feathered: solid at its heart, fading over its outer part with no hard rim', async () => {
  const shape: Shape = { nodes: [{ num: 7, title: 'a', status: 'frontier', rank: 0 }], edges: [], fog: [] }
  const W = 400, H = 400, l = layout(shape), f = fit(l, shape, W, H), q = l.pos[7]!, s = f.s * 9
  const px = raster(shape, l, { cam: { s, x: W / 2 - q.x * s, y: H / 2 - q.y * s }, selected: null }, W, H, f.s, 2)
  const cr = 2 * 9 * 1.3                                    // scale 2, 3 * sqrt(9), the frontier's 1.3
  const [r, g, b] = rgb(0x8ad8ff)
  const near = (x: number) => { const i = (H / 2 * W + x) * 4; return Math.abs(px[i]! - r) + Math.abs(px[i + 1]! - g) + Math.abs(px[i + 2]! - b) }
  let solid = 0
  while (near(W / 2 - solid) <= 12) solid++                // the run of core colour leftward from the centre
  expect(solid).toBeGreaterThan(cr * 0.4)
  expect(solid).toBeLessThan(cr * 0.8)                       // a hard disc stays solid to cr
  // From the solid edge outward the colour moves away from the core's in small steps -- no rim.
  let worst = 0
  for (let d = solid; d < cr * 1.4; d++) worst = Math.max(worst, near(W / 2 - d - 1) - near(W / 2 - d))
  expect(worst).toBeLessThan(60)
})

// A star's halo, now looked up from a table rather than computed per pixel (it was 70% of a
// frame): over the sky it still falls off as exp(-3 d²)(1 - d²) from the frontier's 0.55, to within a unit.
test('a halo over the sky falls off as the Gaussian it was', async () => {
  const shape: Shape = { nodes: [{ num: 7, title: 'a', status: 'frontier', rank: 0 }], edges: [], fog: [] }
  const W = 400, H = 400, l = layout(shape), f = fit(l, shape, W, H), q = l.pos[7]!, s = f.s
  const px = raster(shape, l, { cam: { s, x: W / 2 + 0.5 - q.x * s, y: H / 2 + 0.5 - q.y * s }, selected: null }, W, H, f.s, 1)
  const R = 3 * 9, sky = rgb(SKY), glow = rgb(0x2f9be0)        // radius 3 at zoom 1, scale 1; a frontier's halo is 9 of it
  let worst = 0
  for (const [dx, dy] of [[0, -14], [-18, 0], [0, 22], [-11, -11]] as const) {
    const d2 = (dx * dx + dy * dy) / (R * R), a = 0.55 * Math.exp(-3 * d2) * (1 - d2), i = ((H / 2 + dy) * W + W / 2 + dx) * 4
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(px[i + k]! - (sky[k]! + (glow[k]! - sky[k]!) * a)))
  }
  expect(worst).toBeLessThanOrEqual(1)
})

// The lanes: a lane is
// stroked antialiased, so pixels along its edges take part of its colour, and it is about 1.5 px wide at 8
// px a cell -- the square dots it replaced were a pixel wide and either on or off.
// The ink a lane lays per px of its length, from 34% to 45% along it (clear of both stars' halos, 162 px at
// 36x, and of the arrowhead at its middle), and how many pixels by its edges it covers partly against fully.
// `zoom` is over the fit.
function lane(zoom: number) {
  const shape: Shape = { nodes: [{ num: 7, title: 'a', status: 'frontier', rank: 0 }, { num: 8, title: 'b', status: 'frontier', rank: 1 }],
                         edges: [{ from: 7, to: 8, satisfied: true }], fog: [] }
  const W = 800, H = 600, l = layout(shape), f = fit(l, shape, W, H), a = l.pos[7]!, b = l.pos[8]!
  const s = 500 / Math.hypot(b.x - a.x, b.y - a.y), cam = { s, x: W / 2 - (a.x + b.x) / 2 * s, y: H / 2 - (a.y + b.y) / 2 * s }
  const px = raster(shape, l, { cam, selected: null }, W, H, s / zoom, 1)
  // The lane's curve, as raster draws it: bowed to one side by 13% of its length, at most 40 px.
  const ax = a.x * s + cam.x, ay = a.y * s + cam.y, bx = b.x * s + cam.x, by = b.y * s + cam.y
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy), bow = Math.min(40, len * 0.13)
  const cx = (ax + bx) / 2 - dy / len * bow, cy = (ay + by) / 2 + dx / len * bow
  const at = (u: number) => [(1 - u) ** 2 * ax + 2 * (1 - u) * u * cx + u * u * bx, (1 - u) ** 2 * ay + 2 * (1 - u) * u * cy + u * u * by] as const
  const near = new Set<number>()
  let arc = 0
  for (let u = 0.34; u < 0.45; u += 0.001) {
    const [x, y] = at(u), [x2, y2] = at(u + 0.001)
    arc += Math.hypot(x2 - x, y2 - y)
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) near.add((Math.round(y) + j) * W + Math.round(x) + i)
  }
  // How far each pixel near the curve went from the sky toward the lane's colour (green, the channel that moves most).
  const sky = (SKY >> 8) & 255, on = (0x7fb08c >> 8) & 255
  let ink = 0, partial = 0, solid = 0
  for (const p of near) {
    const t = Math.max(0, Math.min(1, (px[p * 4 + 1]! - sky) / (on - sky)))
    ink += t
    if (t > 0.1 && t < 0.75) partial++
    else if (t >= 0.75) solid++
  }
  return { width: ink / arc, edge: partial / solid }
}
test('a lane is smooth and a pixel and a half wide', async () => {
  const { width, edge } = lane(1)
  // A stretch of curve within the window has its ends cut square by it; the window holds a little more.
  expect(width).toBeGreaterThan(1.5 * 0.9 * 0.85)
  expect(width).toBeLessThan(1.5 * 0.9 * 1.2)
  expect(edge).toBeGreaterThan(0.5)
})

// A lane widens as a star does, with the square root of the zoom over the fit, so at 4x it is twice as wide.
test('a lane widens with the zoom as its stars do', async () => {
  const ratio = lane(4).width / lane(1).width
  expect(ratio).toBeGreaterThan(1.8)
  expect(ratio).toBeLessThan(2.2)
})

// "... to a lesser upper limit than the stars": at 36x a star is 6x its fitted size, a lane only 3x.
test('a lane stops widening at 3x, short of its stars', async () => {
  const ratio = lane(36).width / lane(1).width
  expect(ratio).toBeGreaterThan(2.7)
  expect(ratio).toBeLessThan(3.3)
})

// A patch sits 130 units out past its map's outermost star; its haze is still visible there.
test('a fog patch\'s haze reaches the 130 units in to the nearest stars', async () => {
  const shape: Shape = { nodes: [{ num: 7, title: 'a', status: 'frontier', rank: 0 }], edges: [], fog: [{ title: 'f', clearsWith: 0 }] }
  const W = 800, H = 800, l = layout(shape), f = l.fog[0]!, q = l.pos[7]!
  const s = 1, cam = { s, x: W / 2 - f.x * s, y: H / 2 - f.y * s }
  const px = raster(shape, l, { cam, selected: null }, W, H, s, 1)
  // 130 units from the patch's centre, at right angles to the star (clear of its halo), on both sides.
  const dx = q.x - f.x, dy = q.y - f.y, d = Math.hypot(dx, dy), nx = -dy / d, ny = dx / d
  const blue = (sx: number, sy: number) => px[(Math.round(H / 2 + sy) * W + Math.round(W / 2 + sx)) * 4 + 2]!
  const sky = SKY & 255
  for (const side of [1, -1]) expect(blue(nx * 130 * side, ny * 130 * side) - sky).toBeGreaterThanOrEqual(8)
})

// An empty 900 x 900 sky has 900 dust dots; about 3% of them are white now, the rest stay faint.
test('a few of the background stars are white dots; most stay faint dust', async () => {
  const shape: Shape = { nodes: [], edges: [], fog: [] }
  const W = 900, H = 900, l = layout(shape)
  const px = raster(shape, l, { cam: { x: 0, y: 0, s: 1 }, selected: null }, W, H, 1, 1)
  let white = 0, lit = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i]! >= 200 && px[i + 1]! >= 200 && px[i + 2]! >= 200) white++
    if (px[i + 2]! > (SKY & 255) + 4) lit++
  }
  expect(white).toBeGreaterThanOrEqual(10)
  expect(white).toBeLessThan(lit / 5)
})
