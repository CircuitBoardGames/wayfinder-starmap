// The star map's input layer: a surface module laid over the picture (an Image the hooks module
// draws from hooks/raster.ts). It draws nothing of its own; it holds the camera and the selection,
// turns keys and the pointer into a view, and posts that view up so the picture is redrawn.
// Keys: arrows pan, + - zoom, f fits, Tab walks the frontier, Enter opens the selected star,
// Escape hands the focus back. Pointer: drag pans, a click opens the star under it; the wheel zooms
// at the pointer (the hooks module does that: a Client gets no wheel).
import type { ClientModule, ClientPointerEvent } from 'claude-code'

import type { StarProps } from '../types'
import { fit, zoomAt } from './raster'
import type { Cam } from './raster'

type State = {
  sig: string                       // which layout the camera was fitted for
  cam: Cam | null                   // null: fit on the next draw
  fitS: number
  selected: number | null
  size: string                      // the picture size the camera was fitted at
  camSeq: number                    // the last camera the hooks module handed down (the wheel)
}
// The pointer's drag, module-level rather than in state: a `down` and its `up` arrive before a
// `setState` between them is applied, so state would read as "no drag" on a quick click.
// `x0, y0`: where it went down; `x, y`: where the picture has got to; `tx, ty`: where it is going, the
// mean of `trail`, the last pointer positions; `dragging`: it has left that cell, so it pans and is no click.
let drag: { x0: number; y0: number; x: number; y: number; tx: number; ty: number; dragging: boolean; trail: { x: number; y: number }[] } | null = null

// Each surface's latest props and size, for the key and pointer handlers: they are registered once, on the
// first render, and a map switch hands in new props (Tab and drags used the first map's stars).
const live = new WeakMap<object, { props: StarProps; W: number; H: number }>()

const Starmap: ClientModule<StarProps, State> = (props, surface) => {
  const { Box } = surface.elements
  const columns = surface.columns, rows = surface.rows
  // The picture is `cw` x `ch` pixels a cell, as the hooks module sized it; the hint takes the last rows.
  const W = columns * props.cw, H = Math.max(1, rows - (props.hint ?? 1)) * props.ch
  live.set(surface, { props, W, H })
  const size = `${W}x${H}`
  let st = surface.state
  const post = (s: State) => { if (s.cam !== null) surface.post({ view: { cam: s.cam, selected: s.selected } }) }
  if (st === undefined) {
    // A camera the hooks module already holds (the shared picture of this map) is taken as it is;
    // fitting here would post a view and redraw the picture every other pane is showing.
    st = { sig: props.layout.sig, cam: props.startCam != null ? { ...props.startCam } : null, fitS: 1, selected: null, size, camSeq: props.camSeq ?? 0 }
    // A camera taken at start skips the fit below, which is what otherwise sets the state the handlers
    // read: unset, a pointer or a key would do nothing. Only then: two sets in one render interfere.
    if (st.cam !== null) surface.setState(st)
    surface.onKey(k => {
      const { props, W, H } = live.get(surface)!
      const cur = surface.state
      if (cur === undefined || cur.cam === null) return
      let cam = cur.cam, selected = cur.selected
      const step = 32
      if (k.key === 'left') cam = { ...cam, x: cam.x + step }
      else if (k.key === 'right') cam = { ...cam, x: cam.x - step }
      else if (k.key === 'up') cam = { ...cam, y: cam.y + step }
      else if (k.key === 'down') cam = { ...cam, y: cam.y - step }
      else if (k.key === '+' || k.key === '=') cam = zoomAt(cam, W / 2, H / 2, cam.s * 1.25)
      else if (k.key === '-' || k.key === '_') cam = zoomAt(cam, W / 2, H / 2, cam.s / 1.25)
      else if (k.key === 'f' || k.key === '0') { surface.setState({ ...cur, cam: null }); return }
      else if (k.key === 'tab') {
        // Walk the frontier first, then everything else, in map order; the chosen star is centred.
        const order = [...props.nodes.filter(n => n.status === 'frontier'), ...props.nodes.filter(n => n.status !== 'frontier')].map(n => n.num)
        if (order.length === 0) return
        const i = selected === null ? -1 : order.indexOf(selected)
        selected = order[(i + 1) % order.length]!
        const q = props.layout.pos[selected]!
        cam = { ...cam, x: W / 2 - q.x * cam.s, y: H / 2 - q.y * cam.s }
      }
      else if (k.key === 'return') { if (selected !== null) surface.post({ open: selected }); return }
      else return
      const next = { ...cur, cam, selected }
      surface.setState(next); post(next)
    })
    surface.onPointer(e => { const l = live.get(surface)!; pointer(e, surface, l.props, l.W, l.H) })
    // A drag glides: each frame the picture goes half the way to the pointer, both axes at once, so a
    // step the pointer took on one axis is spread over frames the other axis moves in too.
    surface.every(33, () => {
      const cur = surface.state
      if (drag === null || !drag.dragging || cur === undefined || cur.cam === null) return
      // Half the way each frame; the last pixel in one step, so the glide ends rather than creeping.
      const rx = drag.tx - drag.x, ry = drag.ty - drag.y, near = Math.abs(rx) < 1 && Math.abs(ry) < 1
      const dx = near ? rx : rx / 2, dy = near ? ry : ry / 2
      if (rx === 0 && ry === 0) {
        // Caught up with the mean: go on to the pointer itself.
        const p = drag.trail.at(-1)!
        if (drag.trail.length > 1) drag = { ...drag, tx: p.x, ty: p.y, trail: [p] }
        return
      }
      drag = { ...drag, x: drag.x + dx, y: drag.y + dy }
      const next = { ...cur, cam: { ...cur.cam, x: cur.cam.x + dx, y: cur.cam.y + dy } }
      surface.setState(next); surface.post({ view: { cam: next.cam, selected: next.selected } })
    })
  }
  if (props.cam != null && props.camSeq !== undefined && props.camSeq !== st.camSeq) {
    st = { ...st, cam: { ...props.cam }, camSeq: props.camSeq }
    surface.setState(st)
  }
  if (st.cam === null || st.sig !== props.layout.sig || (props.shared !== true && st.size !== size)) {
    if (W > 0 && H > 0) {
      const cam = fit(props.layout, props, W, H)
      st = { ...st, sig: props.layout.sig, cam, fitS: cam.s, size, selected: st.sig === props.layout.sig ? st.selected : null }
      surface.setState(st); post(st)
    }
  }
  return <Box width={columns} height={rows} />
}

