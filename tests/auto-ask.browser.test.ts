import { test as nodeTest, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import type { AskInput, AskRunner } from '../pi'
import { QUESTION_IDLE_MS } from '../src/question-mark'
import { createRun, createBrowserSession, type Run } from '../scripts/verification/session'

const root = resolve(import.meta.dirname, '..')
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function scripted(reply: string, held = false) {
  const calls: { input: AskInput; signal?: AbortSignal }[] = []
  let release = () => {}
  const gate = new Promise<void>((done) => { release = done })
  const runner: AskRunner = {
    async *run(input, signal) {
      calls.push({ input, signal })
      if (held) await Promise.race([gate, new Promise<void>((done) => signal?.addEventListener('abort', () => done(), { once: true }))])
      if (!signal?.aborted) yield reply
    },
  }
  return { runner, calls, release }
}

async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 8000
  while (!check() && Date.now() < deadline) await pause(25)
  assert(check(), message)
}

const runs = new WeakMap<TestContext, Run>()
function test(name: string, options: { timeout: number }, action: (t: TestContext) => Promise<void>) {
  return nodeTest(name, options, async (t) => {
    try { await action(t); const run = runs.get(t); if (run) run.report.status = 'passed' }
    catch (error) { const run = runs.get(t); if (run) { run.report.status = 'failed'; run.report.error = String(error).slice(0, 1200) }; throw error }
  })
}
async function fixture(t: TestContext, recognition = scripted('YES'), answer = scripted('2'), auto = true) {
  const run = await createRun(t.name, 'browser')
  runs.set(t, run)
  const session = await createBrowserSession(run, process.env.TLDRAW_VERIFY_DIST ?? resolve(root, 'dist'), { ask: answer.runner, questionMark: recognition.runner, asked: [], recognized: [] })
  t.after(async () => { await session.close(); run.report.finishedAt = new Date().toISOString(); await run.save() })
  await session.human.reload()
  await session.human.waitForFunction(() => !!window.canvas)
  await session.human.evaluate(() => window.canvas.editor.setCamera({ x: 0, y: 0, z: 1 }))
  return { ...session, page: session.human, base: session.url, recognition, answer }
}

async function drawQuestion(page: Page, offsetY = 0) {
  await page.mouse.move(350, 220 + offsetY)
  await page.mouse.down()
  for (const [x, y] of [[365, 205], [385, 207], [399, 221], [399, 239], [388, 252], [375, 263], [375, 278]]) {
    await page.mouse.move(x, y + offsetY, { steps: 2 })
  }
  await page.mouse.up()
  await page.mouse.move(375, 295 + offsetY)
  await page.mouse.down()
  await page.mouse.move(376, 296 + offsetY)
  await page.mouse.up()
  await page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw' && shape.props.isComplete).length >= 2)
}

const ink = (page: Page) => page.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes()
  .filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id))))
const answers = (page: Page) => page.evaluate(() => window.canvas.editor.getCurrentPageShapes()
  .filter((shape) => shape.meta.agentAnswer).map((shape) => window.canvas.editor.getShapeUtil(shape).getText(shape)))

test('Pencil lift answers with a resting palm and only new writing interrupts it', { timeout: 30000 }, async (t) => {
  const answer = scripted('2', true)
  const session = await fixture(t, scripted('YES'), answer)
  await session.page.evaluate(() => window.canvas.editor.updateInstanceState({ isPenMode: true }))
  const canvas = session.page.locator('.tl-canvas')
  await canvas.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 42, clientX: 650, clientY: 500, button: 0, buttons: 1 })
  const cdp = await session.page.context().newCDPSession(session.page)
  for (const points of [
    [[350, 220], [365, 205], [385, 207], [399, 221], [399, 239], [388, 252], [375, 263], [375, 278]],
    [[375, 295], [376, 296]],
  ]) {
    for (const [index, [x, y]] of points.entries()) {
      await cdp.send('Input.dispatchMouseEvent', { type: index === 0 ? 'mousePressed' : 'mouseMoved',
        x, y, button: 'left', buttons: 1, pointerType: 'pen', force: .5 })
    }
    const [x, y] = points.at(-1)!
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, pointerType: 'pen', force: 0 })
  }
  await session.page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw' && shape.props.isComplete).length === 2)
  const original = await ink(session.page)
  await eventually(() => answer.calls.length === 1, 'Pencil lift must answer while the palm remains down')
  await canvas.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 43, clientX: 700, clientY: 500, button: 0, buttons: 1 })
  await canvas.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 43, clientX: 720, clientY: 500, button: 0, buttons: 1 })
  await canvas.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 43, clientX: 720, clientY: 500, button: 0, buttons: 0 })
  await pause(200)
  assert.equal(answer.calls[0].signal?.aborted, false, 'palm contact must not cancel an answer')
  assert.equal(await ink(session.page), original)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 650, y: 400, button: 'left', buttons: 1, pointerType: 'pen', force: .5 })
  await eventually(() => !!answer.calls[0].signal?.aborted, 'new Pencil writing must cancel the answer')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 650, y: 400, button: 'left', buttons: 0, pointerType: 'pen', force: 0 })
  await eventually(() => answer.calls.length === 2, 'the intact marker must retry after the next Pencil lift')
  answer.release()
  await session.page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer))
  assert.deepEqual(await answers(session.page), ['2'])
})

