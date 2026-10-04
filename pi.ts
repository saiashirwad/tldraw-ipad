import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { CANVAS_INPUT_RULES, CANVAS_REPLY_RULES, MAX_ANSWER_CHARS } from './src/ask-prompts'

/** One prompt plus the screenshot of the canvas it is answering about. */
export type AskInput = { prompt: string; image?: { data: string; mimeType: string } }

/**
 * Streams an assistant answer for one prompt. Each yielded string is a token delta,
 * so callers can render the answer as it is written.
 */
export interface AskRunner {
  run(input: AskInput, signal?: AbortSignal): AsyncGenerator<string>
  dispose?(): void
}

export const DEFAULT_MODEL = 'deepseek/deepseek-flash'

/**
 * The model is asked for plain canvas prose, not a chat reply: the answer is
 * written straight into a tldraw text box, so markdown would show up literally.
 */
export const CANVAS_SYSTEM_PROMPT = `You are a useful thinking partner on a shared drawing canvas, not a handwriting reviewer or screenshot narrator. Every message includes the user's current view. Your reply is a small note beside their writing, not a chat essay.

${CANVAS_INPUT_RULES}

Answer the substance of the user's current message. A typed question takes priority; otherwise focus on the latest handwritten question or unfinished equation, not every mark on the page. Solve a problem, complete the expression, give one concrete next action, or respond to a greeting normally. If the task or a crucial symbol is unclear, ask one focused question instead of guessing or filling space with observations.

Examples of the default behavior:
Handwriting: "what's up?" → Reply: "Hey! What are we working on?"
Handwriting: "woot!" → Reply: "Nice! What's next?"
Handwriting: "1 + 1 =" → Reply: "2"
Handwriting: "2x + 4 = 10" → Reply: "x = 3"
Handwriting: "app idea: habit tracker" → Reply: "Start with one habit and a daily check-in."
Do not append comments about how the words or numerals are written.

Respect the requested style: a hint gives one hint without the solution; a next step gives one action; a check gives the main content correction, not a full rewrite. No preamble, screenshot description, or generic praise.

${CANVAS_REPLY_RULES}`

/** Stop consuming (and close the upstream generator) if a model ignores the short-note prompt. */
export async function* limitAnswer(deltas: AsyncIterable<string>): AsyncGenerator<string> {
  let written = 0
  for await (const delta of deltas) {
    const remaining = MAX_ANSWER_CHARS - written
    if (delta.length >= remaining) {
      // Avoid splitting a surrogate pair when the last chunk is clipped.
      const end = delta.slice(0, Math.max(0, remaining - 1)).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
      yield end + '…'
      return
    }
    written += delta.length
    if (delta) yield delta
  }
}

const ABORT_GRACE_MS = 5_000

/** A single-consumer async queue that ends when the run settles or fails. */
class DeltaQueue {
  #values: string[] = []
  #waiters: Array<(result: IteratorResult<string>) => void> = []
  #closed = false
  #error: Error | null = null
  readonly settled: Promise<void>
  #settle!: () => void

  constructor() {
    this.settled = new Promise((resolve) => { this.#settle = resolve })
  }

  get error() {
    return this.#error
  }

  push(value: string) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.#values.push(value)
  }

  close(error?: Error) {
    if (this.#closed) return
    this.#closed = true
    this.#error = error ?? null
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as never, done: true })
    this.#settle()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (;;) {
      const value = this.#values.shift()
      if (value !== undefined) { yield value; continue }
      if (this.#closed) return
      const result = await new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve))
      if (result.done) return
      yield result.value
    }
  }
}

/**
 * Runs one long-lived `pi --mode rpc` child and exposes it as a stream of answers.
 * Keeping the process warm preserves the conversation across asks, so a user can
 * draw, ask, refine, and ask again. Asks are serialized: a new ask aborts the one
 * in flight, because a fresh question means the previous answer is no longer wanted.
 */
