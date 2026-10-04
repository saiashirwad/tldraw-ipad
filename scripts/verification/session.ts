import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import type { startServer, View } from '../../server'
import { pathToFileURL } from 'node:url'
import { sourceBuildId } from '../../build-id'
import type { AskInput, AskRunner } from '../../pi'

export const root = resolve(import.meta.dirname, '../..')
const exec = promisify(execFile)
export type Status = { instanceId: string; buildId: string; mode: 'live' | 'verification'; verificationSession: string | null;
  revision: number; clients: number; view: View | null; clientViews: View[] }
import { createRun, type Run } from './report'
export { createRun } from './report'
export type { Run, Report, Checkpoint } from './report'

export async function command(run: Run, name: string, executable: string, args: string[], cwd = root) {
  const path = resolve(run.dir, `${name}.log`)
  run.report.artifacts[name] = path
  try {
    const result = await exec(executable, args, { cwd, maxBuffer: 24 * 1024 * 1024, timeout: 180000 })
    await writeFile(path, result.stdout + result.stderr)
    return result.stdout
  } catch (error) {
    if (error && typeof error === 'object') {
      await writeFile(path, `${'stdout' in error ? error.stdout : ''}\n${'stderr' in error ? error.stderr : ''}`)
    }
    throw new Error(`${name} failed. See ${path}`, { cause: error })
  }
}

export async function buildRun(run: Run) {
  const fingerprint = sourceBuildId(root)
  const distDir = resolve(run.dir, `build-${randomUUID().slice(0, 8)}`)
  await command(run, 'typecheck', process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit'])
  await command(run, 'build', process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', distDir])
  const nodeDir = resolve(distDir, 'node')
  await mkdir(resolve(nodeDir, 'src'), { recursive: true })
  for (const name of ['server.ts', 'pi.ts', 'build-id.ts', 'src/ask-prompts.ts', 'src/question-mark.ts', 'src/runtime.ts', 'src/ask-placement.ts']) {
    await cp(resolve(root, name), resolve(nodeDir, name))
  }
  await symlink(resolve(root, 'node_modules'), resolve(nodeDir, 'node_modules'), 'dir')
  if (sourceBuildId(root) !== fingerprint) throw new Error('Source changed during the verification build. Run again.')
  return distDir
}

export async function loadServer(distDir: string): Promise<typeof startServer> {
  let path = resolve(distDir, 'node/server.ts')
  try { await readFile(path) } catch { path = resolve(root, 'server.ts') }
  const module: { startServer: typeof startServer } = await import(pathToFileURL(path).href)
  return module.startServer
}

export function scriptedModels() {
  const asked: AskInput[] = [], recognized: AskInput[] = []
  const ask: AskRunner = { async *run(input, signal) {
    asked.push(input)
    for (const text of ['A short ', 'answer.']) { if (signal?.aborted) return; yield text }
  } }
  const questionMark: AskRunner = { async *run(input) { recognized.push(input); yield 'NO' } }
  return { ask, questionMark, asked, recognized }
}

export async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, message: string, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs
  do {
    const value = await read()
    if (accepts(value)) return value
    await new Promise((accept) => setTimeout(accept, 100))
  } while (Date.now() < end)
  throw new Error(message)
}

export async function createSession(run: Run, options: {
  distDir: string; host?: string; port?: number; models?: ReturnType<typeof scriptedModels>;
  onReload?: (requestId: string) => void; onStop?: () => void
}) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'canvas-verify-'))
  const models = options.models ?? scriptedModels()
  let app: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const start = await loadServer(options.distDir)
    app = await start({ port: options.port ?? 0, host: options.host ?? '127.0.0.1', dataDir,
      production: true, distDir: options.distDir, verificationSession: run.report.runId,
      ask: models.ask, questionMark: models.questionMark, onVerificationReload: options.onReload, onVerificationStop: options.onStop })
    const ownedApp = app
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port')
    const url = `http://127.0.0.1:${address.port}`
    const status = async (): Promise<Status> => {
      const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`Status returned ${response.status}`)
      return response.json()
    }
    const first = await status()
    Object.assign(run.report, { url, instanceId: first.instanceId, buildId: first.buildId })
    await run.save()
    const cli = async <T = Record<string, unknown>>(...args: string[]): Promise<T> => {
      const { stdout } = await exec(process.execPath, [resolve(root, 'scripts/cli.mjs'), '--url', url, ...args],
        { cwd: dataDir, maxBuffer: 8 * 1024 * 1024, timeout: 30000 })
      return JSON.parse(stdout)
    }
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await ownedApp.close()
      await rm(dataDir, { recursive: true, force: true })
    }
    return { app, dataDir, url, port: address.port, models, status, cli, close,
      snapshot: async () => (await fetch(`${url}/api/snapshot`)).json(),
      backup: async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await cli<{ backup: string; revision: number }>('backup', '--output', resolve(run.dir, 'board.tldr'))
            run.report.artifacts.backup = result.backup
            return result
          } catch (error) {
            if (attempt >= 2 || !error || typeof error !== 'object' || !('stderr' in error) ||
              typeof error.stderr !== 'string' || !error.stderr.includes('"code":"REVISION_CHANGED"')) throw error
            await new Promise((done) => setTimeout(done, 300))
          }
        }
      } }
  } catch (error) {
    try { await app?.close() } finally { await rm(dataDir, { recursive: true, force: true }) }
    throw error
  }
}
export type Session = Awaited<ReturnType<typeof createSession>>

