import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CANVAS_SYSTEM_PROMPT, createPiAgent, limitAnswer } from '../pi'
import { ASK_PRESETS, buildAskPrompt, MAX_ANSWER_CHARS } from '../src/ask-prompts'
import { answerAnchor, answerSpot, overlaps, type CanvasItem, type Rect } from '../src/ask-placement'

const view = { x: 0, y: 0, w: 1024, h: 768 }
const ink = { x: 170, y: 370, w: 115, h: 30 }
const item = (bounds: Rect, options: Partial<CanvasItem> = {}): CanvasItem => ({ bounds, ink: true, answer: false, selected: false, ...options })
const collect = async (deltas: AsyncIterable<string>) => {
  let text = ''
  for await (const delta of deltas) text += delta
  return text
}

// Pure geometry checks don't require a browser or touch the shared board.
test('answer anchor uses visible handwriting or selection, never old replies', () => {
  const items = [item(ink), item({ x: 100, y: 100, w: 600, h: 100 }, { ink: false }),
    item({ x: 0, y: 10000, w: 500, h: 100 }, { answer: true })]
  assert.deepEqual(answerAnchor(items, view, 24), ink)
  items[1].selected = true
  assert.deepEqual(answerAnchor(items, view, 24), items[1].bounds)
  assert.deepEqual(answerAnchor([item(ink, { answer: true })], view, 24), { x: 24, y: 24, w: 0, h: 0 })
})

test('partial shapes anchor to the visible portion, and diagrams work without ink', () => {
  const diagram = item({ x: -100, y: 50, w: 250, h: 200 }, { ink: false })
  assert.deepEqual(answerAnchor([diagram], view, 24), { x: 0, y: 50, w: 150, h: 200 })
})

test('reply hugs the handwriting, not the viewport or distant answers', () => {
  const spot = answerSpot(ink, [ink, { x: 0, y: 10000, w: 640, h: 400 }], view, 360, 144, 24)
  assert.deepEqual(spot, { x: 309, y: 370, w: 360, h: 144 })
  assert(!overlaps(spot, ink))
})

test('a crowded right side uses another nearby slot; growing text does not cover ink', () => {
  const obstacles = [ink, { x: 300, y: 340, w: 650, h: 200 }, { x: 100, y: 540, w: 800, h: 120 }]
  for (const height of [144, 350]) {
    const spot = answerSpot(ink, obstacles, view, 300, height, 24)
    assert(obstacles.every((b) => !overlaps(spot, b, 12)))
    assert(spot.y < 370, 'expected the clear space above the writing')
  }
})

test('zoomed-in ink and writing at the viewport edge still get nearby readable space', () => {
  const zoomedView = { x: 3000, y: 3000, w: 256, h: 192 }
  const zoomedInk = { x: 3025, y: 3050, w: 35, h: 8 }
  const spot = answerSpot(zoomedInk, [zoomedInk, { x: 0, y: 10000, w: 600, h: 400 }], zoomedView, 90, 36, 6)
  assert.equal(spot.x, 3066)
  const edge = { x: 980, y: 300, w: 40, h: 60 }
  const edgeSpot = answerSpot(edge, [edge], view, 300, 144, 24)
  assert.equal(edgeSpot.x, 656, 'left side is nearer than going offscreen to the right')
})

test('every custom prompt includes brevity and preserves a typed question', () => {
  for (const mode of Object.keys(ASK_PRESETS)) {
    const prompt = buildAskPrompt('  Why is this wrong?  ', mode)
    assert.match(prompt, /My question: Why is this wrong\?/)
    assert.match(prompt, /one short sentence at most/)
    assert.match(prompt, /at most 25 words/)
    assert.match(prompt, new RegExp(`under ${MAX_ANSWER_CHARS} characters`))
    assert.match(prompt, /Respond to their meaning, not their appearance/)
    assert.match(prompt, /Never critique letter shapes/)
  }
  assert.match(buildAskPrompt('', 'hint'), /Do not reveal the full solution/)
  assert.match(buildAskPrompt('', 'next'), /only the single next step/)
  assert.match(buildAskPrompt('', 'check'), /most important mistake/)
  assert.equal(buildAskPrompt(undefined, 'toString'), buildAskPrompt(''))
  assert.match(CANVAS_SYSTEM_PROMPT, /not a chat essay/)
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
  assert.match(buildAskPrompt('', 'check'), /not the handwriting/)
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