export function createPiAgent(options: {
  command?: string
  model?: string
  cwd?: string
  timeoutMs?: number
  systemPrompt?: string
} = {}): AskRunner {
  const command = options.command ?? process.env.TLDRAW_IPAD_PI ?? 'pi'
  const model = options.model ?? process.env.TLDRAW_IPAD_MODEL ?? DEFAULT_MODEL
  const cwd = options.cwd ?? process.cwd()
  const timeoutMs = options.timeoutMs ?? 180_000
  const systemPrompt = options.systemPrompt ?? CANVAS_SYSTEM_PROMPT

  let child: ChildProcessWithoutNullStreams | null = null
  let buffer = ''
  let diagnostics = ''
  let sink: DeltaQueue | null = null
  let requestId = 0

  function write(record: Record<string, unknown>) {
    child?.stdin.write(`${JSON.stringify(record)}\n`)
  }

  function closeSink(error?: Error) {
    const current = sink
    sink = null
    current?.close(error)
  }

  function receive(line: string) {
    let record: { type?: string; command?: string; success?: boolean; error?: string; assistantMessageEvent?: { type?: string; delta?: string } }
    try { record = JSON.parse(line) } catch { return }
    if (record.type === 'message_update' && record.assistantMessageEvent?.type === 'text_delta') {
      sink?.push(record.assistantMessageEvent.delta ?? '')
    } else if (record.type === 'agent_settled') {
      closeSink()
    } else if (record.type === 'response' && record.command === 'prompt' && record.success === false) {
      closeSink(new Error(record.error ?? 'pi could not start a run'))
    }
  }

  function start() {
    diagnostics = ''
    buffer = ''
    const spawned = spawn(command, [
      '--mode', 'rpc',
      '--no-session',
      '--no-tools',
      '--no-context-files',
      '--model', model,
      '--system-prompt', systemPrompt,
    ], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    child = spawned
    spawned.stdout.setEncoding('utf8')
    spawned.stderr.setEncoding('utf8')
    spawned.stdin.on('error', () => {})
    spawned.stderr.on('data', (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-4000) })
    spawned.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line) receive(line)
      }
    })
    spawned.on('error', (error: NodeJS.ErrnoException) => {
      child = null
      closeSink(error.code === 'ENOENT'
        ? new Error(`Could not run "${command}". Install pi or set TLDRAW_IPAD_PI to it.`)
        : error)
    })
    spawned.on('exit', () => {
      child = null
      closeSink(new Error(`pi exited before answering${diagnostics.trim() ? `: ${diagnostics.trim()}` : ''}`))
    })
  }

  /** Stops the active run, killing and respawning pi if it does not settle promptly. */
  async function abort() {
    const current = sink
    if (!current) return
    write({ type: 'abort' })
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([current.settled.then(() => true), new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ABORT_GRACE_MS)
    })])
    clearTimeout(timer)
    if (!settled) {
      const stale = child
      child = null
      stale?.kill()
    }
    if (sink === current) closeSink()
  }

  async function* run({ prompt, image }: AskInput, signal?: AbortSignal): AsyncGenerator<string> {
    if (sink) await abort()
    if (!child) start()
    if (!child) throw new Error('pi could not be started')

    const queue = new DeltaQueue()
    sink = queue
    write({
      id: `ask-${++requestId}`, type: 'prompt', message: prompt,
      ...(image ? { images: [{ type: 'image', data: image.data, mimeType: image.mimeType }] } : {}),
    })

    const expire = setTimeout(() => {
      if (sink !== queue) return
      closeSink(new Error('pi took too long to answer'))
      write({ type: 'abort' })
    }, timeoutMs)
    const stop = () => { void abort() }
    signal?.addEventListener('abort', stop, { once: true })

    try {
      for await (const delta of queue) yield delta
      if (queue.error) throw queue.error
    } finally {
      clearTimeout(expire)
      signal?.removeEventListener('abort', stop)
      // Early iterator return (the reply cap) must stop the provider, not just drop its tokens.
      if (sink === queue) await abort()
    }
  }

  function dispose() {
    const stale = child
    child = null
    closeSink()
    stale?.kill()
  }

  return { run, dispose }
}
