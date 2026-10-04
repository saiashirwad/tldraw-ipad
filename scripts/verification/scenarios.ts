import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { until, type BrowserSession, type Run } from './session'

type Scenario = (session: BrowserSession, run: Run) => Promise<void>
const seed = [{ id: 'shape:verification', type: 'geo', x: 100, y: 100, text: 'Verification',
  props: { geo: 'rectangle', w: 200, h: 120, color: 'green', fill: 'solid' } }]

async function drawSeed(session: BrowserSession, run: Run) {
  const file = resolve(run.dir, 'shapes.json')
  await writeFile(file, JSON.stringify(seed))
  await session.cli('draw', file)
  await session.human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.id === 'shape:verification'))
}

export const scenarios: Record<string, Scenario> = {
  async sync(session, run) {
    await run.check('LAN clients mount without secure-context randomUUID', async () => {
      const previous = (await session.status()).clientViews.at(-1)?.client?.loadId
      await session.human.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }))
      await session.human.reload()
      await session.human.waitForFunction(() => !!window.canvas)
      await until(session.status, (status) => status.clientViews.some((view) => view.client?.synced &&
        view.client.sessionId === run.report.runId && view.client.loadId !== previous), 'LAN-style document did not mount')
    })
    await run.check('CLI drawing reaches the human editor', () => drawSeed(session, run))
    await run.check('Stable IDs update without duplication', async () => {
      const file = resolve(run.dir, 'update.json')
      await writeFile(file, JSON.stringify([{ ...seed[0], text: 'Updated' }]))
      await session.cli('draw', file)
      await session.human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((s) =>
        window.canvas.editor.getShapeUtil(s).getText(s) === 'Updated'))
      assert.equal(await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().length), 1)
    })
    await run.check('Opening an agent preserves revision and human camera', async () => {
      const before = await session.status()
      const camera = await session.human.evaluate(() => window.canvas.editor.getCamera())
      const page = await session.context.newPage()
      await page.goto(`${session.url}/?agent=1`)
      await page.waitForFunction(() => !!window.canvas)
      assert.equal((await session.status()).revision, before.revision)
      assert.deepEqual(await session.human.evaluate(() => window.canvas.editor.getCamera()), camera)
      assert.equal(await page.getByRole('button', { name: 'Ask pi', exact: true }).count(), 0)
      await page.close()
    })
    await run.check('Human input supports undo and redo', async () => {
      const count = await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().length)
      await session.human.mouse.move(400, 300)
      await session.human.mouse.down()
      await session.human.mouse.move(450, 330, { steps: 4 })
      await session.human.mouse.up()
      await session.human.waitForFunction((n) => window.canvas.editor.getCurrentPageShapes().length === n + 1, count)
      await session.human.getByRole('button', { name: 'Undo', exact: true }).click()
      assert.equal(await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().length), count)
      await session.human.getByRole('button', { name: 'Redo', exact: true }).click()
      assert.equal(await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().length), count + 1)
    })
  },
  async capture(session, run) {
    await drawSeed(session, run)
    await session.human.evaluate(() => window.canvas.editor.setCamera({ x: 0, y: 0, z: 1 }))
    await until(session.status, (status) => status.view?.bounds.x === 0 && status.view.bounds.y === 0, 'Viewport did not settle')
    await run.check('Capture contains the expected shape and canvas bounds', async () => {
      const result = await session.cli<{ image: string; bounds: { x: number; y: number; w: number; h: number } }>(
        'capture', '--output', resolve(run.dir, 'capture.png'))
      run.report.artifacts.capture = result.image
      assert.equal(result.bounds.x, 0)
      const bytes = await readFile(result.image)
      assert.equal(bytes.readUInt32BE(16), 1024)
      assert.equal(bytes.readUInt32BE(20), 768)
      const pixels = await session.human.evaluate(async (url) => {
        const image = new Image(); image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
        return { shape: [...context.getImageData(140, 140, 1, 1).data], corner: [...context.getImageData(20, 740, 1, 1).data] }
      }, `data:image/png;base64,${bytes.toString('base64')}`)
      assert(pixels.shape[1] > pixels.shape[0], `Expected green shape pixels, got ${pixels.shape}`)
      assert(pixels.corner.slice(0, 3).every((n) => n > 230), `Canvas export contains unexpected corner controls ${pixels.corner}`)
    })
    await run.check('Stale viewport capture is rejected', async () => {
      await session.human.route('**/api/status', async (route) => {
        const status = await session.status()
        await route.fulfill({ json: { ...status, view: status.view ? { ...status.view, updatedAt: Date.now() - 16000 } : null } })
      })
      const error = await session.human.evaluate(async () => {
        try { await window.canvas.capture(false); return null } catch (error) { return String(error) }
      })
      assert.match(error ?? '', /stale/)
      await session.human.unroute('**/api/status')
    })
    await run.check('Fresh native viewport takes priority over browser reports', async () => {
      const view = (await session.status()).view!
      const publish = (source: string, x: number) => fetch(`${session.url}/api/view`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: view.pageId, bounds: { ...view.bounds, x }, source }) })
      assert.equal((await publish('ipad', 123)).status, 200)
      assert.equal((await publish('browser', 456)).status, 200)
      const after = (await session.status()).view!
      assert.equal(after.source, 'ipad'); assert.equal(after.bounds.x, 123)
    })
  },
  async restore(session, run) {
    await drawSeed(session, run)
    const backup = await session.backup()
    await run.check('Stale clear preserves the board', async () => {
      await assert.rejects(session.cli('clear', '--if-revision', String(backup.revision - 1)), /Board changed/)
      assert((await session.snapshot()).documents.some((r: { state: { id: string } }) => r.state.id === 'shape:verification'))
    })
    await run.check('Clear and restore retain editable content', async () => {
      const cleared = await session.cli<{ revision: number }>('clear', '--if-revision', String(backup.revision))
      await session.cli('restore', backup.backup, '--if-revision', String(cleared.revision))
      await session.human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.id === 'shape:verification'))
    })
    await run.check('Malformed restore cannot mutate the board', async () => {
      const before = await session.snapshot()
      const response = await fetch(`${session.url}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: (await session.status()).revision, snapshot: { store: { invalid: {} } } }) })
      assert.equal(response.status, 400); assert.deepEqual(await session.snapshot(), before)
    })
  },
  async ask(session, run) {
    await drawSeed(session, run)
    await run.check('Scripted answer streams into one editable shape', async () => {
      await session.human.getByRole('button', { name: 'Ask pi', exact: true }).click()
      await session.human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((s) => s.meta.agentAnswer &&
        window.canvas.editor.getShapeUtil(s).getText(s) === 'A short answer.'))
      assert.equal(session.models.asked.length, 1)
      assert(session.models.asked[0].image?.data.startsWith('iVBOR'))
    })
    await run.check('One undo removes the answer and preserves the drawing', async () => {
      await session.human.getByRole('button', { name: 'Undo', exact: true }).click()
      assert.equal(await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((s) => s.meta.agentAnswer).length), 0)
      assert.equal(await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().some((shape) => shape.id === 'shape:verification')), true)
      await session.human.getByRole('button', { name: 'Redo', exact: true }).click()
      assert.equal(await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((s) => s.meta.agentAnswer).length), 1)
    })
  },
}
