import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import { createRun, createBrowserSession } from '../scripts/verification/session'

test('standalone Pi Durable answers without Mac APIs and persists ink, transcript, and undo', { timeout: 60000 }, async (t) => {
  const run = await createRun(t.name, 'browser')
  const session = await createBrowserSession(run, process.env.TLDRAW_VERIFY_DIST ?? resolve('dist'))
  const files = resolve(run.dir, 'native-files')
  await mkdir(files)
  const stale = await Harness.open(await openNodeJsonlStorage(resolve(files, 'answers'), BACKGROUND_CONTEXT),
    { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT)
  await stale.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'deepseek', modelId: 'deepseek-flash' }, tools: [],
    instructions: 'STALE_CANVAS_INSTRUCTIONS: answer every question with one word.' } })
  await stale.close(BACKGROUND_CONTEXT)
  const page = await session.context.newPage()
  t.after(async () => { await session.close(); run.report.finishedAt = new Date().toISOString(); await run.save() })
  const apiRequests: string[] = []
  page.on('request', (request) => { if (/\/api\/|\/sync/.test(request.url())) apiRequests.push(request.url()) })
  const requests: { body: string; cancelled: boolean; id: string }[] = []
  let held: 'answer' | 'all' | null = 'answer'
  let release = () => {}
  let gate = new Promise<void>((done) => { release = done })
  await page.exposeBinding('nativeRequest', async (_source, input: { op: string; path?: string; to?: string; text?: string; size?: number; id?: string; body?: string }) => {
    const path = resolve(files, input.path ?? '.')
    assert(path === files || path.startsWith(`${files}/`))
    switch (input.op) {
      case 'file.read': try { return await readFile(path, 'utf8') } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error }
      case 'file.readBytes': try { return (await readFile(path)).toString('base64') } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error }
      case 'file.mkdir': await mkdir(path, { recursive: true }); return null
      case 'file.list': return readdir(path)
      case 'file.write': await writeFile(path, input.text ?? ''); return null
      case 'file.append': await appendFile(path, input.text ?? ''); return null
      case 'file.flush': return null
      case 'file.truncate': await truncate(path, input.size); return null
      case 'file.rename': await rename(path, resolve(files, input.to ?? '')); return null
      case 'file.remove': await rm(path, { force: true }); return null
      case 'provider.cancel': {
        const request = requests.find((request) => request.id === input.id)
        if (request) request.cancelled = true
        release()
        return null
      }
      case 'provider.fetch': {
        const request = { body: input.body ?? '', cancelled: false, id: input.id ?? '' }
        requests.push(request)
        const recognition = request.body.includes('isolated handwritten glyph')
        if (held === 'all' || (held === 'answer' && !recognition)) await gate
        if (request.cancelled) throw new Error('Cancelled')
        const text = recognition ? 'YES' : JSON.stringify({ question: 'What is 1 + 1?', answer: '2' })
        return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body:
          `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n` }
      }
      default: throw new Error(`Unexpected native operation ${input.op}`)
    }
  })
  await page.addInitScript({ content: `
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkit', { value: { messageHandlers: { canvasNative: {
      postMessage: (input) => window.nativeRequest(input)
    } } } });
  ` })
  try {
    await page.goto(session.url)
    await page.waitForFunction(() => !!window.canvas)
    await page.evaluate(() => { window.canvas.editor.setCamera({ x: 0, y: 0, z: 1 }) })
    assert.equal(await page.getByRole('button', { name: 'Ask pi' }).count(), 0)
    const drawQuestion = async (offset = 0) => {
      await page.mouse.move(350 + offset, 220)
      await page.mouse.down()
      for (const [x, y] of [[365, 205], [385, 207], [399, 221], [399, 239], [388, 252], [375, 263], [375, 278]]) await page.mouse.move(x + offset, y, { steps: 2 })
      await page.mouse.up()
      await page.mouse.move(375 + offset, 295)
      await page.mouse.down()
      await page.mouse.move(376 + offset, 296)
      await page.mouse.up()
    }
    await drawQuestion()
    const ink = await page.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id))))
    const answerDeadline = Date.now() + 8000
    while (requests.length < 2 && Date.now() < answerDeadline) await new Promise((done) => setTimeout(done, 25))
    assert.equal(requests.length, 2)
    assert(!requests[1].body.includes('STALE_CANVAS_INSTRUCTIONS'), 'reopening must update persisted agent instructions')
    assert(requests[1].body.includes('at most 60 words'))
    assert.equal(await page.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id)))), ink,
      'adding a target box to the model image must not change marker ink')
    const payload: { messages: { role: string; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }[] } = JSON.parse(requests[1].body)
    assert(requests[1].body.includes(`Current UTC date: ${new Date().toISOString().slice(0, 10)}`))
    const image = payload.messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content)
      .find((part) => part.type === 'image_url')
    assert(image?.type === 'image_url')
    const redBox = await page.evaluate(async (url) => {
      const image = new Image(); image.src = url; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      const red = []
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const index = (y * canvas.width + x) * 4
        if (data[index] > 180 && data[index + 1] < 80 && data[index + 2] < 80) red.push({ x, y })
      }
      return red.length ? { left: Math.min(...red.map((p) => p.x)), right: Math.max(...red.map((p) => p.x)),
        top: Math.min(...red.map((p) => p.y)), bottom: Math.max(...red.map((p) => p.y)) } : null
    }, image.image_url.url)
    assert(redBox && redBox.left < 350 && redBox.right > 399 && redBox.top < 205 && redBox.bottom > 296,
      'the model image must visibly box the target question mark')
    held = null
    release()
    await page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer))
    const answerSize = await page.evaluate(() => {
      const editor = window.canvas.editor
      const shape = editor.getCurrentPageShapes().find((shape) => shape.meta.agentAnswer)
      if (shape?.type !== 'text') throw new Error('Missing text answer')
      return { font: 18 * shape.props.scale * editor.getZoomLevel(), width: editor.getShapePageBounds(shape)!.w * editor.getZoomLevel() }
    })
    assert.equal(answerSize.font, 20)
    assert(Math.abs(answerSize.width - 320) < 1, 'answer uses a readable 320-pixel text column')
    assert.equal(requests.length, 2)
    assert(requests.every((request) => request.body.includes('data:image/png;base64,')))
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    assert.equal(await page.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id)))), ink)
    await page.waitForTimeout(300)
    await page.reload()
    await page.waitForFunction(() => !!window.canvas)
    assert.equal(await page.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer).length), 0)
    assert.equal(await page.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id)))), ink)
    const firstJournal = await readFile(resolve(files, 'answers/main.jsonl'), 'utf8')
    assert(firstJournal.includes('pi.assistant'))
    assert.equal(requests.length, 2, 'reopening an applied and undone attempt cannot resurrect or ask again')
    await drawQuestion(240)
    await page.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer))
    assert.equal(requests.length, 4)
    const secondPayload: typeof payload = JSON.parse(requests[3].body)
    assert.equal(secondPayload.messages.filter((message) => message.role === 'user').length, 1, 'only the current question reaches the provider')
    assert.equal(secondPayload.messages.filter((message) => message.role === 'assistant').length, 0, 'old answers stay out of model context')
    assert.equal(secondPayload.messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content)
      .filter((part) => part.type === 'image_url').length, 1, 'only the current screenshot reaches the provider')
    assert((await readFile(resolve(files, 'answers/main.jsonl'), 'utf8')).startsWith(firstJournal), 'reset preserves the existing journal')
    held = 'all'
    gate = new Promise<void>((done) => { release = done })
    await drawQuestion(480)
    await page.waitForFunction(() => false, undefined, { timeout: 1200 }).catch(() => {})
    const deadline = Date.now() + 5000
    while (requests.length < 5 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
    assert.equal(requests.length, 5)
    await page.mouse.move(800, 500); await page.mouse.down(); await page.mouse.move(850, 500); await page.mouse.up()
    const cancelledDeadline = Date.now() + 5000
    while (!requests[4].cancelled && Date.now() < cancelledDeadline) await new Promise((done) => setTimeout(done, 25))
    assert(requests[4].cancelled, 'new input cancels the native provider request')
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer).length), 1)
    assert.deepEqual(apiRequests, [])
    run.report.status = 'passed'
  } catch (error) {
    run.report.status = 'failed'; run.report.error = String(error)
    await page.screenshot({ path: resolve(run.dir, 'standalone-failure.png') })
    throw error
  } finally { release() }
})
