import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels, type Provider } from '@earendil-works/pi-ai/models'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { AssistantEntry, Harness, createRegistry, type Conversation } from '@earendil-works/pi-durable'
import { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl'
import { createShapeId, type Editor, type TLDrawShape } from 'tldraw'
import { markerIsCurrent, replaceQuestionMarker, type QuestionMarker } from './auto-ask'
import { CANVAS_INPUT_RULES, CANVAS_REPLY_RULES, MAX_ANSWER_CHARS, QUESTION_ANSWER_PROMPT, parseQuestionAnswer } from './ask-prompts'
import { questionContextIsCurrent, type QuestionContext, type QuestionPhase, type QuestionRequest } from './question-request'
import { nativeFetch, nativeFileSystem, randomId, readNativeFile, writeNativeFile } from './native'

type Attempt = {
  id: string; boardId: 'local'; pageId: string; markerFingerprint: string; markerIds: string[];
  answerShapeId: string; context?: QuestionContext; bounds: { x: number; y: number; w: number; h: number }
} & ({ phase: 'recognizing' | 'answering' | 'cancelled' | 'failed' | 'applied' } | { phase: 'ready'; text: string; question: string })

function parseAttempt(text: string): Attempt {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
    !('boardId' in value) || value.boardId !== 'local' || !('pageId' in value) || typeof value.pageId !== 'string' ||
    !('markerFingerprint' in value) || typeof value.markerFingerprint !== 'string' || !('markerIds' in value) ||
    !Array.isArray(value.markerIds) || !value.markerIds.every((id) => typeof id === 'string') ||
    !('answerShapeId' in value) || typeof value.answerShapeId !== 'string' || !value.answerShapeId.startsWith('shape:') ||
    !('bounds' in value) || !value.bounds || typeof value.bounds !== 'object' ||
    !('x' in value.bounds) || typeof value.bounds.x !== 'number' || !('y' in value.bounds) || typeof value.bounds.y !== 'number' ||
    !('w' in value.bounds) || typeof value.bounds.w !== 'number' || !('h' in value.bounds) || typeof value.bounds.h !== 'number' ||
    !('phase' in value) || !['recognizing', 'answering', 'ready', 'cancelled', 'failed', 'applied'].includes(String(value.phase)) ||
    (value.phase === 'ready' && (!('text' in value) || typeof value.text !== 'string' || !('question' in value) || typeof value.question !== 'string'))) throw new Error('Invalid saved question attempt. Ink is preserved.')
  if ('context' in value && value.context !== undefined) {
    const saved = value.context
    if (!saved || typeof saved !== 'object' || !('pageId' in saved) || typeof saved.pageId !== 'string' ||
      !('records' in saved) || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records) ||
      !Object.values(saved.records).every((record) => typeof record === 'string') ||
      !('area' in saved) || !saved.area || typeof saved.area !== 'object' ||
      !['x', 'y', 'w', 'h'].every((key) => typeof (saved.area as Record<string, unknown>)[key] === 'number')) {
      throw new Error('Invalid saved question context. Ink is preserved.')
    }
  }
  return value as Attempt
}

