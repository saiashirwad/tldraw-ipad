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
export function replaceQuestionMarker(editor: Editor, marker: QuestionMarker, text: string, id = createShapeId(), question?: string) {
  if (!text.trim() || !markerIsCurrent(editor, marker)) return null
  const zoom = editor.getZoomLevel()
  const scale = 20 / (18 * zoom)
  const width = Math.max(160, Math.min(320, (editor.getViewportPageBounds().maxX - marker.bounds.x) * zoom - 16))
  editor.markHistoryStoppingPoint('answer-question-mark')
  editor.run(() => {
    editor.deleteShapes(marker.ink.map((shape) => shape.id))
    editor.createShapes([{
      id, type: 'text', x: marker.bounds.x, y: marker.bounds.y,
      meta: { agentAnswer: true, questionMarkInk: JSON.parse(JSON.stringify(marker.ink)), ...(question ? { questionTranscription: question } : {}) },
      props: { richText: toRichText(text.trim()), size: 's', font: 'sans', color: 'black', scale,
        autoSize: false, w: width / (scale * zoom) },
    }])
    const bounds = editor.getShapePageBounds(id)!.clone()
    const initialY = bounds.y
    const gap = 12 / zoom
    const obstacles = editor.getCurrentPageShapes().filter((shape) => shape.id !== id && (shape.type === 'draw' || shape.type === 'text'))
      .map((shape) => editor.getShapePageBounds(shape)!).sort((a, b) => a.y - b.y)
    for (const other of obstacles) {
      if (bounds.clone().expandBy(gap).collides(other)) bounds.y = other.maxY + gap
    }
    if (bounds.y !== initialY) editor.updateShapes([{ id, type: 'text', y: marker.bounds.y + bounds.y - initialY }])
  })
  editor.markHistoryStoppingPoint('answer-question-mark-complete')
  return id
}

/** Restore only this answer's original ink; the SDK history retains the surrounding work. */
export function restoreQuestionMarker(editor: Editor, answerId: TLShapeId) {
  const answer = editor.getShape(answerId)
  if (!answer?.meta.agentAnswer || editor.getIsReadonly() || answer.isLocked) throw new Error('This answer cannot be restored.')
  const saved = answer.meta.questionMarkInk
  if (!Array.isArray(saved) || !saved.length) throw new Error('The original question mark is unavailable.')
  const ink = saved.map((value) => {
    const record = editor.store.schema.types.shape.validate(value)
    if (record.typeName !== 'shape' || record.type !== 'draw') throw new Error('The saved marker ink is invalid.')
    return record
  })
  const ids = new Set(ink.map((shape) => shape.id))
  if (ids.size !== ink.length || ink.some((shape) => shape.type !== 'draw' || editor.getShape(shape.id))) {
    throw new Error('The original question mark IDs are occupied. Nothing was changed.')
  }
  if (ink.some((shape) => !editor.store.get(shape.parentId) || shape.parentId === answerId)) {
    throw new Error('The question mark’s original parent is missing. Nothing was changed.')
  }
  editor.markHistoryStoppingPoint('restore-question-mark')
  editor.run(() => { editor.deleteShapes([answerId]); editor.createShapes(ink) })
  editor.markHistoryStoppingPoint('restore-question-mark-complete')
}

