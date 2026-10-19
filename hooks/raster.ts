// The star map as pixels, drawn here: wayfinder-maps' canvas view (its layout.js, fog.js, draw.js in
// substance) rasterized into an RGBA buffer the engine's Image shows, with no browser anywhere. Pure
// functions over the graph's shape; the hooks module calls them, the Client overlay reuses the layout
// for hit-testing. Pixel space: world x,y scaled by cam.s and offset by cam.x, cam.y; no aspect fudge,
// pixels are square.
import { advance, FONT_H, FONT_LEFT, lit, textWidth } from './font'

export type Pt = { x: number; y: number }
export type Cam = { x: number; y: number; s: number }
export type Status = 'resolved' | 'out_of_scope' | 'claimed' | 'blocked' | 'frontier' | 'latent' | 'waiting'
export type Shape = {
  // `ghost`: a closed ticket kept only because it blocks an open one -- a small dim dot, unlabeled.
  // `repo`: the repository the ticket lives in, its label's prefix (`web#42`).
  nodes: { num: number; title: string; status: Status; rank: number; ghost?: boolean; repo?: string }[]
  edges: { from: number; to: number; satisfied: boolean }[]
  fog: { title: string; clearsWith: number }[]
}
export type Fog = { title: string; anchor: number; x: number; y: number }
export type Layout = { sig: string; pos: Record<number, Pt>; fog: Fog[] }

// The web view's palette (theme.js): a star's core and glow, its label.
export const COL: Record<Status, { core: number; glow: number; label: number }> = {
  frontier:     { core: 0x8ad8ff, glow: 0x2f9be0, label: 0xb3e5ff },
  claimed:      { core: 0xffd873, glow: 0xffb020, label: 0xffe6a0 },
  blocked:      { core: 0xe2c3c3, glow: 0x9a6f6f, label: 0xd0b3b3 },
  resolved:     { core: 0xb9d6c4, glow: 0x5b9077, label: 0xa2c1ac },
  out_of_scope: { core: 0x7d7789, glow: 0x4a4550, label: 0x8a8496 },
  latent:       { core: 0x9a94a8, glow: 0x4a4550, label: 0x8a8496 },
  waiting:      { core: 0xc9b8a0, glow: 0x6b5f4a, label: 0xbfae96 },
}
const SKY = 0x070a12, STARDUST = 0x3a4152, STARLIGHT = 0x8a93a8, STARWHITE = 0xeef2ff, EDGE_ON = 0x7fb08c, EDGE_OFF = 0x4f5868, FOG = 0x8c70d8, FOG_DIM = 0x5c52aa, WHITE = 0xffffff

// Deterministic PRNG (util.js): the same seed lays the same map out on every load.
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ringR = (rank: number) => 130 + rank * 165

export function signature(p: Shape): string {
  return `${p.nodes.map(n => `${n.num}:${n.rank}`).join(',')}|${p.edges.map(e => `${e.from}>${e.to}`).join(',')}|${p.fog.map(f => `${f.title}@${f.clearsWith}`).join(',')}`
}

// layout.js, verbatim in substance: ring-seeded, repulsion + springs + a radial pull per rank.
// Capped by the clock as well as by count: the pass is O(iterations x n^2) and a render has a budget;
// a 95-star map overran it. The ring seeding is the shape, the iterations
// declutter it, and a big map gets as many as fit. Six stars finish all 420 in a few ms.
export const LAYOUT_MS = 250
export function layout(p: Shape, budgetMs = LAYOUT_MS): Layout {
  const t0 = Date.now()
  const rnd = mulberry32(1337)
  const pos: Record<number, Pt> = {}
  const nodes = p.nodes
  for (const n of nodes) {
    const ang = rnd() * 6.2831853, jit = (rnd() - 0.5) * 70, R = ringR(n.rank) + jit
    pos[n.num] = { x: Math.cos(ang) * R, y: Math.sin(ang) * R }
  }
  const REP = 9000, SPRING = 0.02, REST = 150, RADIAL = 0.05
  for (let it = 0; it < 420 && Date.now() - t0 < budgetMs; it++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = pos[nodes[i]!.num]!
      for (let j = i + 1; j < nodes.length; j++) {
        const b = pos[nodes[j]!.num]!
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2)
        const f = REP / d2, ux = dx / d, uy = dy / d
        a.x += ux * f; a.y += uy * f; b.x -= ux * f; b.y -= uy * f
      }
    }
    for (const e of p.edges) {
      const a = pos[e.from], b = pos[e.to]
      if (a === undefined || b === undefined) continue
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01
      const f = (d - REST) * SPRING, ux = dx / d, uy = dy / d
      a.x += ux * f; a.y += uy * f; b.x -= ux * f; b.y -= uy * f
    }
    for (const n of nodes) {
      const q = pos[n.num]!, d = Math.hypot(q.x, q.y) || 0.01, f = (ringR(n.rank) - d) * RADIAL
      q.x += (q.x / d) * f; q.y += (q.y / d) * f
    }
  }
  return { sig: signature(p), pos, fog: fogPoints(p, pos) }
}

