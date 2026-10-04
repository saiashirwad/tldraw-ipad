import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useValue, type Editor, type TLShapeId } from 'tldraw'
import { restoreQuestionMarker, type QuestionMarker } from './auto-ask'
import type { Rect } from './ask-placement'
import type { QuestionPhase } from './question-request'

export type QuestionProgress = { phase: QuestionPhase; marker: QuestionMarker; area: Rect; cancel(): void }

export function QuestionUI({ editor, progress, failure }: { editor: Editor; progress: QuestionProgress | null; failure: string | null }) {
  const [inspected, setInspected] = useState<TLShapeId | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const selection = useValue('question selection', () => {
    const shapes = editor.getSelectedShapes()
    return shapes.length === 1 && shapes[0].meta.agentAnswer ? shapes[0].id : null
  }, [editor])
  useEffect(() => { setInspected(selection); setRestoreError(null) }, [selection])
  useEffect(() => {
    const inspect = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') { setInspected(event.detail as TLShapeId); setRestoreError(null) }
    }
    const dismiss = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest('.question-controls')) setInspected(null) }
    editor.getContainer().addEventListener('pointerdown', dismiss, true)
    editor.getContainer().addEventListener('inspect-question-answer', inspect)
    return () => { editor.getContainer().removeEventListener('pointerdown', dismiss, true); editor.getContainer().removeEventListener('inspect-question-answer', inspect) }
  }, [editor])
  const layout = useValue('question overlay', () => {
    const screen = editor.getViewportScreenBounds()
    const position = (rect: Rect) => {
      const point = editor.pageToScreen(rect)
      return { left: point.x - screen.x, top: point.y - screen.y, width: rect.w * editor.getZoomLevel(), height: rect.h * editor.getZoomLevel() }
    }
    const answer = inspected ? editor.getShape(inspected) : undefined
    const answerBounds = answer && editor.getShapePageBounds(answer)
    return { area: progress ? position(progress.area) : null, marker: progress ? position(progress.marker.bounds) : null,
      answer, anchor: answerBounds ? position(answerBounds) : null, width: screen.w, height: screen.h }
  }, [editor, inspected, progress])
  const anchor = layout.anchor
  return createPortal(<>
    {layout.area && <div className="question-area" style={layout.area} />}
    {progress && layout.marker && <div className="question-progress question-controls controls" role="status"
      style={{ left: Math.max(8, Math.min(layout.width - 170, layout.marker.left)), top: Math.max(8, Math.min(layout.height - 56, layout.marker.top + layout.marker.height + 10)) }}>
      <span>{progress.phase === 'answering' ? 'Answering…' : 'Reading…'}</span>
      <button aria-label="Cancel answer" onClick={progress.cancel}>×</button>
    </div>}
    {layout.answer && anchor && <div className="question-inspector question-controls controls" role="dialog" aria-label="Answer details"
      style={{ left: Math.max(8, Math.min(layout.width - 296, anchor.left)), top: Math.max(8, Math.min(layout.height - 220, anchor.top + anchor.height + 8)) }}>
      {typeof layout.answer.meta.questionTranscription === 'string' && <p className="question-transcription"><span>Read as</span>{layout.answer.meta.questionTranscription}</p>}
      {restoreError && <p role="alert">{restoreError}</p>}
      <div className="tool-row">
        <button aria-label="Restore question mark" onClick={() => {
          try { restoreQuestionMarker(editor, layout.answer!.id); setInspected(null); setRestoreError(null) }
          catch (error) { setRestoreError(error instanceof Error ? error.message : 'Could not restore the question mark.') }
        }}>Restore ?</button>
        <button aria-label="Close answer details" onClick={() => setInspected(null)}>Close</button>
      </div>
    </div>}
    {failure && <p className="ask-status question-failure question-controls controls" role="status">{failure}</p>}
  </>, editor.getContainer())
}
