import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, type Page } from 'playwright'
import { startServer } from '../server'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')

test('shared canvas: agent → drawing → capture → backup → restart', { timeout: 120000 }, async (t) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tldraw-ipad-test-'))
  let app = await startServer({ dataDir, port: 0, host: '127.0.0.1', production: true })
  const address = app.server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch()
  const cli = async (...args: string[]) => {
    const { stdout } = await exec(process.execPath, [resolve(root, 'scripts/cli.mjs'), '--url', base, ...args], { cwd: tmpdir() })
    return JSON.parse(stdout)
  }
  const status = () => fetch(`${base}/api/status`).then((r) => r.json())
  const records = async () => (await fetch(`${base}/api/snapshot`).then((r) => r.json())).documents.map((r: any) => r.state)
  const waitShape = (page: Page, id: string) => page.waitForFunction((id) => !!window.canvas.editor.getShape(id as any), id)
  try {
    await t.test('requires a visible user view for default captures', async () => {
      await assert.rejects(cli('capture'), /Open the canvas on your iPad/)
      const blank = await cli('capture', '--all', '--output', resolve(dataDir, 'blank.png'))
      const bytes = await readFile(blank.image)
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    })
    const human = await browser.newPage({ viewport: { width: 1024, height: 768 } })
    await human.goto(base)
    await human.waitForFunction(() => !!window.canvas)
    const second = await browser.newPage()
    await second.goto(`${base}/?agent=1`)
    await second.waitForFunction(() => !!window.canvas)

    await t.test('CLI adds editable shapes, updates stable IDs, and syncs to other clients', async () => {
      const result = await cli('draw', resolve(root, 'examples/diagram.json'))
      assert.equal(result.shapes.length, 3)
      await waitShape(human, 'shape:input')
      await waitShape(second, 'shape:agent')
      await writeFile(resolve(dataDir, 'update.json'), JSON.stringify([{ id: 'shape:input', type: 'geo', x: 140 }]))
      await cli('draw', resolve(dataDir, 'update.json'))
      await human.waitForFunction(() => window.canvas.editor.getShape('shape:input' as any)?.x === 140)
      assert.equal((await records()).filter((r: any) => r.typeName === 'shape').length, 3)
    })

    await t.test('canvas drawing, palette, and undo/redo work in the browser', async () => {
      await human.mouse.move(170, 370)
      await human.mouse.down()
      await human.mouse.move(210, 400, { steps: 5 })
      await human.mouse.move(285, 380, { steps: 5 })
      await human.mouse.up()
      await human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((s) => s.type === 'draw'))
      await human.getByRole('button', { name: 'Undo', exact: true }).click()
      await human.waitForFunction(() => !window.canvas.editor.getCurrentPageShapes().some((s) => s.type === 'draw'))
      await human.getByRole('button', { name: 'Redo', exact: true }).click()
      await human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((s) => s.type === 'draw'))
      await human.getByRole('button', { name: 'Drawing tools' }).click()
      assert.equal(await human.getByRole('button', { name: 'Eraser', exact: true }).isVisible(), true)
      await human.getByRole('button', { name: 'Drawing tools' }).click()
      assert.equal(await human.getByRole('button', { name: 'Eraser', exact: true }).count(), 0)
    })

    await t.test('captures the human viewport with shapes and ink, without controls', async () => {
      await human.evaluate(() => { window.canvas.editor.setCamera({ x: -80, y: -100, z: 1 }) })
      await human.waitForTimeout(600)
      const view = (await status()).view
      assert.equal(view.bounds.x, 80)
      assert.equal(view.bounds.y, 100)
      const result = await cli('capture', '--output', resolve(root, 'test-results/capture.png'))
      assert.deepEqual(result.bounds, view.bounds)
      const bytes = await readFile(result.image)
      assert.equal(bytes.readUInt32BE(16), 1024)
      assert.equal(bytes.readUInt32BE(20), 768)
      await mkdir(resolve(root, 'test-results'), { recursive: true })
      await human.screenshot({ path: resolve(root, 'test-results/canvas.png') })
      await human.getByRole('button', { name: 'Drawing tools' }).click()
      await human.screenshot({ path: resolve(root, 'test-results/palette.png') })
      await human.getByRole('button', { name: 'Drawing tools' }).click()
    })

    let backup: { backup: string; revision: number }
    let before: any[]
    await t.test('one finger pans, pinch zooms, and fine Pencil ink retains its width across clients', async () => {
      const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } })
      const touch = await context.newPage()
      await touch.goto(base)
      await touch.waitForFunction(() => !!window.canvas)
      assert.equal(await touch.evaluate(() => window.canvas.editor.getInstanceState().isPenMode), true)
      const count = await touch.evaluate(() => window.canvas.editor.getCurrentPageShapes().length)
      const cdp = await context.newCDPSession(touch)
      const camera = await touch.evaluate(() => window.canvas.editor.getCamera())
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 350, y: 500 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 450, y: 530 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      assert.equal(await touch.evaluate(() => window.canvas.editor.getCurrentPageShapes().length), count)
      const panned = await touch.evaluate(() => window.canvas.editor.getCamera())
      assert(Math.abs(panned.x - camera.x - 100 / camera.z) < 1)
      assert(Math.abs(panned.y - camera.y - 30 / camera.z) < 1)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 400 }, { x: 500, y: 400 }] })
      for (const distance of [240, 280, 320]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 400 - distance / 2, y: 400 }, { x: 400 + distance / 2, y: 400 }] })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await touch.waitForFunction((z) => window.canvas.editor.getCamera().z > z * 1.2, panned.z)
      await touch.evaluate(() => { window.canvas.editor.setCamera({ x: 0, y: 0, z: 1 }) })
      await touch.getByRole('button', { name: 'Drawing tools' }).click()
      await touch.getByRole('button', { name: 'Hairline', exact: true }).click()
      await touch.getByRole('slider', { name: 'Pen width' }).fill('0.1')
      await touch.getByRole('button', { name: 'Drawing tools' }).click()
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 350, y: 500, button: 'left', buttons: 1, pointerType: 'pen', force: .5 })
      const duringPen = await touch.evaluate(() => window.canvas.editor.getCamera())
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 650, y: 500 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 700, y: 550 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      assert.deepEqual(await touch.evaluate(() => window.canvas.editor.getCamera()), duringPen)
      for (const x of [380, 410, 450]) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 500, button: 'left', buttons: 1, pointerType: 'pen', force: .7 })
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 450, y: 500, button: 'left', buttons: 0, pointerType: 'pen', force: 0 })
      await touch.waitForFunction((count) => window.canvas.editor.getCurrentPageShapes().length === count + 1, count)
      const fine = JSON.parse(await touch.evaluate(() => JSON.stringify(window.canvas.editor.getCurrentPageShapes().find((s) => s.meta.penWidth === .1)!)))
      assert.equal((fine as any).props.scale, .05)
      await waitShape(second, fine.id)
      // Rasterize the SDK export at 10x: a 0.1-unit horizontal stroke is about
      // one pixel, including when exported by a separate agent client.
      const renderedWidth = async (page: Page) => page.evaluate(async (id) => {
        const result = await window.canvas.editor.getSvgString([id as any], { padding: 8, scale: 10, background: false })
        const image = new Image()
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result!.svg)}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        const pixels = ctx.getImageData(Math.floor(canvas.width / 2), 0, 1, canvas.height).data
        let rows = 0
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 100) rows++
        return rows
      }, fine.id)
      const rows = await renderedWidth(touch)
      assert(rows > 0 && rows <= 2, `Expected hairline ink, got ${rows} raster rows at 10x`)
      assert.equal(await renderedWidth(second), rows)
      await touch.reload()
      await touch.waitForFunction(() => !!window.canvas)
      await touch.getByRole('button', { name: 'Drawing tools' }).click()
      assert.equal(await touch.getByRole('slider', { name: 'Pen width' }).inputValue(), '0.1')
      await touch.getByRole('button', { name: 'Standard', exact: true }).click()
      assert.equal(await touch.getByRole('slider', { name: 'Pen width' }).count(), 0)
      assert.deepEqual(JSON.parse(await touch.evaluate((id) => JSON.stringify(window.canvas.editor.getShape(id as any)), fine.id)), fine)
      await context.close()
      await human.waitForTimeout(600)
    })
    await t.test('image placement and self-contained editable backups', async () => {
      const svg = resolve(dataDir, 'reference.svg')
      await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="orange"/></svg>')
      const image = await cli('put', svg, '--x', '600', '--y', '350')
      await waitShape(human, image.shapes[0])
      backup = await cli('backup', '--output', resolve(dataDir, 'board.tldr'))
      const file = JSON.parse(await readFile(backup.backup, 'utf8'))
      assert(file.records.some((r: any) => r.typeName === 'shape' && r.type === 'draw'))
      assert(file.records.some((r: any) => r.typeName === 'asset' && r.props.src.startsWith('data:image/')))
      before = await records()
    })

    await t.test('clear rejects stale revisions; backup restores editable content', async () => {
      await assert.rejects(cli('clear', '--if-revision', String(backup.revision - 1)), /Board changed/)
      const cleared = await cli('clear', '--if-revision', String(backup.revision))
      await human.waitForFunction(() => !window.canvas.editor.getCanUndo() && !window.canvas.editor.getCanRedo())
      assert.equal((await records()).filter((r: any) => r.typeName === 'shape').length, 0)
      await assert.rejects(cli('restore', backup.backup, '--if-revision', String(backup.revision)), /Board changed/)
      await cli('restore', backup.backup, '--if-revision', String(cleared.revision))
      const restored = await records()
      for (const prior of before.filter((r: any) => r.typeName === 'shape')) {
        assert.deepEqual(restored.find((r: any) => r.id === prior.id), prior)
      }
      await waitShape(human, 'shape:input')
      await assert.rejects(cli('clear', '--if-revision', String(cleared.revision)), /Board changed/)
    })

    await t.test('bad restore and cross-origin requests preserve the board', async () => {
      const before = await records()
      const result = await fetch(`${base}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: (await status()).revision, snapshot: { store: { broken: {} } } }) })
      assert.equal(result.status, 400)
      assert.deepEqual(await records(), before)
      const blocked = await fetch(`${base}/api/clear`, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' })
      assert.equal(blocked.status, 403)
    })

    await t.test('SQLite retains the board across server restarts', async () => {
      const before = await records()
      await browser.close()
      await app.close()
      app = await startServer({ dataDir, port: address.port, host: '127.0.0.1', production: true })
      assert.deepEqual(await records(), before)
      assert.equal((await status()).view, null)
      const result = await cli('capture', '--all', '--output', resolve(dataDir, 'restarted.png'))
      assert((await readFile(result.image)).length > 1000)
    })
  } finally {
    await browser.close()
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