// fog.js: an anchored patch sits out past its ticket's angle, an unanchored one by the golden angle.
function fogPoints(p: Shape, pos: Record<number, Pt>): Fog[] {
  if (p.fog.length === 0 || p.nodes.length === 0) return []
  let cx = 0, cy = 0
  for (const n of p.nodes) { cx += pos[n.num]!.x; cy += pos[n.num]!.y }
  cx /= p.nodes.length; cy /= p.nodes.length
  let rim = 0
  for (const n of p.nodes) rim = Math.max(rim, Math.hypot(pos[n.num]!.x - cx, pos[n.num]!.y - cy))
  rim += 130
  const rnd = mulberry32(4242)
  return p.fog.map((f, i) => {
    const anc = f.clearsWith !== 0 ? pos[f.clearsWith] : undefined
    const ang = anc !== undefined ? Math.atan2(anc.y - cy, anc.x - cx) + (rnd() - 0.5) * 0.3 : i * 2.399963 + rnd() * 0.4
    return { title: f.title, anchor: anc === undefined ? 0 : f.clearsWith, x: cx + Math.cos(ang) * rim, y: cy + Math.sin(ang) * rim }
  })
}

// The camera that shows every star and fog patch in a W x H picture, labels' room on the right.
export function fit(l: Layout, p: Shape, W: number, H: number): Cam {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9
  const all: Pt[] = [...p.nodes.map(n => l.pos[n.num]!), ...l.fog]
  if (all.length === 0) return { x: W / 2, y: H / 2, s: 0.5 }
  for (const q of all) { minx = Math.min(minx, q.x); miny = Math.min(miny, q.y); maxx = Math.max(maxx, q.x); maxy = Math.max(maxy, q.y) }
  minx -= 90; maxx += 90; miny -= 60; maxy += 60
  const spanx = maxx - minx || 1, spany = maxy - miny || 1
  const s = Math.max(0.05, Math.min((W - 120) / spanx, (H - 20) / spany))
  return { x: W / 2 - ((minx + maxx) / 2) * s - 40, y: H / 2 - ((miny + maxy) / 2) * s, s }
}

// The zoom's range: out to a speck, in far enough that a star and its label fill the pane (the cap was
// once 6, which a one-star map ran into).
export const ZOOM_MAX = 60
export function zoomAt(cam: Cam, px: number, py: number, ns: number): Cam {
  ns = Math.min(ZOOM_MAX, Math.max(0.03, ns))
  const wx = (px - cam.x) / cam.s, wy = (py - cam.y) / cam.s
  return { s: ns, x: px - wx * ns, y: py - wy * ns }
}

// The star under a pixel, within `reach` pixels; null for empty sky.
export function hit(l: Layout, cam: Cam, px: number, py: number, reach = 14): number | null {
  let best: number | null = null, bd = reach
  for (const [num, q] of Object.entries(l.pos)) {
    const d = Math.hypot(q.x * cam.s + cam.x - px, q.y * cam.s + cam.y - py)
    if (d < bd) { bd = d; best = Number(num) }
  }
  return best
}

// --- the picture --------------------------------------------------------------------------------

