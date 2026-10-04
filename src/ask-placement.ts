export type Rect = { x: number; y: number; w: number; h: number }
export type CanvasItem = { bounds: Rect; ink: boolean; answer: boolean; selected: boolean }

export function overlaps(a: Rect, b: Rect, gap = 0) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
}

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((b) => b.x))
  const y = Math.min(...rects.map((b) => b.y))
  return { x, y, w: Math.max(...rects.map((b) => b.x + b.w)) - x, h: Math.max(...rects.map((b) => b.y + b.h)) - y }
}

/** Old replies are obstacles, never anchors. Offscreen content must not pull a reply away. */
export function answerAnchor(items: CanvasItem[], view: Rect, gap: number): Rect {
  const visible = items.filter((item) => !item.answer && overlaps(item.bounds, view))
  const selected = visible.filter((item) => item.selected)
  const ink = visible.filter((item) => item.ink)
  const focus = selected.length ? selected : ink.length ? ink : visible
  if (!focus.length) return { x: view.x + gap, y: view.y + gap, w: 0, h: 0 }
  return union(focus.map(({ bounds: b }) => {
    const x = Math.max(b.x, view.x), y = Math.max(b.y, view.y)
    return { x, y, w: Math.min(b.x + b.w, view.x + view.w) - x, h: Math.min(b.y + b.h, view.y + view.h) - y }
  }))
}

/**
 * Try the four sides of the writing, sliding past occupied space along each ray.
 * Score proximity first with an extra cost for leaving the current viewport.
 * This stays bounded even with hundreds of handwriting strokes.
 */
export function answerSpot(anchor: Rect, obstacles: Rect[], view: Rect, w: number, h: number, gap: number): Rect {
  const starts = [
    { x: anchor.x + anchor.w + gap, y: anchor.y, direction: 'right' },
    { x: anchor.x, y: anchor.y + anchor.h + gap, direction: 'down' },
    { x: anchor.x - w - gap, y: anchor.y, direction: 'left' },
    { x: anchor.x, y: anchor.y - h - gap, direction: 'up' },
    { x: anchor.x + anchor.w + gap, y: anchor.y + anchor.h - h, direction: 'right' },
    { x: anchor.x + anchor.w - w, y: anchor.y + anchor.h + gap, direction: 'down' },
  ]
  const candidates = starts.map(({ x, y, direction }) => {
    const box = { x, y, w, h }
    for (let pass = 0; pass <= obstacles.length; pass++) {
      const hits = obstacles.filter((b) => overlaps(box, b, gap / 2))
      if (!hits.length) break
      if (direction === 'right') box.x = Math.max(...hits.map((b) => b.x + b.w)) + gap
      if (direction === 'down') box.y = Math.max(...hits.map((b) => b.y + b.h)) + gap
      if (direction === 'left') box.x = Math.min(...hits.map((b) => b.x)) - w - gap
      if (direction === 'up') box.y = Math.min(...hits.map((b) => b.y)) - h - gap
    }
    return box
  })
  const score = (b: Rect) => {
    const dx = Math.max(anchor.x - b.x - b.w, b.x - anchor.x - anchor.w, 0)
    const dy = Math.max(anchor.y - b.y - b.h, b.y - anchor.y - anchor.h, 0)
    const outside = Math.max(view.x - b.x, 0) + Math.max(view.y - b.y, 0) +
      Math.max(b.x + b.w - view.x - view.w, 0) + Math.max(b.y + b.h - view.y - view.h, 0)
    return Math.hypot(dx, dy) + outside * 2
  }
  return candidates.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best)
}