export async function createBrowserSession(run: Run, distDir: string, models?: ReturnType<typeof scriptedModels>, options: { timeoutMs?: number } = {}) {
  const session = await createSession(run, { distDir, models })
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  const messages: string[] = []
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      if (context) {
        for (const [index, page] of context.pages().entries()) {
          if (!page.isClosed()) {
            const path = resolve(run.dir, `page-${index}.png`)
            try { await page.screenshot({ path }); run.report.artifacts[`page-${index}`] = path }
            catch (error) { messages.push(`screenshot ${String(error)}`) }
          }
        }
        try { const path = resolve(run.dir, 'trace.zip'); await context.tracing.stop({ path }); run.report.artifacts.trace = path }
        catch (error) { messages.push(`trace ${String(error)}`) }
      }
      const page = context?.pages()[0]
      if (page && await page.evaluate(() => !!window.canvas).catch(() => false)) {
        await session.backup().catch((error) => messages.push(`backup ${String(error)}`))
      }
      const logs = resolve(run.dir, 'browser.log')
      await writeFile(logs, messages.join('\n'))
      run.report.artifacts.browserLog = logs
      const snapshot = resolve(run.dir, 'snapshot.json')
      await writeFile(snapshot, JSON.stringify(await session.snapshot()))
      run.report.artifacts.snapshot = snapshot
    } finally {
      try { await browser?.close() } finally { await session.close(); await run.save() }
    }
  }
  try {
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1024, height: 768 } })
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    context.on('page', (page) => {
      page.on('console', (message) => messages.push(`${message.type()} ${message.text()}`))
      page.on('pageerror', (error) => messages.push(`pageerror ${error.message}`))
      page.on('requestfailed', (request) => messages.push(`requestfailed ${request.url()} ${request.failure()?.errorText}`))
    })
    const human = await context.newPage()
    await human.goto(`${session.url}/?verify=${run.report.runId}`)
    await human.waitForFunction(() => !!window.canvas, undefined, { timeout: options.timeoutMs ?? 20000 })
    const ready = await until(session.status, (status) => status.clientViews.some((view) => view.client?.buildId === status.buildId &&
      view.client.instanceId === status.instanceId && view.client.sessionId === run.report.runId && view.client.synced),
      'Browser did not load the expected bundle', options.timeoutMs ?? 20000)
    run.report.buildId = ready.buildId
    return { ...session, human, context, browser, close }
  } catch (error) {
    run.report.status = 'failed'; run.report.error = String(error).slice(0, 1200)
    await close()
    throw error
  }
}
export type BrowserSession = Awaited<ReturnType<typeof createBrowserSession>>

export function summarize(run: Run) {
  return { scenario: run.report.scenario, surface: run.report.surface, status: run.report.status,
    checkpoints: run.report.checkpoints.length, error: run.report.error,
    report: resolve(run.dir, 'report.json'), artifacts: run.report.artifacts }
}