// A bloom's falloff, exp(-3 d²)(1 - d²), looked up by d² rather than computed per pixel: the halos were 70% of
// a frame (profiled on a 95-star map), and the table draws them three times as fast, within 2/255.
const BLOOM = Float32Array.from({ length: 1024 }, (_, i) => { const d2 = (i + 0.5) / 1024; return Math.exp(-3 * d2) * (1 - d2) })
class Canvas {
  readonly px: Uint8ClampedArray
  cov: Uint8Array | null = null                     // a stroke's coverage, cleared as it is blended
  constructor(readonly W: number, readonly H: number) { this.px = new Uint8ClampedArray(W * H * 4) }
  // One 32-bit store a pixel (little-endian: R is the low byte).
  fill(c: number) {
    new Uint32Array(this.px.buffer).fill((0xff << 24 | (c & 255) << 16 | (c & 0xff00) | (c >> 16)) >>> 0)
  }
  // Blend a colour over (x, y) at alpha 0..1; off-picture pixels are dropped.
  dot(x: number, y: number, c: number, a = 1) {
    x = x | 0; y = y | 0
    if (x < 0 || y < 0 || x >= this.W || y >= this.H || a <= 0) return
    const i = (y * this.W + x) * 4, p = this.px
    if (a >= 1) { p[i] = c >> 16; p[i + 1] = (c >> 8) & 255; p[i + 2] = c & 255; return }
    p[i] = p[i]! + ((c >> 16) - p[i]!) * a
    p[i + 1] = p[i + 1]! + (((c >> 8) & 255) - p[i + 1]!) * a
    p[i + 2] = p[i + 2]! + ((c & 255) - p[i + 2]!) * a
  }
  // A soft disc: alpha falls from `a0` at the centre to 0 at radius r (the glow of a star, a nebula).
  glow(cx: number, cy: number, r: number, c: number, a0: number) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.W - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.H - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r
      if (d < 1) this.dot(x, y, c, a0 * (1 - d) * (1 - d))
    }
  }
  // A bloom: alpha a0 at the centre falling off as a Gaussian, tapered to exactly 0 at radius R -- no rim.
  bloom(cx: number, cy: number, R: number, c: number, a0: number) {
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(this.W - 1, Math.ceil(cx + R))
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(this.H - 1, Math.ceil(cy + R))
    const cr = c >> 16, cg = (c >> 8) & 255, cb = c & 255, p = this.px, W = this.W, inv = 1 / (R * R)
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy, dy2 = dy * dy * inv
      if (dy2 >= 1) continue
      let i = (y * W + x0) * 4
      for (let x = x0; x <= x1; x++, i += 4) {
        const dx = x + 0.5 - cx, d2 = dx * dx * inv + dy2
        if (d2 >= 1) continue
        const a = a0 * BLOOM[(d2 * 1023) | 0]!
        if (a < 0.002) continue
        p[i] = p[i]! + (cr - p[i]!) * a; p[i + 1] = p[i + 1]! + (cg - p[i + 1]!) * a; p[i + 2] = p[i + 2]! + (cb - p[i + 2]!) * a
      }
    }
  }
  // A star's core, feathered: solid to 0.6 of r, fading smoothly to nothing at 1.25 r.
  soft(cx: number, cy: number, r: number, c: number) {
    const R = r * 1.25
    for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
      const t = Math.min(1, Math.max(0, (R - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)) / (R - r * 0.6)))
      if (t > 0) this.dot(x, y, c, t * t * (3 - 2 * t))
    }
  }
  // A ring of radius R, w px wide at alpha a, its edges antialiased over a pixel.
  band(cx: number, cy: number, R: number, w: number, c: number, a: number) {
    const o = R + w + 1
    for (let y = Math.floor(cy - o); y <= cy + o; y++) for (let x = Math.floor(cx - o); x <= cx + o; x++) {
      const e = w / 2 + 0.5 - Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - R)
      if (e > 0) this.dot(x, y, c, a * Math.min(1, e))
    }
  }
  disc(cx: number, cy: number, r: number, c: number) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d <= r) this.dot(x, y, c, Math.min(1, r + 0.5 - d))
    }
  }
  ring(cx: number, cy: number, r: number, c: number) {
    const n = Math.ceil(r * 7)
    for (let i = 0; i < n; i++) { const t = (i / n) * 6.2831853; this.dot(cx + Math.cos(t) * r, cy + Math.sin(t) * r, c) }
  }
  // A filled triangle, its edges antialiased over about a pixel (the arrowheads).
  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: number) {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 1)), x1 = Math.min(this.W - 1, Math.ceil(Math.max(ax, bx, cx) + 1))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 1)), y1 = Math.min(this.H - 1, Math.ceil(Math.max(ay, by, cy) + 1))
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), s = area < 0 ? -1 : 1
    // Signed distance of (x, y) inside the edge from p to q, in pixels.
    const inside = (px: number, py: number, qx: number, qy: number, x: number, y: number) =>
      s * ((qx - px) * (y - py) - (qy - py) * (x - px)) / (Math.hypot(qx - px, qy - py) || 1)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const X = x + 0.5, Y = y + 0.5
      const d = Math.min(inside(ax, ay, bx, by, X, Y), inside(bx, by, cx, cy, X, Y), inside(cx, cy, ax, ay, X, Y))
      if (d > -0.5) this.dot(x, y, c, Math.min(1, d + 0.5))
    }
  }
  // A polyline (x, y pairs) `w` px wide at alpha a, antialiased: a pixel is covered by how far inside the
  // nearest segment's edge its centre lies, the most of any segment rather than the sum (so joints do not
  // double up), and blended once. `dash`: on, then off, that many px along the line. It replaced w x w
  // square dots a pixel apart, which stepped on every diagonal.
  stroke(pts: number[], w: number, c: number, a: number, dash = 0) {
    const W = this.W, cov = this.cov ??= new Uint8Array(W * this.H), h = w / 2, boxes: number[] = []
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
      const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - h - 1)), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + h + 1))
      const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - h - 1)), by1 = Math.min(this.H - 1, Math.ceil(Math.max(y0, y1) + h + 1))
      if (bx0 > bx1 || by0 > by1) return
      boxes.push(bx0, by0, bx1, by1)
      const vx = x1 - x0, vy = y1 - y0, vv = vx * vx + vy * vy || 1, reach = (h + 0.5) * (h + 0.5)
      for (let y = by0; y <= by1; y++) for (let x = bx0, i = y * W + bx0; x <= bx1; x++, i++) {
        const px = x + 0.5 - x0, py = y + 0.5 - y0, t = Math.min(1, Math.max(0, (px * vx + py * vy) / vv))
        const ex = px - vx * t, ey = py - vy * t, d2 = ex * ex + ey * ey
        if (d2 >= reach) continue
        const v = (Math.min(1, h + 0.5 - Math.sqrt(d2)) * 255) | 0
        if (v > cov[i]!) cov[i] = v
      }
    }
    // The dash's state carried from segment to segment: on or off, and how far into it. Each pass ends the
    // segment or the dash, so the walk always moves (a `%` of a growing float stalled it in the engine).
    let on = true, into = 0
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const x0 = pts[k]!, y0 = pts[k + 1]!, dx = pts[k + 2]! - x0, dy = pts[k + 3]! - y0, L = Math.hypot(dx, dy)
      if (dash === 0) { seg(x0, y0, x0 + dx, y0 + dy); continue }
      for (let s = 0; s < L;) {
        const step = Math.min(L - s, dash - into)
        if (on) seg(x0 + dx * s / L, y0 + dy * s / L, x0 + dx * (s + step) / L, y0 + dy * (s + step) / L)
        if (step === L - s) { into += step; s = L } else { on = !on; into = 0; s += step }
      }
    }
    for (let b = 0; b < boxes.length; b += 4) for (let y = boxes[b + 1]!; y <= boxes[b + 3]!; y++)
      for (let x = boxes[b]!, i = y * W + x; x <= boxes[b + 2]!; x++, i++) if (cov[i]! > 0) { this.dot(x, y, c, a * cov[i]! / 255); cov[i] = 0 }
  }
  // A line of text at `pf` pixels a font pixel, its top-left at (x, y), each glyph placed on whole pixels.
  // Its mask at a size is drawn once and reused: sampling every pixel of every character each frame made a
  // drag's frame 13x slower ("much laggier").
  text(x: number, y: number, s: string, c: number, pf: number) {
    const top = Math.round(y)
    let pen = 0
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i), m = glyph(code, pf), left = Math.round(x + pen * pf) - m.ox
      for (let j = 0; j < m.h; j++) for (let i2 = 0; i2 < m.w; i2++) {
        const a = m.a[j * m.w + i2]!
        if (a > 0.01) this.dot(left + i2, top + j, c, a)
      }
      pen += advance(code)
    }
  }
}

