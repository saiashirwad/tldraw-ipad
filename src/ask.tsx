import { useEffect, useRef, useState } from 'react'
import { Box, createShapeId, toRichText, useEditor, type Editor, type TLShapeId } from 'tldraw'

import { ASK_PRESETS, type AskPreset } from './ask-prompts'
import { answerAnchor, answerSpot, overlaps, type CanvasItem } from './ask-placement'
import { installQuestionTrigger, markerIsCurrent, replaceQuestionMarker, type QuestionMarker } from './auto-ask'

const READING = 'pi is reading your canvas…'
const CHECKING = 'pi is checking your ?…'
const GAP = 24
const MIN_WIDTH = 240
const MAX_WIDTH = 360
const REVEAL_INSET = 48

type StreamRecord = { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; message: string }

/**
 * Ask pi about the drawing. The current viewport is captured on the device and sent
 * with the question; the answer streams back token by token and is written into a
 * single tldraw text shape, so it is real, editable, synced canvas content.
 */
export function AskControl() {
  const editor = useEditor()
  const [asking, setAsking] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [preset, setPreset] = useState<AskPreset>('brief')
  const [autoEnabled, setAutoEnabled] = useState(() => localStorage.getItem('canvas-auto-ask') !== 'off')
  const [status, setStatus] = useState<string | null>(null)
  const running = useRef<AbortController | null>(null)
  const preferences = useRef({ autoEnabled, preset })
  preferences.current = { autoEnabled, preset }

  useEffect(() => () => running.current?.abort(), [])
  useEffect(() => installQuestionTrigger(editor, {
    enabled: () => preferences.current.autoEnabled,
    busy: () => !!running.current,
    onCandidate: answerMarker,
  }), [editor, autoEnabled])

  async function answerMarker(marker: QuestionMarker, controller: AbortController) {
    if (running.current || controller.signal.aborted || !markerIsCurrent(editor, marker)) return
    running.current = controller
    setAsking(true)
    setStatus(CHECKING)
    try {
      // A local geometric prefilter is not permission to erase ink. Confirm the isolated glyph first.
      const bounds = Box.From(marker.bounds).expandBy(6 / editor.getZoomLevel())
      const glyph = await editor.toImageDataUrl(marker.ink.map((shape) => shape.id), {
        format: 'png', bounds, padding: 0, background: true, darkMode: false,
        pixelRatio: 1, scale: 200 / Math.max(bounds.w, bounds.h),
      })
      if (controller.signal.aborted) return
      const checked = await fetch('/api/question-mark', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ image: glyph.url }),
      })
      if (!checked.ok) throw new Error(await failure(checked))
      const recognition = await checked.json() as { questionMark: boolean }
      if (!recognition.questionMark || controller.signal.aborted || !markerIsCurrent(editor, marker)) return

      setStatus(READING)
      const capture = await window.canvas.capture(false)
      const view = Box.From(capture.bounds)
      if (controller.signal.aborted || !markerIsCurrent(editor, marker) || !view.includes(Box.From(marker.bounds))) return
      const x = Math.round((marker.bounds.x + marker.bounds.w / 2 - view.x) / view.w * 100)
      const y = Math.round((marker.bounds.y + marker.bounds.h / 2 - view.y) / view.h * 100)
      const response = await fetch('/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ image: capture.url, preset: preferences.current.preset,
          prompt: `The handwritten ? near ${x}% from the left and ${y}% from the top is an answer slot. Answer the handwritten question immediately beside it. Give only the answer to replace that ?, not an older question or a description of the mark.` }),
      })
      if (!response.ok || !response.body) throw new Error(await failure(response))
      let text = '', done = false
      for await (const record of stream(response.body)) {
        if (record.type === 'error') throw new Error(record.message)
        if (record.type === 'delta') text += record.text
        if (record.type === 'done') done = true
      }
      if (controller.signal.aborted) return
      if (!done || !text.trim()) throw new Error('pi did not finish an answer. Your ? is still there.')
      // Keep the mark until the entire answer is ready, and recheck it after the network wait.
      replaceQuestionMarker(editor, marker, text)
    } catch (error) {
      if (!controller.signal.aborted) setStatus((error as Error).message)
    } finally {
      if (running.current === controller) {
        running.current = null
        setAsking(false)
        setStatus((current) => current === CHECKING || current === READING ? null : current)
      }
    }
  }

  async function ask() {
    if (running.current) {
      running.current.abort()
      return
    }
    const controller = new AbortController()
    running.current = controller
    setAsking(true)
    setStatus(READING)

    let id: TLShapeId | null = null
    let text = ''
    let focus: Box | null = null
    let revealed = false

    try {
      const capture = await window.canvas.capture(false)
      if (controller.signal.aborted) return
      const view = Box.From(capture.bounds)
      // Screen-sized prose stays legible beside even very zoomed-in handwriting.
      const scale = 1 / editor.getZoomLevel()
      const gap = GAP * scale
      const items = canvasItems(editor)
      focus = Box.From(answerAnchor(items, view, gap))
      const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, view.w / scale * .35)) * scale
      const spot = answerSpot(focus, items.map((item) => item.bounds), view, width, 144 * scale, gap)
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ prompt: question.trim(), preset, image: capture.url }),
      })
      if (!response.ok || !response.body) throw new Error(await failure(response))

      for await (const record of stream(response.body)) {
        if (record.type === 'error') throw new Error(record.message)
        if (record.type !== 'delta') continue
        text += record.text
        const answer = id
        if (!answer) {
          id = createShapeId()
          const created = id
          editor.run(() => {
            editor.createShapes([{
              id: created, type: 'text', x: spot.x, y: spot.y, meta: { agentAnswer: true },
              props: { w: spot.w / scale, scale, autoSize: false, size: 's', font: 'sans', color: 'black', richText: toRichText(text) },
            }])
          }, { history: 'ignore' })
        } else {
          if (!editor.getShape(answer)) { controller.abort(); break }
          editor.run(() => {
            editor.updateShapes([{ id: answer, type: 'text', props: { richText: toRichText(text) } }])
          }, { history: 'ignore' })
        }
        // Reflow only if the growing answer would cover existing ink or another reply.
        const bounds = id && editor.getShapePageBounds(id)
        const obstacles = canvasItems(editor, id ?? undefined).map((item) => item.bounds)
        if (id && bounds && obstacles.some((b) => overlaps(bounds, b, gap / 2))) {
          const next = answerSpot(focus, obstacles, view, bounds.w, bounds.h, gap)
          editor.run(() => editor.updateShapes([{ id: id!, type: 'text', x: next.x, y: next.y }]), { history: 'ignore' })
        }
        if (!revealed && id) {
          revealed = true
          setStatus(null)
          reveal(editor, frame(editor, focus, id))
        }
      }
      if (!id) throw new Error('pi answered with nothing. Check the server logs and try again.')
    } catch (error) {
      if (!controller.signal.aborted) setStatus((error as Error).message)
    } finally {
      // The live preview is untracked. Commit its final state as one creation, so redo
      // restores every token and drawing done during the stream keeps its own undo.
      const completed = id && editor.getShape(id)
      if (completed) {
        editor.markHistoryStoppingPoint('ask-pi')
        editor.run(() => {
          editor.run(() => editor.deleteShapes([completed.id]), { history: 'ignore' })
          editor.createShapes([completed])
        })
        editor.markHistoryStoppingPoint('ask-pi-complete')
      }
      if (id && focus) reveal(editor, frame(editor, focus, id))
      if (running.current === controller) {
        running.current = null
        setAsking(false)
        setStatus((current) => (current === READING ? null : current))
      }
    }
  }

  return (
    <div className="ask">
      {questionOpen && (
        <div className="ask-question controls">
          <label className="ask-auto">
            <input type="checkbox" checked={autoEnabled} onChange={(event) => {
              setAutoEnabled(event.target.checked)
              localStorage.setItem('canvas-auto-ask', event.target.checked ? 'on' : 'off')
            }} />
            Answer handwritten ? after a pause
          </label>
          <select aria-label="Reply style" value={preset} disabled={asking}
            onChange={(event) => setPreset(event.target.value as AskPreset)}>
            {Object.entries(ASK_PRESETS).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
          </select>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !asking) void ask() }}
            placeholder="Optional question about your drawing"
            maxLength={2000}
            disabled={asking}
            aria-label="Question for pi"
            enterKeyHint="send"
          />
        </div>
      )}
      <div className="ask-actions controls">
        <button className={asking ? 'active' : ''} aria-label={asking ? 'Stop pi' : 'Ask pi'} onClick={() => void ask()}>
          {asking ? 'Stop' : 'Ask pi'}
        </button>
        <button aria-label="Attach a question" aria-expanded={questionOpen} className={questionOpen ? 'active' : ''}
          onClick={() => setQuestionOpen(!questionOpen)}>⌄</button>
      </div>
      {status && <p className="ask-status controls" role="status">{status}</p>}
    </div>
  )
}