function pointer(e: ClientPointerEvent, surface: Parameters<ClientModule<StarProps, State>>[1], props: StarProps, W: number, H: number) {
  const cur = surface.state
  if (cur === undefined || cur.cam === null) return
  // Within the cell where the terminal reports pixels (`fine`); else the cell's centre.
  const px = (e.fine?.x ?? e.x + 0.5) * props.cw, py = (e.fine?.y ?? e.y + 0.5) * props.ch
  if (e.type === 'down' && e.button === 'left') { drag = { x0: px, y0: py, x: px, y: py, tx: px, ty: py, dragging: false, trail: [{ x: px, y: py }] }; return }
  if (e.type === 'move' && drag !== null && e.button === 'left') {
    // Within a cell of the press it is still a click (a hand on a mouse often crosses a cell edge while
    // clicking, and read as a drag that opened nothing). Past it, the drag pans from the press.
    if (!drag.dragging && Math.abs(px - drag.x0) <= props.cw && Math.abs(py - drag.y0) <= props.ch) return
    // The pointer comes in whole cells, twice as tall as wide, so a diagonal drag arrives as a staircase:
    // the picture glides (the frame clock above) toward the mean of the last three positions instead, and
    // the drag's end catches up to the pointer.
    const trail = [...drag.trail, { x: px, y: py }].slice(-3)
    drag = { ...drag, tx: trail.reduce((s, t) => s + t.x, 0) / trail.length, ty: trail.reduce((s, t) => s + t.y, 0) / trail.length, dragging: true, trail }
    return
  }
  if (e.type === 'up' && drag !== null) {
    const { dragging, x0, y0, x, y } = drag
    drag = null
    // A drag's end: caught up to the pointer.
    if (dragging) {
      const cam = { ...cur.cam, x: cur.cam.x + px - x, y: cur.cam.y + py - y }
      surface.setState({ ...cur, cam }); surface.post({ view: { cam, selected: cur.selected } }); return
    }
    // A click: the hooks module finds the star under the press, on the picture it drew -- this layer's
    // camera can lag it (measured hundreds of pixels adrift), so it is not asked.
    surface.post({ click: { x: x0, y: y0 } })
  }
  void W; void H
}

export default Starmap
