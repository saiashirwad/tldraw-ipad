#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { resolve, dirname, extname } from 'node:path'
import { chromium } from 'playwright'
import { isDeepStrictEqual } from 'node:util'

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: 'string', default: process.env.TLDRAW_IPAD_URL ?? 'http://localhost:4789' },
  output: { type: 'string' }, all: { type: 'boolean', default: false },
  x: { type: 'string' }, y: { type: 'string' }, width: { type: 'string' },
  'if-revision': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} })
const [command, file] = positionals
const base = values.url.replace(/\/$/, '')

async function api(path, body) {
  const response = await fetch(`${base}/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? response.statusText)
  return result
}
async function save(path, content) {
  path = resolve(path)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, content)
  await rename(temp, path)
  return path
}
function number(name) {
  if (values[name] === undefined) return undefined
  const result = Number(values[name])
  if (!Number.isFinite(result) || (name === 'width' && result <= 0)) throw new Error(`Invalid --${name}`)
  return result
}

async function run() {
  if (values.help || !command) {
    console.log(`tldraw-ipad — one shared canvas

  status                             Connection, revision and last visible view
  draw FILE.json                     Add/update native tldraw shapes (array; '-' reads stdin)
  put FILE.png|svg                    Place an image in the current view
  capture [--all] [--output FILE.png] Capture the user's view, or the whole page
  backup --output FILE.tldr           Save an editable file with embedded images
  clear --if-revision N               Clear all ink and shapes at revision N
  restore FILE.tldr --if-revision N   Replace the board with an editable backup

Options: --url URL, --x N, --y N, --width N (put)
Default URL: TLDRAW_IPAD_URL or http://localhost:4789
Open the capture's returned image path with your image-reading tool.`)
    return
  }
  if (!['status', 'draw', 'put', 'capture', 'backup', 'clear', 'restore'].includes(command)) throw new Error(`Unknown command: ${command}`)
  if (command === 'status') return api('status')
  if (command === 'clear' || command === 'restore') {
    if (!values['if-revision']) throw new Error('First save a backup, then supply --if-revision from its result.')
    if (!Number.isSafeInteger(Number(values['if-revision']))) throw new Error('Invalid revision')
    if (command === 'clear') return api('clear', { revision: Number(values['if-revision']) })
  }
  if (['draw', 'put', 'restore'].includes(command) && !file) throw new Error('Supply an input file.')
  if (command === 'backup' && !values.output) throw new Error('Supply --output FILE.tldr.')
  // Use the actual SDK for shape defaults, image decoding, and UI-free exports.
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    await page.goto(`${base}/?agent=1`)
    await page.waitForFunction(() => !!window.canvas, { timeout: 20000 })
    if (command === 'capture') {
      const result = await page.evaluate((all) => window.canvas.capture(all), values.all)
      const image = await save(values.output ?? `canvas-${Date.now()}.png`, Buffer.from(result.url.split(',')[1], 'base64'))
      return { image, bounds: result.bounds, viewUpdatedAt: result.viewUpdatedAt }
    }
    if (command === 'backup') {
      const before = await api('status')
      const json = await page.evaluate(() => window.canvas.backup())
      const after = await api('status')
      if (before.revision !== after.revision) throw new Error('Board changed during backup. Retry when drawing pauses.')
      return { backup: await save(values.output, json), revision: after.revision }
    }
    if (command === 'restore') {
      const snapshot = await page.evaluate((json) => window.canvas.prepareRestore(json), await readFile(resolve(file), 'utf8'))
      return await api('restore', { revision: Number(values['if-revision']), snapshot })
    }
    let ids
    if (command === 'draw') {
      let json
      if (file === '-') {
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        json = Buffer.concat(chunks).toString('utf8')
      } else json = await readFile(resolve(file), 'utf8')
      ids = await page.evaluate((shapes) => window.canvas.draw(shapes), JSON.parse(json))
    } else {
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }
      const type = types[extname(file).toLowerCase()]
      if (!type) throw new Error('Expected a PNG, JPEG, WebP, GIF or SVG image.')
      const bytes = await readFile(resolve(file))
      if (bytes.length > 25 * 1024 * 1024) throw new Error('Image exceeds 25 MiB.')
      ids = await page.evaluate((input) => window.canvas.put(input), {
        src: `data:${type};base64,${bytes.toString('base64')}`, name: file.split('/').pop(),
        x: number('x'), y: number('y'), width: number('width'),
      })
    }
    const expected = await page.evaluate((ids) => ids.map((id) => window.canvas.editor.getShape(id)), ids)
    // Return success after the authoritative, persistent server has received the edit.
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const snapshot = await api('snapshot')
      const records = new Map(snapshot.documents.map((r) => [r.state.id, r.state]))
      if (expected.every((r) => isDeepStrictEqual(records.get(r.id), r))) return { shapes: ids, revision: (await api('status')).revision }
      await new Promise((accept) => setTimeout(accept, 100))
    }
    throw new Error(`Unknown outcome: server acknowledgement timed out. Inspect status/capture before retrying. Shape IDs: ${ids.join(', ')}`)
  } finally { await browser.close() }
}

try {
  const result = await run()
  if (result) console.log(JSON.stringify(result))
} catch (error) {
  console.error(JSON.stringify({ error: error.message }))
  process.exitCode = 1
}
