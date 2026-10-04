import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CANVAS_SYSTEM_PROMPT, createPiAgent, limitAnswer } from '../pi'
import { buildAskPrompt, MAX_ANSWER_CHARS, QUESTION_ANSWER_PROMPT, parseQuestionAnswer } from '../src/ask-prompts'

const collect = async (deltas: AsyncIterable<string>) => {
  let text = ''
  for await (const delta of deltas) text += delta
  return text
}

test('custom prompts include brevity and preserve a typed question', () => {
  const prompt = buildAskPrompt('  Why is this wrong?  ')
  assert.match(prompt, /My question: Why is this wrong\?/)
  assert.match(prompt, /1–3 short sentences/)
  assert.match(prompt, /at most 60 words/)
  assert.match(prompt, new RegExp(`under ${MAX_ANSWER_CHARS} characters`))
  assert.match(prompt, /Respond to their meaning, not their appearance/)
  assert.match(prompt, /Never critique letter shapes/)
  assert.equal(buildAskPrompt(undefined), buildAskPrompt(''))
  assert.match(CANVAS_SYSTEM_PROMPT, /not a chat essay/)
  assert.match(QUESTION_ANSWER_PROMPT, /red box marks the handwritten question mark/)
  assert.match(QUESTION_ANSWER_PROMPT, /Use only this current image/)
  assert.doesNotMatch(CANVAS_SYSTEM_PROMPT, /one short sentence at most|2–12 words|at most 25 words/)
})

test('structured question answers require a transcription and render only answer text', () => {
  const reply = JSON.stringify({ question: 'What is a monad?', answer: '  A monad composes computations while carrying a context.  ' })
  assert.equal(parseQuestionAnswer(reply), 'A monad composes computations while carrying a context.')
  assert.equal(parseQuestionAnswer(`\`\`\`json\n${reply}\n\`\`\``), parseQuestionAnswer(reply))
  for (const invalid of ['2', '{', '{}', '{"question":"","answer":"2"}', '{"question":"What?","answer":" "}', '{"question":1,"answer":"2"}']) {
    assert.throws(() => parseQuestionAnswer(invalid))
  }
  const long = 'A useful explanation. '.repeat(30)
  assert.equal(parseQuestionAnswer(JSON.stringify({ question: 'Explain this.', answer: long })), long.trim(), 'parse the complete JSON before applying the answer limit')
})

test('default replies answer the message instead of grading the handwriting', () => {
  const prompt = buildAskPrompt('')
  assert.doesNotMatch(prompt, /give one useful observation/)
  assert.match(prompt, /unfinished equation/)
  assert.match(prompt, /one concrete next step/)
  assert.match(prompt, /for a greeting, reply naturally/)
  assert.match(prompt, /Do not pad a simple answer with coaching/)
  assert.match(CANVAS_SYSTEM_PROMPT, /"1 \+ 1 =" → Reply: "2"/)
  assert.match(CANVAS_SYSTEM_PROMPT, /"what's up\?" → Reply: "Hey! What are we working on\?"/)
})

test('short replies stream unchanged; excessive output closes the producer', async () => {
  let closed = false
  let chunks = 0
  async function* short() { yield 'One '; yield ''; yield 'answer.' }
  assert.equal(await collect(limitAnswer(short())), 'One answer.')
  async function* long() {
    try { for (let i = 0; i < 100; i++) { chunks++; yield 'Too much text. '.repeat(10) } }
    finally { closed = true }
  }
  const text = await collect(limitAnswer(long()))
  assert(text.length <= MAX_ANSWER_CHARS)
  assert(text.endsWith('…'))
  assert(closed)
  assert(chunks < 100, 'must stop generation, not silently discard the rest')
  async function* unicode() { yield 'x'.repeat(MAX_ANSWER_CHARS - 2) + '🖊'.repeat(10) }
  const clipped = await collect(limitAnswer(unicode()))
  assert(!/[\uD800-\uDBFF]…$/.test(clipped), 'must not leave half a surrogate pair')
})

test('hitting the reply cap aborts the RPC run and the next ask still works', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'tldraw-ask-rpc-'))
  const command = resolve(dir, 'fake-pi.mjs')
  // A local scripted protocol peer, not a real model/provider invocation.
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(resolve(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)))
const send = (record) => process.stdout.write(JSON.stringify(record) + '\\n')
let active = false, buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const input = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
    if (input.type === 'abort') { active = false; send({ type: 'agent_settled' }); continue }
    if (input.type !== 'prompt') continue
    if (active) { send({ type: 'response', command: 'prompt', success: false, error: 'Still busy' }); continue }
    active = true
    const long = input.message === 'long'
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: long ? 'x'.repeat(1000) : 'A short reply.' } })
    if (!long) { active = false; send({ type: 'agent_settled' }) }
  }
})

`)
  await chmod(command, 0o700)
  const agent = createPiAgent({ command, cwd: dir, model: 'test/scripted' })
  try {
    const long = await collect(limitAnswer(agent.run({ prompt: 'long' })))
    assert.equal(long.length, MAX_ANSWER_CHARS)
    assert(long.endsWith('…'))
    assert.equal(await collect(limitAnswer(agent.run({ prompt: 'short' }))), 'A short reply.')
    const args: string[] = JSON.parse(await readFile(resolve(dir, 'args.json'), 'utf8'))
    assert(args.includes('--no-tools'))
    assert(args.includes('--no-context-files'))
    assert.equal(args[args.indexOf('--system-prompt') + 1], CANVAS_SYSTEM_PROMPT)
  } finally {
    agent.dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('settled RPC abort releases process timers', { timeout: 5000 }, async () => {
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern=^hitting the reply cap',
    resolve(import.meta.dirname, 'ask.test.ts')], { timeout: 3000 })
})
