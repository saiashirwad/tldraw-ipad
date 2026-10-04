import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createBrowserSession, createRun, createSession } from '../scripts/verification/session'
import { showPhysicalInstruction } from '../scripts/verification/device'

const dist = () => process.env.TLDRAW_VERIFY_DIST ?? resolve(import.meta.dirname, '../dist')

test('bind failure releases model and storage resources and lets the process exit', { timeout: 10000 }, async () => {
  const run = await createRun('bind-failure-contract', 'browser')
  const session = await createSession(run, { distDir: dist() })
  try {
    const script = `import assert from 'node:assert/strict'; import { startServer } from './server.ts';
      let disposed = 0; const model = { async *run() {}, dispose() { disposed++ } };
      await assert.rejects(startServer({ port: ${session.port}, host: '127.0.0.1', dataDir: ${JSON.stringify(resolve(run.dir, 'collision'))},
        production: true, distDir: ${JSON.stringify(dist())}, ask: model, questionMark: model }), { code: 'EADDRINUSE' });
      assert.equal(disposed, 2); console.log('resources released');`
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: resolve(import.meta.dirname, '..'), timeout: 4000 })
    assert.match(result.stdout, /resources released/)
  } finally { await session.close() }
})

test('physical step instructions update on the board and do not consume stroke undo', { timeout: 20000 }, async () => {
  const run = await createRun('physical-instruction-contract', 'browser')
  const session = await createBrowserSession(run, dist())
  try {
    const waitInstruction = (text: string) => session.human.waitForFunction((expected) => {
      const editor = window.canvas.editor
      const shape = editor.getCurrentPageShapes().find((s) => s.id === 'shape:physical-instruction')
      return shape && editor.getShapeUtil(shape).getText(shape)?.includes(expected)
    }, text)
    await showPhysicalInstruction(run, session, 'draw')
    await waitInstruction('Draw one stroke')
    await session.human.evaluate(() => { window.canvas.editor.setCurrentTool('draw') })
    await session.human.mouse.move(400, 450); await session.human.mouse.down()
    await session.human.mouse.move(500, 460, { steps: 5 }); await session.human.mouse.up()
    await session.human.waitForFunction(() => window.canvas.editor.getCurrentPageShapes().some((s) => s.type === 'draw'))
    await showPhysicalInstruction(run, session, 'undo')
    await waitInstruction('Tap Undo')
    await session.human.evaluate(() => { window.canvas.editor.undo() })
    await session.human.waitForFunction(() => !window.canvas.editor.getCurrentPageShapes().some((s) => s.type === 'draw'))
    await showPhysicalInstruction(run, session, 'complete')
    await waitInstruction('Check complete')
    assert.equal(await session.human.evaluate(() => window.canvas.editor.getCurrentPageShapes().length), 1)
    run.report.status = 'passed'
  } catch (error) { run.report.status = 'failed'; throw error }
  finally { await session.close(); run.report.finishedAt = new Date().toISOString(); await run.save() }
})

test('failed editor startup retains evidence and closes its owned server', { timeout: 10000 }, async () => {
  const run = await createRun('startup-failure-contract', 'browser')
  const broken = resolve(run.dir, 'broken-build')
  await mkdir(broken)
  await writeFile(resolve(broken, 'build.json'), JSON.stringify({ buildId: 'broken' }))
  await writeFile(resolve(broken, 'index.html'), '<script>console.error("intentional startup failure")</script>')
  await assert.rejects(createBrowserSession(run, broken, undefined, { timeoutMs: 1000 }), /Timeout/)
  await access(run.report.artifacts['page-0'])
  await access(run.report.artifacts.trace)
  await access(run.report.artifacts.browserLog)
  await access(run.report.artifacts.snapshot)
  await assert.rejects(fetch(`${run.report.url}/api/status`, { signal: AbortSignal.timeout(1000) }))
})

test('initial report failure closes a server that already bound its port', { timeout: 10000 }, async () => {
  const run = await createRun('report-init-failure-contract', 'browser')
  await assert.rejects(createSession({ ...run, save: async () => { throw new Error('intentional report write failure') } },
    { distDir: dist() }), /intentional report write failure/)
  assert(run.report.url)
  await assert.rejects(fetch(`${run.report.url}/api/status`, { signal: AbortSignal.timeout(1000) }))
})

test('reload and stop requests must match the owned instance and session', { timeout: 10000 }, async () => {
  const run = await createRun('reload-identity-contract', 'browser')
  const accepted: string[] = []
  let stopped = 0
  const session = await createSession(run, { distDir: dist(), onReload: (requestId) => accepted.push(requestId), onStop: () => { stopped++ } })
  try {
    const current = await session.status()
    const send = (action: string, instanceId: string, sessionId: string) => fetch(`${session.url}/api/verification/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, sessionId, requestId: 'request' }) })
    for (const action of ['reload', 'stop']) {
      assert.equal((await send(action, 'old', run.report.runId)).status, 409)
      assert.equal((await send(action, current.instanceId, 'another-session')).status, 409)
      assert.deepEqual(accepted, [])
      assert.equal(stopped, 0)
    }
    assert.equal((await send('reload', current.instanceId, run.report.runId)).status, 202)
    assert.deepEqual(accepted, ['request'])
    assert.equal((await send('stop', current.instanceId, run.report.runId)).status, 202)
    assert.equal(stopped, 1)
  } finally { await session.close() }
})
