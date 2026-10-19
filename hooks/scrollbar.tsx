// The maps pane's scrollbar: one column at the pane's right edge, laid over the
// rows the window shows so it stays put while they scroll. It draws the track and the thumb and posts the
// offset a press or a drag on it asks for; the hooks module moves the pane there.
import type { ClientModule } from 'claude-code'

import type { ScrollbarProps } from '../types'

function thumbOf(p: ScrollbarProps): { top: number; size: number } {
  const size = Math.max(1, Math.min(p.bodyRows, Math.round(p.bodyRows * p.bodyRows / p.contentRows)))
  const top = Math.round((p.bodyRows - size) * p.offset / Math.max(1, p.contentRows - p.bodyRows))
  return { top: Math.max(0, Math.min(p.bodyRows - size, top)), size }
}

const THUMB = '#8a8a8a', TRACK = '#2b2b2b'

// Each surface's latest props, for the pointer handler registered on its first render.
const live = new WeakMap<object, ScrollbarProps>()
// While a press holds the thumb: the rows between the pointer and the thumb's top.
let grab: number | null = null

const Scrollbar: ClientModule<ScrollbarProps, undefined> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (!live.has(surface)) {
    surface.onPointer(e => {
      const p = live.get(surface)!, t = thumbOf(p), room = Math.max(1, p.bodyRows - t.size)
      const to = (top: number) => surface.post({ scrollTo: Math.round(Math.max(0, Math.min(room, top)) * (p.contentRows - p.bodyRows) / room) })
      // A press on the thumb holds it where it was taken; on the track, the thumb's middle jumps there.
      // Shown while the pointer is at it (the hooks module keeps it hidden otherwise); a drag keeps it.
      if (e.type === 'enter' || (e.type === 'move' && grab === null && p.hidden === true)) { surface.post({ reveal: true }); return }
      if (e.type === 'leave' && grab === null) { surface.post({ reveal: false }); return }
      if (e.type === 'down' && e.button === 'left') { grab = e.y >= t.top && e.y < t.top + t.size ? e.y - t.top : Math.floor(t.size / 2); to(e.y - grab) }
      else if (e.type === 'move' && grab !== null && e.button === 'left') to(e.y - grab)
      else if (e.type === 'up') grab = null
    })
  }
  live.set(surface, props)
  const t = thumbOf(props)
  // Cells filled with a background, not glyphs: a cell's background is exactly its cell, where `█` and `│`
  // are the font's height, which left gaps between rows.
  return (
    <Box flexDirection="column" width={1} height={props.bodyRows}>
      {Array.from({ length: props.bodyRows }, (_, i) => (
        props.hidden === true
          ? <Text key={`r${i}`}> </Text>
          : <Text key={`r${i}`} backgroundColor={i >= t.top && i < t.top + t.size ? THUMB : TRACK}> </Text>
      ))}
    </Box>
  )
}

export default Scrollbar
