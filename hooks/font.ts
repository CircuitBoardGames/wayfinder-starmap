// The star map's label font: "Replace The Sun" by Imirui (dafont.com/replacethesun.font, listed there as
// 100% Free), a pixel font remaking the game OneShot's: at 16 px each of its pixels is wholly on or off, so it
// is kept as those pixels: drawn exactly at whole multiples of them, blended only between.
// Each glyph: FONT_H rows from the line's top (10 above the baseline, 3 below), bit c of a row the font pixel
// c - FONT_LEFT right of the glyph's origin; ADV its advance. ASCII 32..126; anything else draws as '?'.
// Regenerate: font-gen.html beside ReplaceTheSun.ttf, then
// chromium --headless --allow-file-access-from-files --virtual-time-budget=5000 --dump-dom 'file://'$PWD'/font-gen.html?font=ReplaceTheSun.ttf&px=16'
// and its h, left, adv and rows are FONT_H, FONT_LEFT, ADV and ROWS below.
// The `fontFile` option swaps in another font, a JSON file of the same four that font-gen.html saves.
const FONT_H = 13, FONT_LEFT = 1
const ADV = [5,3,7,8,8,7,8,3,5,5,8,7,4,8,3,7,8,7,8,8,8,8,8,8,8,8,3,3,7,8,7,8,8,8,8,8,8,8,8,8,8,5,8,8,8,8,8,8,8,8,8,8,9,8,8,8,8,9,8,5,7,5,7,8,4,8,8,8,8,8,8,8,8,5,7,8,5,8,8,8,8,8,8,8,8,8,8,8,8,8,8,6,3,6,9]
const ROWS = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0],
  [6,6,6,6,6,6,6,0,6,6,0,0,0],
  [102,102,102,0,0,0,0,0,0,0,0,0,0],
  [108,108,108,254,108,108,254,108,108,108,0,0,0],
  [16,124,214,22,22,124,208,208,214,124,16,0,0],
  [102,102,48,48,24,24,12,12,102,102,0,0,0],
  [56,108,108,56,220,118,102,102,118,220,0,0,0],
  [6,6,6,0,0,0,0,0,0,0,0,0,0],
  [24,12,6,6,6,6,6,6,12,24,0,0,0],
  [6,12,24,24,24,24,24,24,12,6,0,0,0],
  [0,0,0,108,56,254,56,108,0,0,0,0,0],
  [0,0,0,24,24,126,24,24,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,12,12,6,0,0],
  [0,0,0,0,0,254,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,6,6,0,0,0],
  [96,96,48,48,24,24,12,12,6,6,0,0,0],
  [124,198,198,230,246,222,206,198,198,124,0,0,0],
  [24,28,30,24,24,24,24,24,24,126,0,0,0],
  [124,198,198,192,96,48,24,12,6,254,0,0,0],
  [124,198,198,192,120,192,192,198,198,124,0,0,0],
  [192,224,240,216,204,198,254,192,192,192,0,0,0],
  [254,6,6,6,126,192,192,198,198,124,0,0,0],
  [120,12,6,6,126,198,198,198,198,124,0,0,0],
  [254,192,192,96,96,48,48,24,24,24,0,0,0],
  [124,198,198,198,124,198,198,198,198,124,0,0,0],
  [124,198,198,198,198,252,192,192,96,60,0,0,0],
  [0,0,0,6,6,0,0,0,6,6,0,0,0],
  [0,0,0,6,6,0,0,0,6,6,3,0,0],
  [0,96,48,24,12,6,12,24,48,96,0,0,0],
  [0,0,0,254,0,0,254,0,0,0,0,0,0],
  [0,6,12,24,48,96,48,24,12,6,0,0,0],
  [124,198,198,192,96,48,48,0,48,48,0,0,0],
  [124,198,230,214,214,214,214,230,6,252,0,0,0],
  [124,198,198,198,198,254,198,198,198,198,0,0,0],
  [126,198,198,198,126,198,198,198,198,126,0,0,0],
  [124,198,198,6,6,6,6,198,198,124,0,0,0],
  [62,102,198,198,198,198,198,198,102,62,0,0,0],
  [254,6,6,6,62,6,6,6,6,254,0,0,0],
  [254,6,6,6,62,6,6,6,6,6,0,0,0],
  [124,198,198,6,6,246,198,198,198,124,0,0,0],
  [198,198,198,198,254,198,198,198,198,198,0,0,0],
  [30,12,12,12,12,12,12,12,12,30,0,0,0],
  [240,96,96,96,96,96,96,102,102,60,0,0,0],
  [198,198,102,54,30,30,54,102,198,198,0,0,0],
  [6,6,6,6,6,6,6,6,6,254,0,0,0],
  [130,198,238,254,214,198,198,198,198,198,0,0,0],
  [198,198,198,206,222,246,230,198,198,198,0,0,0],
  [124,198,198,198,198,198,198,198,198,124,0,0,0],
  [126,198,198,198,198,126,6,6,6,6,0,0,0],
  [124,198,198,198,198,198,198,198,246,124,192,0,0],
  [126,198,198,198,198,126,30,54,102,198,0,0,0],
  [124,198,6,6,124,192,192,198,198,124,0,0,0],
  [510,48,48,48,48,48,48,48,48,48,0,0,0],
  [198,198,198,198,198,198,198,198,198,124,0,0,0],
  [198,198,198,198,198,108,108,108,56,56,0,0,0],
  [198,198,198,198,198,214,254,238,198,130,0,0,0],
  [198,198,108,108,56,56,108,108,198,198,0,0,0],
  [390,390,204,204,120,48,48,48,48,48,0,0,0],
  [254,192,192,96,48,24,12,6,6,254,0,0,0],
  [30,6,6,6,6,6,6,6,6,30,0,0,0],
  [6,6,12,12,24,24,48,48,96,96,0,0,0],
  [30,24,24,24,24,24,24,24,24,30,0,0,0],
  [24,60,102,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,254,0],
  [6,12,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,124,192,252,198,198,198,252,0,0,0],
  [6,6,6,126,198,198,198,198,198,126,0,0,0],
  [0,0,0,124,198,6,6,6,198,124,0,0,0],
  [192,192,192,252,198,198,198,198,198,252,0,0,0],
  [0,0,0,124,198,198,254,6,6,124,0,0,0],
  [240,24,24,126,24,24,24,24,24,24,0,0,0],
  [0,0,0,252,198,198,198,198,198,252,192,192,124],
  [6,6,6,126,198,198,198,198,198,198,0,0,0],
  [12,12,0,14,12,12,12,12,12,30,0,0,0],
  [96,96,0,112,96,96,96,96,102,102,60,0,0],
  [6,6,6,198,102,54,30,54,102,198,0,0,0],
  [14,12,12,12,12,12,12,12,12,30,0,0,0],
  [0,0,0,126,214,214,214,214,214,214,0,0,0],
  [0,0,0,126,198,198,198,198,198,198,0,0,0],
  [0,0,0,124,198,198,198,198,198,124,0,0,0],
  [0,0,0,126,198,198,198,198,198,126,6,6,6],
  [0,0,0,252,198,198,198,198,198,252,192,192,192],
  [0,0,0,246,30,14,6,6,6,6,0,0,0],
  [0,0,0,252,6,6,124,192,192,126,0,0,0],
  [24,24,24,126,24,24,24,24,24,240,0,0,0],
  [0,0,0,198,198,198,198,198,198,252,0,0,0],
  [0,0,0,198,198,198,108,108,56,56,0,0,0],
  [0,0,0,198,198,214,214,214,214,252,0,0,0],
  [0,0,0,198,198,108,56,108,198,198,0,0,0],
  [0,0,0,198,198,198,198,198,198,252,192,192,124],
  [0,0,0,254,192,96,56,12,6,254,0,0,0],
  [56,12,12,12,6,12,12,12,12,56,0,0,0],
  [6,6,6,6,6,6,6,6,6,6,0,0,0],
  [14,24,24,24,48,24,24,24,24,14,0,0,0],
  [0,0,0,412,438,230,0,0,0,0,0,0,0]
]
// A font: `h` rows a glyph, bit c of a row the pixel c - `left` right of the origin, `adv` each advance, for
// ASCII 32..126; `id` names it, so a picture drawn in one font is never taken for one drawn in another.
export type Font = { h: number; left: number; adv: number[]; rows: number[][]; id: string }
const BUILTIN: Font = { h: FONT_H, left: FONT_LEFT, adv: ADV, rows: ROWS, id: 'builtin' }
let font = BUILTIN
export const fontH = () => font.h
export const fontLeft = () => font.left
export const fontId = () => font.id
// The font labels draw in from now on; null is the built-in one.
export function useFont(f: Font | null) { font = f ?? BUILTIN }

