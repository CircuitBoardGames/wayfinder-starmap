// A wayfinder map's graph document: what `hub-api issue graph <repo> <map#> --json` prints, and what hooks/wayfinder.ts computes.
// (A types contract is self-contained: no imports, so the layout's shape is spelled here as well as in hooks/raster.ts.)

export type MapNode = {
  num: number; title: string; type: string
  status: 'resolved' | 'out_of_scope' | 'claimed' | 'blocked' | 'frontier' | 'latent' | 'waiting'
  rank: number; claimedBy: string; claim: string; blockers: number[]; url: string
}
export type MapGraph = {
  map: number; name: string; url: string; destination: string
  counts: Record<string, number>
  nodes: MapNode[]
  edges: { from: number; to: number; satisfied: boolean }[]
  fog: { title: string; clearsWith: number }[]
  lint: { level: string; num: number | null; msg: string }[]
}
export type MapRow = { number: number; title: string }
// `loading`: `chosen` was just picked and its graph is on its way.
export type MapsSnapshot = { at: number; maps: MapRow[]; chosen: number | null; graph: MapGraph | null; errors: string[]; loading?: boolean }
// The ticket a pressed row opened in the item pane.
export type MapItem = { label: string; title: string; url: string; body: string; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'wayfinder-starmap': { snapshot: MapsSnapshot | null; item: MapItem | null; star: Star; zoomed: number; bar: boolean }
  }
}

// What the star map's input layer (hooks/starmap.tsx) works from: the graph's shape, the layout the
// hooks module computed (hooks/raster.ts), and the picture's pixels per cell, so a cell the pointer
// names maps to a pixel of the picture.
export type Layout = {
  sig: string
  pos: Record<number, { x: number; y: number }>
  fog: { title: string; anchor: number; x: number; y: number }[]
}
export type StarProps = {
  nodes: { num: number; title: string; status: MapNode['status']; rank: number; ghost?: boolean; repo?: string }[]
  edges: { from: number; to: number; satisfied: boolean }[]
  fog: { title: string; clearsWith: number }[]
  layout: Layout
  cw: number
  ch: number
  // A camera the hooks module moved (the wheel zooms there) and its sequence: the input
  // layer adopts it once per new `camSeq`, so a drag after a zoom starts from the zoomed view.
  cam?: { x: number; y: number; s: number } | null
  camSeq?: number
  // The shared picture's camera (one picture a machine, every pane showing it): taken at start, not fitted.
  startCam?: { x: number; y: number; s: number } | null
  // The picture is the shared one (sized by whichever pane drew it): this pane's size never refits it.
  shared?: boolean
  // The rows under the picture the controls hint takes (it wraps to the pane's width); absent, one.
  hint?: number
}
// What the pane's scrollbar (hooks/scrollbar.tsx) draws from: where the window stands over the pane's rows.
// `hidden`: blank while the pane moves, so nothing of it is carried along with the rows.
export type ScrollbarProps = { offset: number; bodyRows: number; contentRows: number; hidden?: boolean }
// `pixels`: the star map is drawn (a kitty-graphics terminal, or the person pressed the button);
// `note`: why it is not, when it is not.
export type Star = { pixels: boolean; note: string }