function canvasItems(editor: Editor, ignore?: TLShapeId): CanvasItem[] {
  const selected = new Set(editor.getSelectedShapeIds())
  return editor.getCurrentPageShapes().flatMap((shape) => {
    if (shape.id === ignore || shape.type === 'group' || shape.type === 'frame') return []
    const bounds = editor.getShapePageBounds(shape)
    if (!bounds?.isValid()) return []
    return [{ bounds, ink: shape.type === 'draw', answer: !!shape.meta?.agentAnswer, selected: selected.has(shape.id) }]
  })
}

function frame(editor: Editor, focus: Box, id: TLShapeId): Box {
  const bounds = editor.getShapePageBounds(id)
  const box = focus.clone()
  if (bounds?.isValid()) box.union(bounds)
  return box
}

/** Only move the camera when the handwriting and answer no longer fit on screen. */
function reveal(editor: Editor, box: Box) {
  if (!box.isValid() || box.w <= 0 || box.h <= 0) return
  if (editor.getViewportPageBounds().includes(box.clone().expandBy(GAP / editor.getZoomLevel()))) return
  const screen = editor.getViewportScreenBounds()
  const fit = Math.min((screen.w - REVEAL_INSET * 2) / box.w, (screen.h - REVEAL_INSET * 2) / box.h)
  editor.zoomToBounds(box, { animation: { duration: 280 }, inset: REVEAL_INSET, targetZoom: Math.max(0.05, Math.min(editor.getZoomLevel(), fit)) })
}

async function failure(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null
  return body?.error ?? `pi could not answer (${response.status})`
}

/** Reads the server's newline-delimited JSON stream without splitting on Unicode separators. */
async function* stream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamRecord> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) yield JSON.parse(line) as StreamRecord
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield JSON.parse(buffer) as StreamRecord
  } finally {
    void reader.cancel().catch(() => {})
  }
}
