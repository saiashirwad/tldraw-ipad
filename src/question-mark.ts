import type { Rect } from './ask-placement'

export const QUESTION_IDLE_MS = 1000
export type InkStroke = { id: string; bounds: Rect; points: { x: number; y: number }[] }
export type QuestionCandidate = { ids: string[]; bounds: Rect }

/** A cheap, conservative prefilter. The vision model must still confirm the glyph. */
function looksLikeHook(stroke: InkStroke, zoom: number) {
  const { bounds: b, points } = stroke
  if (points.length < 6 || b.h * zoom < 12 || b.w / b.h < .14 || b.w / b.h > 1.2) return false
  const forward = (path: InkStroke['points']) => {
    const first = path[0], last = path.at(-1)!
    const right = path.reduce((best, p) => p.x > best.x ? p : best)
    return first.y < b.y + b.h * .5 && last.y > b.y + b.h * .65 &&
      right.y < b.y + b.h * .7 && last.x < right.x - b.w * .08
  }
  return forward(points) || forward([...points].reverse())
}

/** Only whole, separate hook + dot strokes are candidates; never carve punctuation out of a word. */
export function findQuestionMarks(strokes: InkStroke[], changed: Set<string>, zoom: number): QuestionCandidate[] {
  const candidates: QuestionCandidate[] = []
  for (const hook of strokes) {
    if (!looksLikeHook(hook, zoom)) continue
    const b = hook.bounds
    const dots = strokes.filter((dot) => {
      if (dot.id === hook.id || (!changed.has(hook.id) && !changed.has(dot.id))) return false
      const d = dot.bounds
      const size = Math.max(6 / zoom, b.h * .3)
      const cx = d.x + d.w / 2
      return d.w <= size && d.h <= size && d.y >= b.y + b.h - 2 / zoom &&
        d.y - b.y - b.h <= b.h * .65 + 4 / zoom &&
        cx >= b.x - b.w * .25 && cx <= b.x + b.w * 1.25
    })
    const dot = dots.sort((a, c) => a.bounds.y - c.bounds.y)[0]
    if (!dot) continue
    const x = Math.min(b.x, dot.bounds.x), y = Math.min(b.y, dot.bounds.y)
    candidates.push({ ids: [hook.id, dot.id], bounds: {
      x, y, w: Math.max(b.x + b.w, dot.bounds.x + dot.bounds.w) - x,
      h: Math.max(b.y + b.h, dot.bounds.y + dot.bounds.h) - y,
    } })
  }
  // Recent ink is passed in time order. Prefer the newest question, not an older one elsewhere.
  return candidates.reverse()
}

export const QUESTION_MARK_SYSTEM_PROMPT = `You recognize one isolated handwritten glyph, not a whole canvas. Judge only the latest image, ignoring earlier images and replies.
Reply with exactly YES if the entire ink in the image is clearly a question mark: a curved hook with a separate dot below it. Otherwise reply with exactly NO.
Be conservative: NO for letters, words, numerals (including 2), exclamation marks, lines, doodles, or ambiguous marks. If any other writing is part of the glyph, reply NO. No explanation, no punctuation, no markdown.`

export function confirmedQuestionMark(reply: string) {
  return reply.trim() === 'YES'
}