/** Local pen/mouse input only: sync, page loads, CLI drawing, undo, and agent replies cannot trigger it. */
export function installQuestionTrigger(editor: Editor, options: {
  enabled(): boolean
  busy(): boolean
  onCandidate(marker: QuestionMarker, controller: AbortController, waitForInput: () => Promise<void>): Promise<void>
}) {
  const recent = new Map<string, { shape: TLDrawShape; at: number }>()
  const changed = new Set<string>()
  const tried = new Set<string>()
  const pending = new Map<string, QuestionMarker>()
  const pointers = new Set<number>()
  const pens = new Set<number>()
  const owned = new Set<TLShapeId>()
  const idleWaiters = new Set<() => void>()
  const settleIdle = () => { if (!pointers.size && !pens.size) for (const settle of idleWaiters) settle() }
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
    for (const [key, marker] of pending) {
      if (marker.ink.some((shape) => JSON.stringify(editor.getShape(shape.id)) !== JSON.stringify(shape))) pending.delete(key)
    }
    if (disposed || pointers.size || pens.size || !options.enabled()) return
    const visible = (shape: TLShape) => editor.getShapePageBounds(shape)?.collides(editor.getViewportPageBounds())
    const newInk = [...changed].some((id) => { const entry = recent.get(id); return entry && visible(entry.shape) })
    const waiting = !active && [...pending.values()].some((marker) => marker.pageId === editor.getCurrentPageId() && marker.ink.some(visible))
    if (!newInk && !waiting) return
    timer = setTimeout(() => { void inspect() }, Math.max(0, liftedAt + QUESTION_IDLE_MS - Date.now()))
  }

  async function inspect() {
    timer = undefined
    if (disposed || pointers.size || pens.size || !options.enabled() || document.visibilityState !== 'visible') return
    for (const [id, entry] of recent) {
      if (!editor.getShape(entry.shape.id)) { recent.delete(id); changed.delete(id) }
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
    for (const { shape } of entries) changed.delete(shape.id)
    for (const candidate of candidates) {
      const ink = candidate.ids.flatMap((id) => recent.get(id)?.shape ?? [])
      if (ink.length !== candidate.ids.length) continue
      const marker: QuestionMarker = { ...candidate, pageId: editor.getCurrentPageId(), ink }
      const fingerprint = JSON.stringify(ink)
      if (tried.has(fingerprint) || !markerIsCurrent(editor, marker) || pending.has(fingerprint)) continue
      pending.set(fingerprint, marker)
    }
    if (active || options.busy()) return
    for (const [key, marker] of pending) {
      if (marker.pageId === editor.getCurrentPageId() && !markerIsCurrent(editor, marker)) pending.delete(key)
    }
    const next = [...pending].find(([, marker]) => marker.pageId === editor.getCurrentPageId() &&
      marker.ink.some((shape) => editor.getShapePageBounds(shape)?.collides(editor.getViewportPageBounds())))
    if (!next) return
    const [fingerprint, marker] = next
    const controller = new AbortController()
    active = controller
    try {
      await options.onCandidate(marker, controller, () => new Promise<void>((resolve, reject) => {
        if (controller.signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return }
        const settle = () => { idleWaiters.delete(settle); controller.signal.removeEventListener('abort', abort); resolve() }
        const abort = () => { idleWaiters.delete(settle); reject(new DOMException('Cancelled', 'AbortError')) }
        idleWaiters.add(settle)
        controller.signal.addEventListener('abort', abort, { once: true })
        settleIdle()
      }))
    } finally {
      if (controller.signal.aborted && controller.signal.reason === 'context-changed' && markerIsCurrent(editor, marker)) {
        liftedAt = Date.now()
      } else {
        pending.delete(fingerprint)
        tried.add(fingerprint)
        if (tried.size > 256) tried.delete(tried.values().next().value!)
      }
      if (active === controller) active = null
      schedule()
    }
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
    if (editor.getInstanceState().isPenMode && !event.isPen) return
    if (event.name === 'pointer_down') {
      clearTimer()
      if (event.button === 0 && editor.getCurrentToolId() === 'draw' && !editor.getIsReadonly()) pens.add(event.pointerId)
    }
    drawingEvent = pens.has(event.pointerId) && editor.getCurrentToolId() === 'draw' &&
      !editor.getIsReadonly() && !editor.inputs.getIsPanning() && !editor.inputs.getIsPinching() &&
      (event.name === 'pointer_down' || event.name === 'pointer_move' || event.name === 'pointer_up')
  }
  const afterEvent = (event: TLEventInfo) => {
    drawingEvent = false
    if (event.type === 'pointer' && event.name === 'pointer_up' && pens.delete(event.pointerId)) {
      liftedAt = Date.now()
      settleIdle()
      schedule()
    } else if (event.type === 'misc' && event.name === 'cancel') {
      interrupt('cancel')
      pens.clear()
    }
  }
  editor.on('before-event', beforeEvent)
  editor.on('event', afterEvent)

  const down = (event: PointerEvent) => {
    if ((event.target as Element | null)?.closest('.tools, .history, .tlui, .question-controls')) return
    if (event.pointerType === 'touch' && editor.getInstanceState().isPenMode) return
    pointers.add(event.pointerId)
    clearTimer()
  }
  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return
    liftedAt = Date.now()
    settleIdle()
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