export type View = { cam: Cam; selected: number | null }

// A glyph's mask at `pf` pixels a font pixel: each pixel the share of it the glyph's font pixels cover, from
// 4 x 4 points. At a whole `pf` every pixel lies in one font pixel and the glyph is exactly its pixels;
// between, a stroke's edge is shared, so every stroke keeps its width. Kept per size, in eighths of a
// pixel; a zoom's sizes replace the last.
const glyphs = new Map<string, { w: number; h: number; ox: number; a: Float32Array }>()
let sampled = 0
// How many glyph masks have been drawn from the font so far (for the test that a redraw reuses them).
export const glyphsSampled = () => sampled
function glyph(code: number, pf: number): { w: number; h: number; ox: number; a: Float32Array } {
  const key = `${code}:${pf}`, hit = glyphs.get(key)
  if (hit !== undefined) return hit
  sampled++
  const n = 4, ox = Math.ceil(FONT_LEFT * pf)
  const w = Math.ceil((FONT_LEFT + advance(code) + 1) * pf) + 1, mh = Math.ceil(FONT_H * pf) + 1, a = new Float32Array(w * mh)
  for (let py = 0; py < mh; py++) for (let px = 0; px < w; px++) {
    let v = 0
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++)
      if (lit(code, Math.floor((px - ox + (sx + 0.5) / n) / pf), Math.floor((py + (sy + 0.5) / n) / pf))) v++
    a[py * w + px] = v / (n * n)
  }
  if (glyphs.size >= 2000) glyphs.clear()
  const m = { w, h: mh, ox, a }
  glyphs.set(key, m)
  return m
}

