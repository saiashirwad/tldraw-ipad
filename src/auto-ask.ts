import { b64Vecs, createShapeId, toRichText, type Editor, type TLDrawShape, type TLEventInfo, type TLPageId, type TLShape, type TLShapeId } from 'tldraw'
import { findQuestionMarks, QUESTION_IDLE_MS, type QuestionCandidate } from './question-mark'

export type QuestionMarker = QuestionCandidate & { pageId: TLPageId; ink: TLDrawShape[] }

export function markerIsCurrent(editor: Editor, marker: QuestionMarker) {
  return editor.getCurrentPageId() === marker.pageId && !editor.getIsReadonly() && marker.ink.every((shape) => {
    const current = editor.getShape(shape.id)
    return current && !current.isLocked && JSON.stringify(current) === JSON.stringify(shape) &&
      editor.getBindingsInvolvingShape(shape.id).length === 0
  })
}

/** One SDK undo restores the exact question-mark strokes and removes the complete answer. */
export function replaceQuestionMarker(editor: Editor, marker: QuestionMarker, text: string) {
  if (!text.trim() || !markerIsCurrent(editor, marker)) return null
  const zoom = editor.getZoomLevel()
  const scale = Math.max(18, Math.min(40, marker.bounds.h * zoom * .75)) / (18 * zoom)
  const id = createShapeId()
  editor.markHistoryStoppingPoint('answer-question-mark')
  editor.run(() => {
    editor.deleteShapes(marker.ink.map((shape) => shape.id))
    editor.createShapes([{
      id, type: 'text', x: marker.bounds.x, y: marker.bounds.y,
      meta: { agentAnswer: true, questionMarkInk: JSON.parse(JSON.stringify(marker.ink)) },
      props: { richText: toRichText(text.trim()), size: 's', font: 'sans', color: 'black', scale,
        autoSize: false, w: 240 / (scale * zoom) },
    }])
  })
  editor.markHistoryStoppingPoint('answer-question-mark-complete')
  return id
}