// A font file's text as a Font, or why it is not one. The file is the person's, so every number is checked:
// a glyph wider than 31 pixels would not fit a row's bits, and a short table would draw undefined.
export function fontFrom(text: string): Font | string {
  let v: { h?: unknown; left?: unknown; adv?: unknown; rows?: unknown }
  try { v = JSON.parse(text) as typeof v } catch { return 'not JSON' }
  const int = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi
  if (v === null || typeof v !== 'object') return 'not a JSON object'
  if (!int(v.h, 1, 64)) return '"h" is not a whole number of rows from 1 to 64'
  if (!int(v.left, 0, 30)) return '"left" is not a whole number from 0 to 30'
  const h = v.h
  if (!Array.isArray(v.adv) || v.adv.length !== 95 || !v.adv.every(a => int(a, 0, 31))) return '"adv" is not 95 advances from 0 to 31'
  if (!Array.isArray(v.rows) || v.rows.length !== 95
      || !v.rows.every(r => Array.isArray(r) && r.length === h && r.every(b => int(b, 0, 0x7fffffff)))) {
    return `"rows" is not 95 glyphs of ${h} rows, each a 31-bit number`
  }
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) >>> 0
  return { h, left: v.left, adv: v.adv as number[], rows: v.rows as number[][], id: `file-${hash.toString(36)}` }
}

const at = (code: number) => (code >= 32 && code <= 126 ? code - 32 : 31)
// A glyph's advance, in font pixels.
export const advance = (code: number) => font.adv[at(code)]!
// A line of text's width, in font pixels.
export function textWidth(s: string): number {
  let w = 0
  for (let i = 0; i < s.length; i++) w += advance(s.charCodeAt(i))
  return w
}
// Whether font pixel (u, v) of `code` is lit: u right of its origin, v down from the line's top.
export function lit(code: number, u: number, v: number): boolean {
  const c = u + font.left
  return v >= 0 && v < font.h && c >= 0 && c < 31 && ((font.rows[at(code)]![v]! >> c) & 1) === 1
}