export async function openCanvasAssistant(flushBoard: () => Promise<void>) {
  const context = BACKGROUND_CONTEXT
  const models = createModels({ authContext: { env: async () => 'native-keychain', fileExists: async () => false } })
  const provider = deepseekProvider()
  const nativeProvider: Provider<'openai-completions'> = { ...provider,
    streamSimple: (model, input, options) => provider.streamSimple(model, input, { ...options, fetch: nativeFetch, maxTokens: 320,
      onPayload: (payload) => typeof payload === 'object' && payload !== null ? { ...payload, thinking: { type: 'disabled' } } : payload }),
  }
  models.setProvider(nativeProvider)
  const agent = { model: { provider: 'deepseek', modelId: 'deepseek-flash' }, tools: [], thinkingLevel: 'off' as const }
  const open = async (directory: string, instructions: string) => {
    const storage = await JsonlStorage.open(directory, nativeFileSystem, context, { fsync: true })
    const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { stream: { timeoutMs: 90000 }, retry: { enabled: false }, compaction: { enabled: false } } }, context)
    const conversation = await harness.root(context)
    await conversation.configure({ ...agent, instructions }, context)
    return { harness, conversation }
  }
  const recognition = await open('recognition', 'Decide whether the isolated handwritten glyph is a question mark made of a hook and a separate dot. Output exactly YES or NO. Ambiguous glyphs are NO.')
  const answer = await open('answers', `${CANVAS_INPUT_RULES}\nReturn JSON with question and answer string fields. These prose rules apply only to the answer field:\n${CANVAS_REPLY_RULES}`)
  let running = false
  const save = (attempt: Attempt) => writeNativeFile('attempt.json', JSON.stringify(attempt))
  const ask = async (conversation: Conversation, image: string, prompt: string, requestId: string, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const abort = () => { void conversation.abort(context).catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const submission = await conversation.submit({ type: 'input', requestId, content: [{ type: 'text', text: prompt },
        { type: 'image', data: image.slice(image.indexOf(',') + 1), mimeType: 'image/png' }] }, context)
      if (signal.aborted) { await conversation.abort(context); throw new DOMException('Cancelled', 'AbortError') }
      const settled = await submission.wait(context)
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      if (settled.status !== 'done' || settled.type !== 'input') throw new Error('The answer did not finish. Your ink is preserved.')
      const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
      return entry?.model?.flatMap((message) => message.role === 'assistant' ? message.content.flatMap((part) => part.type === 'text' ? [part.text] : []) : []).join('').trim() ?? ''
    } finally { signal.removeEventListener('abort', abort) }
  }
  return {
    get busy() { return running },
    async reconcile(editor: Editor) {
      const saved = await readNativeFile('attempt.json')
      if (!saved) return
      const attempt = parseAttempt(saved)
      if (attempt.phase === 'applied' || attempt.phase === 'cancelled' || attempt.phase === 'failed') return
      if (attempt.phase !== 'ready') {
        await recognition.conversation.abort(context); await answer.conversation.abort(context)
        await save({ ...attempt, phase: 'cancelled' })
        return
      }
      const ink = editor.getCurrentPageShapes().filter((shape): shape is TLDrawShape => shape.type === 'draw' && attempt.markerIds.includes(shape.id))
        .sort((a, b) => attempt.markerIds.indexOf(a.id) - attempt.markerIds.indexOf(b.id))
      const marker: QuestionMarker = { ids: attempt.markerIds, bounds: attempt.bounds, pageId: editor.getCurrentPageId(), ink }
      if (editor.getCurrentPageShapes().some((shape) => shape.id === attempt.answerShapeId)) { await save({ ...attempt, phase: 'applied' }); return }
      if (!attempt.context || !questionContextIsCurrent(editor, attempt.context) || attempt.pageId !== marker.pageId || JSON.stringify(ink) !== attempt.markerFingerprint || !markerIsCurrent(editor, marker)) {
        await save({ ...attempt, phase: 'cancelled' }); return
      }
      replaceQuestionMarker(editor, marker, attempt.text, createShapeId(attempt.answerShapeId.slice(6)), attempt.question)
      await flushBoard()
      await save({ ...attempt, phase: 'applied' })
    },
    async answerMarker(editor: Editor, request: QuestionRequest, signal: AbortSignal, progress: (phase: QuestionPhase) => void) {
      const { marker } = request
      if (running || signal.aborted || !markerIsCurrent(editor, marker)) return
      running = true
      const id = randomId()
      let attempt: Attempt = { id, boardId: 'local', pageId: marker.pageId, markerFingerprint: JSON.stringify(marker.ink),
        context: request.context, markerIds: marker.ink.map((shape) => shape.id), answerShapeId: createShapeId(), bounds: marker.bounds, phase: 'recognizing' }
      try {
        await flushBoard(); await save(attempt)
        await recognition.conversation.reset(undefined, context)
        progress('recognizing')
        const checked = await ask(recognition.conversation, request.glyph, 'Is this a handwritten question mark? YES or NO.', `${id}-recognition`, signal)
        if (checked !== 'YES' || signal.aborted || !markerIsCurrent(editor, marker) || !questionContextIsCurrent(editor, request.context)) { await save({ ...attempt, phase: 'cancelled' }); return }
        attempt = { ...attempt, phase: 'answering' }; await save(attempt)
        progress('answering')
        await answer.conversation.reset(undefined, context)
        const reply = await ask(answer.conversation, request.image, `Current UTC date: ${new Date().toISOString().slice(0, 10)}.\n${QUESTION_ANSWER_PROMPT}`, `${id}-answer`, signal)
        if (signal.aborted || !markerIsCurrent(editor, marker) || !questionContextIsCurrent(editor, request.context)) { await save({ ...attempt, phase: 'cancelled' }); return }
        const { question, answer: text } = parseQuestionAnswer(reply)
        const brief = text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…` : text
        attempt = { ...attempt, phase: 'ready', text: brief, question }; await save(attempt)
        await request.waitForInput()
        if (signal.aborted || !markerIsCurrent(editor, marker) || !questionContextIsCurrent(editor, request.context)) { await save({ ...attempt, phase: 'cancelled' }); return }
        request.releaseGuard()
        replaceQuestionMarker(editor, marker, brief, createShapeId(attempt.answerShapeId.slice(6)), question)
        await flushBoard(); await save({ ...attempt, phase: 'applied' })
      } catch (error) {
        await save({ ...attempt, phase: signal.aborted ? 'cancelled' : 'failed' })
        if (!signal.aborted) throw error
      } finally { running = false }
    },
    async close() { await recognition.harness.close(context); await answer.harness.close(context) },
  }
}