test('pending question ink survives a drawing pause longer than fifteen seconds', { timeout: 20000 }, async (t) => {
  const session = await fixture(t, scripted('NO'))
  const start = Date.now()
  await session.page.clock.setFixedTime(start)
  await drawQuestion(session.page)
  await session.page.mouse.move(650, 400)
  await session.page.mouse.down()
  await session.page.clock.setFixedTime(start + 16000)
  await session.page.mouse.up()
  await eventually(() => session.recognition.calls.length === 1, 'an intact pending marker must not expire while writing continues')
  assert.equal(session.answer.calls.length, 0)
})

test('a fast hook plus dot is recognized, replaced once, and exact ink returns with undo', { timeout: 30000 }, async (t) => {
  const answer = scripted('2', true)
  const session = await fixture(t, scripted('YES'), answer)
  await drawQuestion(session.page)
  const original = await ink(session.page)
  await eventually(() => answer.calls.length === 1, 'local question should reach the answer runner')
  assert.equal(await ink(session.page), original, 'ink stays intact until the complete answer arrives')
  assert.equal(session.recognition.calls[0].input.image?.mimeType, 'image/png')
  assert.equal(answer.calls[0].input.image?.mimeType, 'image/png')
  answer.release()
  await session.page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer))
  assert.deepEqual(await answers(session.page), ['2'])
  assert.equal(await ink(session.page), '[]')
  await session.page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await ink(session.page), original)
  assert.deepEqual(await answers(session.page), [])
  await session.page.getByRole('button', { name: 'Redo', exact: true }).click()
  assert.deepEqual(await answers(session.page), ['2'])
  assert.equal(await ink(session.page), '[]')
  await pause(QUESTION_IDLE_MS + 200)
  assert.equal(session.recognition.calls.length, 1, 'undo and redo must not trigger another recognition')
  assert.equal(answer.calls.length, 1)
})

test('nearby long answers do not overlap and one undo restores only the new marker', { timeout: 25000 }, async (t) => {
  const text = 'A monad lets you compose computations while preserving a shared context such as missing values, state, or asynchronous results. '.repeat(4)
  const session = await fixture(t, scripted('YES'), scripted(text))
  await drawQuestion(session.page)
  await session.page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer))
  const originalAnswer = await session.page.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes().find((shape) => shape.meta.agentAnswer)))
  await drawQuestion(session.page, 220)
  const marker = await ink(session.page)
  await session.page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer).length === 2)
  const bounds = await session.page.evaluate(() => {
    const editor = window.canvas.editor
    return editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer)
      .map((shape) => { const b = editor.getShapePageBounds(shape)!; return { x: b.x, y: b.y, w: b.w, h: b.h } })
      .sort((a, b) => a.y - b.y)
  })
  assert(bounds[0].h > 220, 'the first answer must be tall enough to collide with the second marker position')
  assert.equal(bounds[0].x, bounds[1].x, 'collision handling preserves the marker horizontal position')
  assert(bounds[1].y >= bounds[0].y + bounds[0].h + 10, 'new answer must clear the existing answer with a gap')
  assert.equal(await ink(session.page), '[]')
  await session.page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await ink(session.page), marker, 'one undo restores the exact new marker')
  assert.deepEqual(await session.page.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer).map((shape) => JSON.stringify(shape))), [originalAnswer],
    'one undo removes only the new answer and preserves the first answer unchanged')
})

test('a long answer clears handwriting below its marker without moving that ink', { timeout: 20000 }, async (t) => {
  const text = 'A monad lets you compose computations while preserving a shared context such as missing values, state, or asynchronous results. '.repeat(4)
  const session = await fixture(t, scripted('YES'), scripted(text))
  await session.page.mouse.move(330, 350)
  await session.page.mouse.down()
  await session.page.mouse.move(710, 350, { steps: 10 })
  await session.page.mouse.up()
  const originalInk = await ink(session.page)
  await drawQuestion(session.page)
  const markerAndInk = await ink(session.page)
  await session.page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer))
  const bounds = await session.page.evaluate(() => {
    const editor = window.canvas.editor
    const answer = editor.getCurrentPageShapes().find((shape) => shape.meta.agentAnswer)!
    const stroke = editor.getCurrentPageShapes().find((shape) => shape.type === 'draw')!
    return { answerY: editor.getShapePageBounds(answer)!.y, inkBottom: editor.getShapePageBounds(stroke)!.maxY }
  })
  assert(bounds.answerY >= bounds.inkBottom + 10, 'the answer must clear the handwriting beneath its marker')
  assert.equal(await ink(session.page), originalInk, 'existing handwriting remains unchanged')
  await session.page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await ink(session.page), markerAndInk, 'one undo restores the marker with the other ink untouched')
  assert.deepEqual(await answers(session.page), [])
})

