import { Box, type Editor, type TLRecord } from 'tldraw'
import type { QuestionMarker } from './auto-ask'
import type { Rect } from './ask-placement'
import { markQuestionInCapture } from './question-capture'

export type QuestionContext = { pageId: string; bounds: Rect; area: Rect; records: Record<string, string> }
export type QuestionRequest = { marker: QuestionMarker; context: QuestionContext; glyph: string; image: string; releaseGuard(): void; waitForInput(): Promise<void> }
export type QuestionPhase = 'capturing' | 'recognizing' | 'answering'

export function questionContextIsCurrent(editor: Editor, context: QuestionContext) {
  if (editor.getCurrentPageId() !== context.pageId || editor.getIsReadonly()) return false
  const records = new Map(editor.store.allRecords().map((record) => [record.id as string, record]))
  for (const [id, serialized] of Object.entries(context.records)) {
    if (JSON.stringify(records.get(id)) !== serialized) return false
  }
  const area = Box.From(context.area)
  return editor.getCurrentPageShapes().every((shape) => context.records[shape.id] || !editor.getShapePageBounds(shape)?.collides(area)) &&
    editor.store.allRecords().every((record) => record.typeName !== 'binding' || context.records[record.id] ||
      (!context.records[record.fromId] && !context.records[record.toId]))
}

export function beginQuestionRequest(editor: Editor, marker: QuestionMarker, controller: AbortController, waitForInput: () => Promise<void>) {
  const bounds = editor.getViewportPageBounds().clone()
  const zoom = editor.getZoomLevel()
  const area = new Box(Math.max(bounds.x, marker.bounds.x - 440 / zoom), Math.max(bounds.y, marker.bounds.y - 160 / zoom), 0, 0)
  area.w = Math.min(bounds.maxX, marker.bounds.x + marker.bounds.w + 48 / zoom) - area.x
  area.h = Math.min(bounds.maxY, marker.bounds.y + marker.bounds.h + 48 / zoom) - area.y
  const visible = editor.getCurrentPageShapes().filter((shape) => editor.getShapePageBounds(shape)?.collides(bounds))
  const records: Record<string, string> = {}
  const add = (record: TLRecord | undefined) => {
    if (!record || records[record.id]) return
    records[record.id] = JSON.stringify(record)
    if (record.typeName === 'shape') {
      add(editor.store.get(record.parentId))
      if ('assetId' in record.props && typeof record.props.assetId === 'string') add(editor.getAsset(record.props.assetId))
      for (const binding of editor.getBindingsInvolvingShape(record.id)) {
        add(binding)
        add(editor.getShape(binding.fromId)); add(editor.getShape(binding.toId))
      }
    }
  }
  visible.forEach(add)
  const context: QuestionContext = { pageId: marker.pageId, bounds: bounds.toJson(), area: area.toJson(), records }
  const invalidate = () => controller.abort('context-changed')
  const changed = (record: TLRecord) => {
    if (records[record.id] || (record.typeName === 'binding' && (records[record.fromId] || records[record.toId]))) invalidate()
    else if (record.typeName === 'shape' && editor.getCurrentPageShapeIds().has(record.id) &&
      [...editor.getShapeAndDescendantIds([record.id])].some((id) => editor.getShapePageBounds(id)?.collides(area))) invalidate()
  }
  // Side effects observe every edit, including an edit undone before async export completes.
  const disposers: (() => void)[] = []
  for (const type of ['shape', 'asset', 'binding', 'page'] as const) {
    disposers.push(editor.sideEffects.registerAfterCreateHandler(type, (record) => changed(record)))
    disposers.push(editor.sideEffects.registerAfterChangeHandler(type, (_before, after) => changed(after)))
    disposers.push(editor.sideEffects.registerAfterDeleteHandler(type, (record) => { if (records[record.id]) invalidate() }))
  }
  disposers.push(editor.sideEffects.registerAfterChangeHandler('instance', (before, after) => {
    if (before.currentPageId !== after.currentPageId || after.isReadonly) controller.abort('page-changed')
  }))
  const dispose = () => { disposers.splice(0).forEach((remove) => remove()) }
  return {
    context,
    dispose,
    async capture(): Promise<QuestionRequest> {
      const glyphBounds = Box.From(marker.bounds).expandBy(6 / zoom)
      const [glyph, capture] = await Promise.all([
        editor.toImageDataUrl(marker.ink.map((shape) => shape.id), { format: 'png', bounds: glyphBounds, padding: 0,
          background: true, darkMode: false, pixelRatio: 1, scale: 200 / Math.max(glyphBounds.w, glyphBounds.h) }),
        editor.toImageDataUrl(visible.map((shape) => shape.id), { format: 'png', bounds, padding: 0,
          background: true, darkMode: false, pixelRatio: 1, scale: Math.min(1, 2400 / Math.max(bounds.w, bounds.h)) }),
      ])
      const image = await markQuestionInCapture({ url: capture.url, bounds }, marker.bounds)
      if (controller.signal.aborted || !questionContextIsCurrent(editor, context)) throw new DOMException('Question context changed', 'AbortError')
      return { marker, context, glyph: glyph.url, image, releaseGuard: dispose, waitForInput }
    },
  }
}
