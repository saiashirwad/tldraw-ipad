import { useEffect, useRef, useState } from 'react'
import { Box, useEditor } from 'tldraw'
import { installQuestionTrigger, markerIsCurrent, replaceQuestionMarker, type QuestionMarker } from './auto-ask'
import type { openCanvasAssistant } from './canvas-assistant'
import { QUESTION_TARGET_PROMPT } from './ask-prompts'
import { markQuestionInCapture } from './question-capture'

type StreamRecord = { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; message: string }

export function QuestionAnswers({ assistant }: { assistant?: Awaited<ReturnType<typeof openCanvasAssistant>> }) {
  const editor = useEditor()
  const running = useRef<AbortController | null>(null)
  const [failureMessage, setFailureMessage] = useState<string | null>(null)
  useEffect(() => {
    const storageFailure = (event: Event) => { if (event instanceof CustomEvent) setFailureMessage(String(event.detail)) }
    document.addEventListener('canvas-storage-error', storageFailure)
    const dispose = installQuestionTrigger(editor, {
      enabled: () => true,
      busy: () => !!running.current,
      async onCandidate(marker, controller) {
        if (running.current || controller.signal.aborted) return
        running.current = controller
        setFailureMessage(null)
        try {
          if (assistant) await assistant.answerMarker(editor, marker, controller.signal)
          else await answerRemoteMarker(marker, controller)
        } catch (error) {
          if (!controller.signal.aborted) setFailureMessage(error instanceof Error ? error.message : 'The answer failed. Your ink is preserved.')
        } finally { if (running.current === controller) running.current = null }
      },
    })
    return () => { dispose(); running.current?.abort(); document.removeEventListener('canvas-storage-error', storageFailure) }
  }, [editor, assistant])

  async function answerRemoteMarker(marker: QuestionMarker, controller: AbortController) {
    const bounds = Box.From(marker.bounds).expandBy(6 / editor.getZoomLevel())
    const glyph = await editor.toImageDataUrl(marker.ink.map((shape) => shape.id), { format: 'png', bounds,
      padding: 0, background: true, darkMode: false, pixelRatio: 1, scale: 200 / Math.max(bounds.w, bounds.h) })
    if (controller.signal.aborted || !markerIsCurrent(editor, marker)) return
    const checked = await fetch('/api/question-mark', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: controller.signal, body: JSON.stringify({ image: glyph.url }) })
    if (!checked.ok) throw new Error(await failure(checked))
    const recognition: unknown = await checked.json()
    if (!recognition || typeof recognition !== 'object' || !('questionMark' in recognition) || recognition.questionMark !== true ||
      controller.signal.aborted || !markerIsCurrent(editor, marker)) return
    const capture = await window.canvas.capture(false)
    const view = Box.From(capture.bounds)
    if (controller.signal.aborted || !markerIsCurrent(editor, marker) || !view.includes(Box.From(marker.bounds))) return
    const image = await markQuestionInCapture(capture, marker.bounds)
    if (controller.signal.aborted || !markerIsCurrent(editor, marker)) return
    const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ image, prompt: `Current UTC date: ${new Date().toISOString().slice(0, 10)}.\n${QUESTION_TARGET_PROMPT}\nGive only the plain-text answer.` }) })
    if (!response.ok || !response.body) throw new Error(await failure(response))
    let text = '', done = false
    for await (const record of stream(response.body)) {
      if (record.type === 'error') throw new Error(record.message)
      if (record.type === 'delta') text += record.text
      if (record.type === 'done') done = true
    }
    if (controller.signal.aborted) return
    if (!done || !text.trim()) throw new Error('The answer did not finish. Your ? is still there.')
    replaceQuestionMarker(editor, marker, text)
  }
  return failureMessage ? <p className="ask-status controls" role="status">{failureMessage}</p> : null
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