test('a NO recognition preserves all ink and never asks for an answer', { timeout: 20000 }, async (t) => {
  const session = await fixture(t, scripted('NO'))
  await drawQuestion(session.page)
  const original = await ink(session.page)
  await eventually(() => session.recognition.calls.length === 1, 'question should be checked')
  await pause(200)
  assert.equal(await ink(session.page), original)
  assert.deepEqual(await answers(session.page), [])
  assert.equal(session.answer.calls.length, 0)
})

test('blur during recognition preserves ink and suppresses immediate retry', { timeout: 20000 }, async (t) => {
  const recognition = scripted('YES', true)
  const session = await fixture(t, recognition)
  await drawQuestion(session.page)
  const original = await ink(session.page)
  await eventually(() => recognition.calls.length === 1, 'recognition should start')
  await session.page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await eventually(() => !!recognition.calls[0].signal?.aborted, 'blur must abort recognition')
  recognition.release()
  await pause(QUESTION_IDLE_MS + 200)
  assert.equal(await ink(session.page), original)
  assert.deepEqual(await answers(session.page), [])
  assert.equal(recognition.calls.length, 1)
  assert.equal(session.answer.calls.length, 0)
})

test('new local input interrupts an answer without erasing its question marker', { timeout: 20000 }, async (t) => {
  const answer = scripted('2', true)
  const session = await fixture(t, scripted('YES'), answer)
  await drawQuestion(session.page)
  const original = JSON.parse(await ink(session.page))
  await eventually(() => answer.calls.length === 1, 'answer should start')
  await session.page.mouse.move(650, 400)
  await session.page.mouse.down()
  await session.page.mouse.move(700, 400, { steps: 5 })
  await session.page.mouse.up()
  await eventually(() => !!answer.calls[0].signal?.aborted, 'new input must abort the active answer')
  answer.release()
  const current = JSON.parse(await ink(session.page))
  for (const shape of original) assert.deepEqual(current.find((item: { id: string }) => item.id === shape.id), shape)
  assert.equal(current.length, original.length + 1)
  assert.deepEqual(await answers(session.page), [])
})

test('candidate changes while answering preserve the changed ink', { timeout: 20000 }, async (t) => {
  const answer = scripted('2', true)
  const session = await fixture(t, scripted('YES'), answer)
  await drawQuestion(session.page)
  await eventually(() => answer.calls.length === 1, 'answer should start')
  await session.page.evaluate(() => {
    const shape = window.canvas.editor.getCurrentPageShapes().find((shape) => shape.type === 'draw')
    if (!shape) throw new Error('missing marker ink')
    window.canvas.editor.updateShapes([{ id: shape.id, type: shape.type, x: shape.x + 10 }])
  })
  const changed = await ink(session.page)
  answer.release()
  await pause(200)
  assert.equal(await ink(session.page), changed)
  assert.deepEqual(await answers(session.page), [])
})

test('remote sync and CLI question-shaped ink never trigger recognition', { timeout: 25000 }, async (t) => {
  const session = await fixture(t, scripted('YES'), scripted('2'), false)
  const remote = await session.browser.newPage()
  await remote.goto(`${session.base}/?agent=1`)
  await remote.waitForFunction(() => !!window.canvas)
  await remote.evaluate(() => { window.canvas.editor.setCamera({ x: 0, y: 0, z: 1 }) })
  await drawQuestion(remote)
  const shapes = await remote.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw'))
  const remoteInk = shapes.map((shape, index) => ({ id: `shape:remote-${index}`, type: shape.type,
    x: shape.x + 200, y: shape.y, props: shape.props }))
  await remote.evaluate((json) => { window.canvas.draw(JSON.parse(json)) }, JSON.stringify(remoteInk))
  const input = resolve(session.dataDir, 'question.json')
  await writeFile(input, JSON.stringify(shapes.map((shape, index) => ({ ...shape, id: `shape:cli-${index}`, x: shape.x + 400 }))))
  await session.cli('draw', input)
  await session.page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw').length === 6)
  await pause(QUESTION_IDLE_MS + 400)
  assert.equal(session.recognition.calls.length, 0)
  assert.equal(session.answer.calls.length, 0)
  assert.deepEqual(await answers(session.page), [])
})