/** Local pen/mouse input only: sync, page loads, CLI drawing, undo, and agent replies cannot trigger it. */
export function installQuestionTrigger(editor: Editor, options: {
  enabled(): boolean
  busy(): boolean
  onCandidate(marker: QuestionMarker, controller: AbortController): Promise<void>
}) {
  const recent = new Map<string, { shape: TLDrawShape; at: number }>()
  const changed = new Set<string>()
  const tried = new Set<string>()
  const pointers = new Set<number>()
  const pens = new Set<number>()
  const owned = new Set<TLShapeId>()
  let drawingEvent = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | null = null
  let disposed = false
  let liftedAt = 0
  const container = editor.getContainer()

  const clearTimer = () => { clearTimeout(timer); timer = undefined }
  const interrupt = (reason: string) => { clearTimer(); active?.abort(reason) }
  const schedule = () => {
    clearTimer()
    if (disposed || pointers.size || pens.size || !changed.size || !options.enabled()) return
    timer = setTimeout(() => { void inspect() }, Math.max(0, liftedAt + QUESTION_IDLE_MS - Date.now()))
  }

  async function inspect() {
    timer = undefined
    if (disposed || pointers.size || pens.size || active || !options.enabled() || document.visibilityState !== 'visible') return
    if (options.busy()) { timer = setTimeout(() => { void inspect() }, 250); return }
    const now = Date.now()
    for (const [id, entry] of recent) {
      if (now - entry.at > 15000 || !editor.getShape(entry.shape.id)) { recent.delete(id); changed.delete(id) }
    }
    const entries = [...recent.values()].filter(({ shape }) => shape.props.isComplete && !shape.isLocked &&
      shape.parentId === editor.getCurrentPageId() && editor.getViewportPageBounds().collides(editor.getShapePageBounds(shape)!))
      .sort((a, b) => a.at - b.at)
    const strokes = entries.map(({ shape }) => {
      const transform = editor.getShapePageTransform(shape)
      return { id: shape.id as string, bounds: editor.getShapePageBounds(shape)!, points: shape.props.segments.flatMap((segment) =>
        b64Vecs.decodePoints(segment.path, segment.dim).map((p) => transform.applyToPoint({ x: p.x * shape.props.scaleX, y: p.y * shape.props.scaleY }))) }
    })
    const candidates = findQuestionMarks(strokes, changed, editor.getZoomLevel())
    changed.clear()
    for (const candidate of candidates.slice(0, 4)) {
      if (disposed || pointers.size || options.busy() || !options.enabled()) break
      const ink = candidate.ids.flatMap((id) => recent.get(id)?.shape ?? [])
      if (ink.length !== candidate.ids.length) continue
      const marker: QuestionMarker = { ...candidate, pageId: editor.getCurrentPageId(), ink }
      const fingerprint = JSON.stringify(ink)
      if (tried.has(fingerprint) || !markerIsCurrent(editor, marker)) continue
      const controller = new AbortController()
      active = controller
      try {
        await options.onCandidate(marker, controller)
      } finally {
        if (controller.signal.aborted && controller.signal.reason === 'input') {
          // A new stroke interrupted recognition: retry this still-intact mark after the next pause.
          for (const shape of ink) if (editor.getShape(shape.id)) changed.add(shape.id)
        } else {
          // Stop also suppresses retry, so an unchanged mark cannot immediately start again.
          tried.add(fingerprint)
          if (tried.size > 256) tried.delete(tried.values().next().value!)
        }
        if (active === controller) active = null
      }
      if (controller.signal.aborted) break
    }
    if (changed.size) schedule()
  }

  const remember = (shape: TLShape) => {
    if (shape.type !== 'draw' || shape.meta.agentAnswer || !options.enabled()) return
    recent.set(shape.id, { shape, at: Date.now() })
    changed.add(shape.id)
    if (recent.size > 128) {
      const oldest = recent.keys().next().value!
      recent.delete(oldest); changed.delete(oldest)
    }
  }
  // SDK after-handlers run at transaction end, after pointer-up has released the pen.
  // Claim shapes in before-handlers while the SDK is actually processing their input.
  const claim = (shape: TLShape, source: 'user' | 'remote') => {
    if (source === 'user' && drawingEvent && shape.type === 'draw') owned.add(shape.id)
    return shape
  }
  const removeBeforeCreate = editor.sideEffects.registerBeforeCreateHandler('shape', claim)
  const removeBeforeChange = editor.sideEffects.registerBeforeChangeHandler('shape', (_before, after, source) => claim(after, source))
  const removeCreate = editor.sideEffects.registerAfterCreateHandler('shape', (shape, source) => {
    if (source === 'user' && owned.has(shape.id)) remember(shape)
  })
  const removeChange = editor.sideEffects.registerAfterChangeHandler('shape', (before, after, source) => {
    if (source !== 'user' || before.type !== 'draw' || after.type !== 'draw') return
    if (owned.has(after.id) || (recent.has(after.id) && !before.props.isComplete && after.props.isComplete)) remember(after)
  })
  const removeDelete = editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
    recent.delete(shape.id); changed.delete(shape.id)
  })
  const removeComplete = editor.sideEffects.registerOperationCompleteHandler(() => {
    drawingEvent = false
    owned.clear()
    schedule()
  })

  const beforeEvent = (event: TLEventInfo) => {
    drawingEvent = false
    if (event.type !== 'pointer') return
    if (event.name === 'pointer_down') {
      interrupt('input')
      if (event.button === 0 && editor.getCurrentToolId() === 'draw' && !editor.getIsReadonly() &&
        (!editor.getInstanceState().isPenMode || event.isPen)) pens.add(event.pointerId)
    }
    drawingEvent = pens.has(event.pointerId) && editor.getCurrentToolId() === 'draw' &&
      !editor.getIsReadonly() && !editor.inputs.getIsPanning() && !editor.inputs.getIsPinching() &&
      (event.name === 'pointer_down' || event.name === 'pointer_move' || event.name === 'pointer_up')
  }
  const afterEvent = (event: TLEventInfo) => {
    drawingEvent = false
    if (event.type === 'pointer' && event.name === 'pointer_up') {
      pens.delete(event.pointerId)
      liftedAt = Date.now()
      schedule()
    } else if (event.type === 'misc' && event.name === 'cancel') {
      interrupt('cancel')
      pens.clear()
    }
  }
  editor.on('before-event', beforeEvent)
  editor.on('event', afterEvent)

  const down = (event: PointerEvent) => {
    if ((event.target as Element | null)?.closest('.tools, .history, .tlui')) return
    pointers.add(event.pointerId)
    interrupt('input')
  }
  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return
    liftedAt = Date.now()
    schedule()
  }
  const blur = () => { interrupt('blur'); pointers.clear(); pens.clear(); drawingEvent = false }
  const visibility = () => { if (document.visibilityState !== 'visible') blur() }
  container.addEventListener('pointerdown', down, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  window.addEventListener('blur', blur)
  document.addEventListener('visibilitychange', visibility)
  return () => {
    disposed = true
    blur()
    removeBeforeCreate(); removeBeforeChange(); removeCreate(); removeChange(); removeDelete(); removeComplete()
    editor.off('before-event', beforeEvent)
    editor.off('event', afterEvent)
    container.removeEventListener('pointerdown', down, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', up, true)
    window.removeEventListener('blur', blur)
    document.removeEventListener('visibilitychange', visibility)
  }
}
