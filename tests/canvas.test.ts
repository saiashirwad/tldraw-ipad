import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, type Page } from 'playwright'
import { startServer } from '../server'
import type { AskInput, AskRunner } from '../pi'
import { buildAskPrompt, MAX_ANSWER_CHARS } from '../src/ask-prompts'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Scripted stand-in for pi: the same streaming contract without a provider call. */
function scriptedAgent() {
  const asked: AskInput[] = []
  const runner: AskRunner = {
    async *run(input: AskInput, signal?: AbortSignal) {
      asked.push(input)
      const deltas = input.prompt.includes('slow')
        ? Array.from({ length: 80 }, (_, index) => `${index} `)
        : input.prompt.includes('verbose') ? Array(10).fill('An unnecessarily long explanation. '.repeat(5))
          : ['The drawing shows ', 'a happy cat. ']
      for (const delta of deltas) {
        if (deltas.length > 2) await wait(30)
        if (signal?.aborted) return
        yield delta
      }
    },
  }
  return { asked, runner }
}

test('shared canvas: agent → drawing → capture → backup → restart', { timeout: 120000 }, async (t) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tldraw-ipad-test-'))
  const { asked, runner } = scriptedAgent()
  let app = await startServer({ dataDir, port: 0, host: '127.0.0.1', production: true, ask: runner })
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

    await t.test('Ask pi puts a small editable answer beside the ink without moving a camera that already fits', async () => {
      assert.equal(await second.getByRole('button', { name: 'Ask pi' }).count(), 0)
      const camera = await human.evaluate(() => window.canvas.editor.getCamera())
      await human.getByRole('button', { name: 'Ask pi' }).click()
      const answered = () => human.waitForFunction(() => {
        const shape = window.canvas.editor.getCurrentPageShapes().find((option) => option.meta?.agentAnswer)
        return !!shape && JSON.stringify((shape.props as { richText?: unknown }).richText).includes('happy cat')
      })
      await answered()
      await human.waitForFunction(() => {
        const shape = window.canvas.editor.getCurrentPageShapes().find((option) => option.meta?.agentAnswer)
        const answer = shape && window.canvas.editor.getShapePageBounds(shape.id)
        return !!answer && window.canvas.editor.getViewportPageBounds().includes(answer)
      })
      const answer: any = await human.evaluate(() => JSON.parse(JSON.stringify(
        window.canvas.editor.getCurrentPageShapes().find((option) => option.meta?.agentAnswer))))
      assert.equal(answer.type, 'text')
      assert.equal(answer.props.autoSize, false)
      assert.equal(answer.props.size, 's')
      const ink: any = await human.evaluate(() => {
        const shape = window.canvas.editor.getCurrentPageShapes().find((s) => s.type === 'draw')!
        return window.canvas.editor.getShapePageBounds(shape)
      })
      assert(Math.abs(answer.x - ink.x - ink.w - 24) < 1, 'expected the reply just to the right of the handwriting')
      assert(Math.abs(answer.y - ink.y) < 1, 'expected alignment with the handwriting, not the viewport bottom')
      assert.deepEqual(await human.evaluate(() => window.canvas.editor.getCamera()), camera)
      assert.equal(asked.length, 1)
      assert.equal(asked[0].image?.mimeType, 'image/png')
      assert(asked[0].image?.data.startsWith('iVBOR'), 'expected a PNG screenshot of the canvas')
      assert.equal(asked[0].prompt, buildAskPrompt(''))
      await human.screenshot({ path: resolve(root, 'test-results/ask-near-ink.png') })
      await human.getByRole('button', { name: 'Undo', exact: true }).click()
      assert.equal(await human.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((s) => s.meta.agentAnswer).length), 0)
      assert.equal(await human.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((s) => s.type === 'draw').length), 1)
      await human.getByRole('button', { name: 'Redo', exact: true }).click()
      await answered()
    })

    await t.test('custom prompts keep typed questions brief and avoid covering previous replies', async () => {
      await human.getByRole('button', { name: 'Attach a question' }).click()
      await human.getByRole('combobox', { name: 'Reply style' }).selectOption('hint')
      await human.getByRole('textbox', { name: 'Question for pi' }).fill('What colour is it?')
      await human.getByRole('button', { name: 'Ask pi' }).click()
      await human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes()
        .filter((shape) => shape.meta?.agentAnswer).length === 2)
      await human.getByRole('button', { name: 'Ask pi' }).waitFor()
      assert.equal(asked[1].prompt, buildAskPrompt('What colour is it?', 'hint'))
      const answers: any[] = await human.evaluate(() => JSON.parse(JSON.stringify(
        window.canvas.editor.getCurrentPageShapes().filter((shape) => shape.meta?.agentAnswer))))
      const overlap = await human.evaluate(() => {
        const replies = window.canvas.editor.getCurrentPageShapes().filter((s) => s.meta.agentAnswer)
        const a = window.canvas.editor.getShapePageBounds(replies[0])!
        const b = window.canvas.editor.getShapePageBounds(replies[1])!
        return a.collides(b)
      })
      assert.equal(overlap, false, 'replies must not cover each other')
      assert(answers[1].y < 768, 'a follow-up should stay near the drawing')
    })

    await t.test('Stop ends the stream and keeps the partial answer', async () => {
      await human.getByRole('textbox', { name: 'Question for pi' }).fill('slow')
      await human.getByRole('button', { name: 'Ask pi' }).click()
      await human.getByRole('button', { name: 'Stop pi' }).waitFor()
      await wait(150)
      await human.mouse.move(200, 550)
      await human.mouse.down()
      await human.mouse.move(260, 560, { steps: 5 })
      await human.mouse.up()
      const inkCount = await human.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((s) => s.type === 'draw').length)
      await human.getByRole('button', { name: 'Stop pi' }).click()
      await human.getByRole('button', { name: 'Ask pi' }).waitFor()
      assert.equal(await human.evaluate(() => window.canvas.editor.getCurrentPageShapes()
        .filter((shape) => shape.meta?.agentAnswer).length), 3)
      assert.equal((await status()).view.source, 'browser')
      const partial = await human.evaluate(() => {
        const shape = window.canvas.editor.getCurrentPageShapes().filter((s) => s.meta.agentAnswer).at(-1)!
        return { id: shape.id as string, text: window.canvas.editor.getShapeUtil(shape).getText(shape) }
      })
      await human.getByRole('button', { name: 'Undo', exact: true }).click()
      assert.equal(await human.evaluate((id) => !!window.canvas.editor.getShape(id as any), partial.id), false)
      assert.equal(await human.evaluate(() => window.canvas.editor.getCurrentPageShapes().filter((s) => s.type === 'draw').length), inkCount)
      await human.getByRole('button', { name: 'Redo', exact: true }).click()
      assert.equal(await human.evaluate((id) => {
        const shape = window.canvas.editor.getShape(id as any)!
        return window.canvas.editor.getShapeUtil(shape).getText(shape)
      }, partial.id), partial.text)
    })

    await t.test('verbose replies are capped and a fresh zoomed-in drawing ignores distant old answers', async () => {
      await human.getByRole('combobox', { name: 'Reply style' }).selectOption('check')
      await human.getByRole('textbox', { name: 'Question for pi' }).fill('verbose')
      await human.evaluate(() => { window.canvas.editor.setCamera({ x: -3000, y: -3000, z: 4 }) })
      await human.mouse.move(100, 200)
      await human.mouse.down()
      await human.mouse.move(240, 230, { steps: 5 })
      await human.mouse.up()
      await human.waitForTimeout(600)
      await human.getByRole('button', { name: 'Ask pi' }).click()
      await human.getByRole('button', { name: 'Stop pi' }).waitFor()
      await human.getByRole('button', { name: 'Ask pi' }).waitFor()
      const note = await human.evaluate(() => {
        const shape = window.canvas.editor.getCurrentPageShapes().filter((s) => s.meta.agentAnswer).at(-1)!
        const bounds = window.canvas.editor.getShapePageBounds(shape)!
        return { text: window.canvas.editor.getShapeUtil(shape).getText(shape), bounds, scale: (shape.props as { scale: number }).scale,
          visible: window.canvas.editor.getViewportPageBounds().includes(bounds) }
      })
      assert(note.text!.length <= MAX_ANSWER_CHARS)
      assert(note.text!.endsWith('…'))
      assert.equal(note.scale, .25)
      assert(note.bounds.x > 3000 && note.bounds.x < 3100)
      assert(note.visible, 'the completed reply must remain visible')
      assert.equal(asked.at(-1)!.prompt, buildAskPrompt('verbose', 'check'))
      await human.screenshot({ path: resolve(root, 'test-results/ask-zoomed.png') })
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
      await second.waitForFunction((id) => (window.canvas.editor.getShape(id as any)?.props as { isComplete?: boolean })?.isComplete === true, fine.id)
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
      app = await startServer({ dataDir, port: address.port, host: '127.0.0.1', production: true, ask: runner })
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
