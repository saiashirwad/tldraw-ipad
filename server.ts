import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer } from 'ws'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import { createServer as createViteServer } from 'vite'
import { createPiAgent, limitAnswer, type AskRunner } from './pi'
import { buildAskPrompt } from './src/ask-prompts'
import { confirmedQuestionMark, QUESTION_MARK_SYSTEM_PROMPT } from './src/question-mark'

const MAX_ASK_BYTES = 12 * 1024 * 1024

const root = dirname(fileURLToPath(import.meta.url))
const mime: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  html: 'text/html', js: 'text/javascript', css: 'text/css', woff2: 'font/woff2',
}
export type View = { pageId: string; bounds: { x: number; y: number; w: number; h: number }; updatedAt: number; source: 'ipad' | 'browser' }

export async function startServer({ port = 4789, host = '0.0.0.0', dataDir = resolve(root, 'data'), production = false,
  ask = createPiAgent(), questionMark = createPiAgent({ systemPrompt: QUESTION_MARK_SYSTEM_PROMPT, timeoutMs: 15000 }) }: {
  port?: number
  host?: string
  dataDir?: string
  production?: boolean
  /** Injectable so tests can script the model without a provider. */
  ask?: AskRunner
  /** A separate tool-free recognizer so YES/NO checks never contaminate the answer conversation. */
  questionMark?: AskRunner
} = {}) {
  await mkdir(resolve(dataDir, 'assets'), { recursive: true })
  const db = new DatabaseSync(resolve(dataDir, 'board.sqlite'))
  db.exec('PRAGMA journal_mode=WAL')
  const storage = new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db) })
  const room = new TLSocketRoom<TLRecord>({ storage })
  let view: View | null = null
  const vite = production ? null : await createViteServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    try {
      // Reject cross-origin browser writes. This is a personal app on a trusted LAN.
      if (req.headers.origin && req.headers.origin !== url.origin) return json({ error: 'Origin rejected' }, 403)
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json({ revision: room.getCurrentDocumentClock(), clients: room.getNumActiveSessions(), view })
      }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(room.getCurrentSnapshot())
      if (req.method === 'POST' && url.pathname === '/api/view') {
        const body = JSON.parse((await readBody(req, 4096)).toString())
        const b = body.bounds
        if (!body.pageId?.startsWith('page:') || !b || ![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) {
          return json({ error: 'Invalid viewport' }, 400)
        }
        const source = body.source === 'ipad' ? 'ipad' : 'browser'
        if (source === 'browser' && view?.source === 'ipad' && Date.now() - view.updatedAt < 15000) return json({ ok: true })
        view = { pageId: body.pageId, bounds: { x: b.x, y: b.y, w: b.w, h: b.h }, updatedAt: Date.now(), source }
        return json({ ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/api/question-mark') {
        const body = JSON.parse((await readBody(req, MAX_ASK_BYTES)).toString())
        const image = parseImage(body.image)
        if (!image) return json({ error: 'Expected an image of the question mark.' }, 400)
        const controller = new AbortController()
        res.on('close', () => controller.abort())
        let reply = ''
        for await (const delta of questionMark.run({ image, prompt: 'Is the entire isolated ink in this latest image a clear question mark? Reply only YES or NO.' }, controller.signal)) {
          if (controller.signal.aborted) break
          reply += delta
          if (reply.length > 32) break
        }
        if (controller.signal.aborted) return res.end()
        return json({ questionMark: confirmedQuestionMark(reply) })
      }
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = JSON.parse((await readBody(req, MAX_ASK_BYTES)).toString())
        const image = parseImage(body.image)
        if (!image) return json({ error: 'Expected a PNG or JPEG screenshot of the canvas.' }, 400)
        const prompt = buildAskPrompt(body.prompt, body.preset)
        const controller = new AbortController()
        res.on('close', () => controller.abort())
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        })
        res.flushHeaders()
        try {
          for await (const delta of limitAnswer(ask.run({ prompt, image }, controller.signal))) {
            if (controller.signal.aborted || !res.writable) break
            res.write(`${JSON.stringify({ type: 'delta', text: delta })}\n`)
          }
          if (!controller.signal.aborted) res.write(`${JSON.stringify({ type: 'done' })}\n`)
        } catch (error) {
          if (!controller.signal.aborted) res.write(`${JSON.stringify({ type: 'error', message: (error as Error).message })}\n`)
        }
        res.end()
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/clear') {
        const { revision } = JSON.parse((await readBody(req, 4096)).toString())
        if (revision !== room.getCurrentDocumentClock()) return json({ error: 'Board changed. Back up and use its new revision.' }, 409)
        await room.updateStore((store) => {
          for (const record of store.getAll()) {
            if (record.typeName === 'shape' || record.typeName === 'binding') store.delete(record.id)
          }
        })
        for (const session of room.getSessions()) room.sendCustomMessage(session.sessionId, { type: 'board-replaced' })
        return json({ revision: room.getCurrentDocumentClock() })
      }
      if (req.method === 'POST' && url.pathname === '/api/restore') {
        const { revision, snapshot } = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString())
        if (revision !== room.getCurrentDocumentClock()) return json({ error: 'Board changed. Back up and use its new revision.' }, 409)
        room.loadSnapshot(snapshot)
        for (const session of room.getSessions()) room.sendCustomMessage(session.sessionId, { type: 'board-replaced' })
        return json({ revision: room.getCurrentDocumentClock() })
      }
      if (req.method === 'POST' && url.pathname === '/api/assets') {
        const contentType = req.headers['content-type']?.split(';')[0]
        const extension = Object.keys(mime).find((key) => mime[key] === contentType && mime[key].startsWith('image/'))
        if (!extension) return json({ error: 'Use a PNG, JPEG, WebP, GIF or SVG image.' }, 415)
        const body = await readBody(req, 25 * 1024 * 1024)
        const name = `${randomUUID()}.${extension}`
        await writeFile(resolve(dataDir, 'assets', name), body, { flag: 'wx' })
        return json({ src: `/api/assets/${name}` })
      }
      const asset = /^\/api\/assets\/([a-f0-9-]+\.(png|jpg|webp|gif|svg))$/.exec(url.pathname)
      if (req.method === 'GET' && asset) {
        const bytes = await readFile(resolve(dataDir, 'assets', asset[1]))
        res.writeHead(200, {
          'Content-Type': mime[asset[2]], 'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        })
        return res.end(bytes)
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
      if (vite) return vite.middlewares(req, res, () => json({ error: 'Not found' }, 404))
      const path = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1)
      const file = resolve(root, 'dist', path)
      if (!file.startsWith(resolve(root, 'dist') + '/')) return json({ error: 'Not found' }, 404)
      const bytes = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[path.split('.').pop()!] ?? 'application/octet-stream' })
      res.end(bytes)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      json({ error: code === 'ENOENT' ? 'Not found' : (error as Error).message }, code === 'ENOENT' ? 404 : 400)
    }
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const sessionId = url.searchParams.get('sessionId')
    if (url.pathname !== '/sync' || !sessionId || (req.headers.origin && req.headers.origin !== url.origin)) return socket.destroy()
    sockets.handleUpgrade(req, socket, head, (ws) => room.handleSocketConnect({ sessionId, socket: ws }))
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, host, accept) })
  return {
    server, room,
    async close() {
      ask.dispose?.()
      questionMark.dispose?.()
      room.close()
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      await vite?.close()
      await new Promise<void>((accept) => server.close(() => accept()))
      // SDK 5.5.2 has no storage dispose API; stop its delayed SQLite maintenance first.
      const maintenance = Reflect.get(storage, 'pruneTombstones') as { cancel(): void } | undefined
      maintenance?.cancel()
      db.close()
    },
  }
}

function parseImage(value: unknown): { data: string; mimeType: string } | null {
  if (typeof value !== 'string') return null
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match || match[2].length > MAX_ASK_BYTES) return null
  return { mimeType: match[1], data: match[2] }
}

async function readBody(req: import('node:http').IncomingMessage, limit: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`Request exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4789)
  const app = await startServer({ port, dataDir: process.env.DATA_DIR, production: process.argv.includes('--production') })
  console.log(`Agent CLI: http://localhost:${port}`)
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) console.log(`iPad Safari: http://${entry.address}:${port}`)
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); process.exit(0) })
}