// Words into lines of at most `cols` characters, at most `max` of them, so a long title takes less
// width. A word longer than a line is split; what does
// not fit ends the last line with "..." (the font is ASCII: a '…' drew as '?').
export function wrap(s: string, cols: number, max: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (let w of s.split(/\s+/).filter(Boolean)) {
    while (w.length > cols) { if (cur !== '') { lines.push(cur); cur = '' } lines.push(w.slice(0, cols)); w = w.slice(cols) }
    if (cur === '') cur = w
    else if (cur.length + 1 + w.length <= cols) cur += ` ${w}`
    else { lines.push(cur); cur = w }
  }
  if (cur !== '') lines.push(cur)
  if (lines.length <= max) return lines
  const last = lines[max - 1]!
  return [...lines.slice(0, max - 1), `${last.length > cols - 3 ? last.slice(0, cols - 3) : last}...`]
}
// A line of label text, in pixels at scale 1 and zoom 1, and how many characters a line holds before it
// wraps. 11, not 14, and growing to 6x, not 8x.
const TEXT_H = 11, TEXT_COLS = 24, TEXT_ZOOM = 6
// How far a lane widens with the zoom: 3x, where a star goes to 8x.
const LANE_ZOOM = 3

// The whole picture, W x H RGBA: sky, nebulae, hyperlanes, stars, labels. `fitS` is the fitted zoom:
// closed stars are labelled only past 2.5x it, or when selected, so a finished map's embers do not
// bury its open stars (as in the cell map before it). `scale`: the picture's pixels a cell over the
// 8 the sizes below were made for -- a 16 px a cell picture draws everything twice as big, so a drag's
// 8 px frame and the 16 px one after it look alike (they did not: the small frame looked zoomed in).
// Stars and labels grow with the zoom (sqrt of it over the fit), the labels more slowly.
export function raster(p: Shape, l: Layout, view: View, W: number, H: number, fitS: number, scale = 1): Uint8ClampedArray {
  const cv = new Canvas(W, H)
  const { cam, selected } = view
  const z = Math.sqrt(Math.max(cam.s / fitS, 0.01))
  // Labels grow smoothly with zoom, as z^0.75 to TEXT_ZOOM: twice the size near 6x the fitted zoom.
  // A lane's width: a pixel and a half at 8 px a cell and the fitted zoom, growing with the picture's pixels a
  // cell and with the zoom as a star does (`rz`, its radius over 3 px, to 8x), so a lane keeps its weight beside
  // its stars zoomed in -- but only to LANE_ZOOM, short of the stars' limit; its dashes and arrowhead with it.
  const rz = Math.max(2, Math.min(24, 3 * z)) / 3, lz = Math.min(LANE_ZOOM, rz)
  const lw = Math.max(1.25, 1.5 * scale * lz), dash = Math.max(1, scale * lz), pf = Math.max(1, Math.round(TEXT_H * scale * Math.min(TEXT_ZOOM, Math.max(1, z) ** 0.75) / FONT_H * 8) / 8)
  // A label's line: the font's rows and one between lines; its width, glyph by glyph.
  const th = (FONT_H + 1) * pf, tw = (s: string) => textWidth(s) * pf
  const X = (q: Pt) => q.x * cam.s + cam.x, Y = (q: Pt) => q.y * cam.s + cam.y
  cv.fill(SKY)
  // The sky: a sparse parallax starfield behind everything (draw.js initStars, one layer). The draw that set a
  // dot's brightness also picks a few to shine: 3% white, a small round dot that stays a dot on a
  // denser picture -- a star's blue-white, so pure white stays the selection ring's alone; 12% a brighter
  // grey; the rest the dust they were, in the places they were.
  const sky = mulberry32(9001), dotR = 0.8 * Math.max(1, scale)
  for (let i = 0; i < Math.floor(W * H / 900); i++) {
    const sx = (sky() * W + cam.x * 0.15 + W * 4) % W, sy = (sky() * H + cam.y * 0.15 + H * 4) % H, v = sky()
    if (v < 0.03) cv.disc(sx, sy, dotR, STARWHITE)
    else if (v < 0.15) cv.dot(sx, sy, STARLIGHT, 1)
    else cv.dot(sx, sy, STARDUST, v < 0.3 ? 1 : 0.6)
  }
  // What text has been drawn where: fog titles first, so star labels below move around them.
  const taken: { x: number; y: number; w: number; h: number }[] = []
  // Fog nebulae: a soft violet patch past the rim, tethered to its anchor by a dotted line.
  for (const f of l.fog) {
    const fx = X(f), fy = Y(f)
    if (f.anchor !== 0) { const a = l.pos[f.anchor]; if (a !== undefined) cv.stroke([fx, fy, X(a), Y(a)], lw, FOG_DIM, 1, 4 * dash) }
    // First a wide faint haze, still a tenth as strong 130 units out, where the nearest stars sit
    //;
    // capped zoomed in, as a star's halo is, so a deep zoom stays fast. The title keeps its place below the core.
    cv.bloom(fx, fy, Math.min(Math.max(60 * scale, 220 * cam.s), 400 * scale), FOG_DIM, 0.4)
    cv.glow(fx, fy, Math.max(18 * scale, 60 * cam.s), FOG_DIM, 0.55)
    cv.glow(fx, fy, Math.max(8 * scale, 26 * cam.s), FOG, 0.5)
    const below = fy + Math.max(18 * scale, 60 * cam.s) + 2 * scale
    const lines = wrap(f.title, TEXT_COLS, 3), w = Math.max(0, ...lines.map(tw))
    lines.forEach((t, i) => cv.text(fx - tw(t) / 2, below + i * th, t, FOG, pf))
    taken.push({ x: fx - w / 2, y: below, w, h: lines.length * th })
  }
  // Stars, after wayfinder-maps' page, edges feathered: first each star's halo, a wide Gaussian bloom in its glow colour, so the lanes
  // drawn next stay bright through the haze; then, over the lanes, a bloom of the core's own colour and
  // the core feathered into it. A closed blocker is a star's size, fainter; a claimed star wears two
  // thin translucent rings; the selected star a white one.
  const r = scale * 3 * rz, g = Math.max(2 * scale, r)
  for (const n of p.nodes) {
    const q = l.pos[n.num]!, k = COL[n.status] ?? COL.blocked, open = n.status === 'frontier' || n.status === 'claimed'
    if (n.ghost === true) cv.bloom(X(q), Y(q), Math.min(g * 4.5, 120 * scale), k.glow, 0.3)
    else cv.bloom(X(q), Y(q), Math.min(r * (open ? 9 : 6), 200 * scale), k.glow, open ? 0.55 : 0.35)
  }
  // Edges: a curve bowed to one side, from blocker to dependent; satisfied solid, open dashed; a
  // filled arrowhead at the midpoint says which way it runs.
  for (const e of p.edges) {
    const a0 = l.pos[e.from], b0 = l.pos[e.to]
    if (a0 === undefined || b0 === undefined) continue
    const ax = X(a0), ay = Y(a0), bx = X(b0), by = Y(b0)
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1
    const bow = Math.min(40, len * 0.13), cx = (ax + bx) / 2 - (dy / len) * bow, cy = (ay + by) / 2 + (dx / len) * bow
    // The curve as segments of about 6 px (it bends at most 40 px over its length), stroked whole.
    const c = e.satisfied ? EDGE_ON : EDGE_OFF, steps = Math.max(8, Math.ceil(len / 6)), pts: number[] = []
    for (let i = 0; i <= steps; i++) {
      const u = i / steps, m = 1 - u
      pts.push(m * m * ax + 2 * m * u * cx + u * u * bx, m * m * ay + 2 * m * u * cy + u * u * by)
    }
    cv.stroke(pts, lw, c, 0.9, e.satisfied ? 0 : 6 * dash)
    // the arrowhead: a filled triangle, centred on the curve's midpoint, along its tangent there, which
    // for this curve runs from a to b
    const x = (ax + 2 * cx + bx) / 4, y = (ay + 2 * cy + by) / 4, ux = dx / len, uy = dy / len
    const a = 9 * scale * lz, b = 5 * scale * lz
    cv.tri(x + ux * a / 2, y + uy * a / 2, x - ux * a / 2 + uy * b, y - uy * a / 2 - ux * b, x - ux * a / 2 - uy * b, y - uy * a / 2 + ux * b, c)
  }
  // The cores, over the lanes (their halos are under them, above).
  for (const n of p.nodes) {
    const q = l.pos[n.num]!, k = COL[n.status] ?? COL.blocked, x = X(q), y = Y(q)
    if (n.ghost === true) {
      cv.soft(x, y, g, k.glow)
      if (selected === n.num) cv.band(x, y, g * 1.6, 2 * scale, WHITE, 1)
      continue
    }
    const open = n.status === 'frontier' || n.status === 'claimed', cr = r * (n.status === 'frontier' ? 1.3 : 1)
    cv.bloom(x, y, cr * 2.6, k.core, open ? 0.6 : 0.4)
    cv.soft(x, y, cr, k.core)
    if (n.status === 'claimed') { cv.band(x, y, cr * 1.5, 0.8 * scale, k.core, 0.6); cv.band(x, y, cr * 2.2, 0.8 * scale, k.core, 0.3) }
    if (selected === n.num) cv.band(x, y, cr * 1.5 + 4 * scale, 2 * scale, WHITE, 1)
  }
  // Labels, last: open stars always, closed ones only zoomed in on or selected. Each label takes
  // the first free row of five near its star; one that fits nowhere is dropped, not overprinted.
  const closedToo = cam.s >= fitS * 2.5, numOnly = cam.s < fitS * 0.6
  for (const n of p.nodes) {
    if ((n.ghost === true || (!closedToo && (n.status === 'resolved' || n.status === 'out_of_scope'))) && selected !== n.num) continue
    const q = l.pos[n.num]!, k = COL[n.status] ?? COL.blocked
    if (X(q) < -r || X(q) > W + r || Y(q) < -r || Y(q) > H + r) continue   // no label without its star in view
    // The ticket's repo and number, no title; the number alone zoomed far out. It sits level
    // with the star, right of it, else left, moving by whole lines to a free place.
    const label = numOnly && selected !== n.num ? `#${n.num}` : `${n.repo ?? ''}#${n.num}`
    const w = tw(label), h = th, pad = 4 * scale
    place: for (const x of [X(q) + r + 6 * scale, X(q) - r - 6 * scale - w]) for (const dy of [0, -1, 1, -2, 2, -3, 3]) {
      const y = Y(q) - th / 2 + dy * th
      if (x < 0 || x + w > W || y < 0 || y + h > H) continue
      if (taken.some(b => x < b.x + b.w + pad && x + w + pad > b.x && y < b.y + b.h && y + h > b.y)) continue
      cv.text(x, y, label, k.label, pf); taken.push({ x, y, w, h }); break place
    }
  }
  return cv.px
}
