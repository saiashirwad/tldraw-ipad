import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, type Page } from 'playwright'
import { startServer } from '../server'
import type { AskInput, AskRunner } from '../pi'
import { QUESTION_IDLE_MS } from '../src/question-mark'

const exec = promisify(execFile)
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

async function fixture(t: TestContext, recognition = scripted('YES'), answer = scripted('2'), auto = true) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tldraw-auto-ask-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const app = await startServer({ dataDir, port: 0, host: '127.0.0.1', production: true,
    ask: answer.runner, questionMark: recognition.runner })
  t.after(() => app.close())
  const address = app.server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.addInitScript((enabled) => localStorage.setItem('canvas-auto-ask', enabled ? 'on' : 'off'), auto)
  await page.goto(base)
  await page.waitForFunction(() => !!window.canvas)
  await page.evaluate(() => window.canvas.editor.setCamera({ x: 0, y: 0, z: 1 }))
  const cli = (...args: string[]) => exec(process.execPath, [resolve(root, 'scripts/cli.mjs'), '--url', base, ...args], { cwd: dataDir })
  return { page, browser, base, dataDir, recognition, answer, cli }
}

async function drawQuestion(page: Page) {
  await page.mouse.move(350, 220)
  await page.mouse.down()
  for (const [x, y] of [[365, 205], [385, 207], [399, 221], [399, 239], [388, 252], [375, 263], [375, 278]]) {
    await page.mouse.move(x, y, { steps: 2 })
  }
  await page.mouse.up()
  await page.mouse.move(375, 295)
  await page.mouse.down()
  await page.mouse.move(376, 296)
  await page.mouse.up()
  await page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw' && shape.props.isComplete).length >= 2)
}

const ink = (page: Page) => page.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes()
  .filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id))))
const answers = (page: Page) => page.evaluate(() => window.canvas.editor.getCurrentPageShapes()
  .filter((shape) => shape.meta.agentAnswer).map((shape) => window.canvas.editor.getShapeUtil(shape).getText(shape)))

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

test('a NO recognition preserves all ink and never asks for an answer', { timeout: 20000 }, async (t) => {
  const session = await fixture(t, scripted('NO'))
  await drawQuestion(session.page)
  const original = await ink(session.page)
  await eventually(() => session.recognition.calls.length === 1, 'question should be checked')
  await session.page.getByRole('button', { name: 'Ask pi', exact: true }).waitFor()
  assert.equal(await ink(session.page), original)
  assert.deepEqual(await answers(session.page), [])
  assert.equal(session.answer.calls.length, 0)
})

test('Stop during recognition preserves ink and suppresses immediate retry', { timeout: 20000 }, async (t) => {
  const recognition = scripted('YES', true)
  const session = await fixture(t, recognition)
  await drawQuestion(session.page)
  const original = await ink(session.page)
  await eventually(() => recognition.calls.length === 1, 'recognition should start')
  await session.page.getByRole('button', { name: 'Stop pi' }).click()
  await eventually(() => !!recognition.calls[0].signal?.aborted, 'Stop must abort recognition')
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
  await session.page.getByRole('button', { name: 'Ask pi', exact: true }).waitFor()
  assert.equal(await ink(session.page), changed)
  assert.deepEqual(await answers(session.page), [])
})

test('remote sync and CLI question-shaped ink never trigger recognition', { timeout: 25000 }, async (t) => {
  const session = await fixture(t, scripted('YES'), scripted('2'), false)
  await drawQuestion(session.page)
  const shapes = await session.page.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw'))
  await session.page.getByRole('button', { name: 'Attach a question' }).click()
  await session.page.getByRole('checkbox', { name: 'Answer handwritten ? after a pause' }).check()
  const remote = await session.browser.newPage()
  await remote.goto(`${session.base}/?agent=1`)
  await remote.waitForFunction(() => !!window.canvas)
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
