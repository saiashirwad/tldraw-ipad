import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildRun, createRun, createSession, loadServer, root, summarize, until, type Session } from './verification/session'
import { captureDevice, installHost, lanHost, launchDevice, matchingView, selectDevice, showPhysicalInstruction } from './verification/device'
import { createPiAgent } from '../pi'
import { QUESTION_MARK_SYSTEM_PROMPT } from '../src/question-mark'

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  device: { type: 'string' }, host: { type: 'string' }, scenario: { type: 'string' }, session: { type: 'string' },
  'live-model': { type: 'boolean' }, 'no-install': { type: 'boolean' }, timeout: { type: 'string' }, help: { type: 'boolean' },
} })
const action = positionals[0]
const scenario = values.scenario ?? (action === 'dev' ? 'drawing' : 'render')
const timeout = Number(values.timeout ?? (action === 'stop' ? '1800' : '120')) * 1000
const prompt = (message: string) => console.error(message)

if (values.help) {
  console.log(`ipad:dev [--scenario drawing|ask] [--device ID] [--host LAN_IP] [--live-model]\nipad:reload --session PATH\nipad:stop --session PATH\nipad:verify [--scenario render|pencil|gestures] [--timeout SECONDS]\nipad:install [--device ID]\nDevice sessions use scratch boards. Physical scenarios wait for your input. Ctrl-C preserves evidence and ends the owned server.`)
} else if (!Number.isFinite(timeout) || timeout <= 0) {
  throw new Error('Use a positive --timeout in seconds')
} else if (action === 'reload' || action === 'stop') {
  if (!values.session) throw new Error('Supply --session with the session.json path from ipad:dev')
  const raw: unknown = JSON.parse(await readFile(resolve(values.session), 'utf8'))
  if (!raw || typeof raw !== 'object' || !('url' in raw) || typeof raw.url !== 'string' || !('instanceId' in raw) || typeof raw.instanceId !== 'string' ||
    !('runId' in raw) || typeof raw.runId !== 'string') throw new Error('Invalid session file')
  const current = await fetch(`${raw.url}/api/status`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
  if (current.mode !== 'verification' || current.instanceId !== raw.instanceId || current.verificationSession !== raw.runId) throw new Error('Session is no longer the server described by this file')
  if (action === 'stop') {
    if (!('report' in raw) || typeof raw.report !== 'string') throw new Error('Session has no report path')
    const response = await fetch(`${raw.url}/api/verification/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: raw.instanceId, sessionId: raw.runId, requestId: randomUUID() }), signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(await response.text())
    const result = await until(async () => JSON.parse(await readFile(raw.report as string, 'utf8')),
      (report) => report.runId === raw.runId && !!report.finishedAt, 'Cleanup timed out. Inspect the session report.', timeout)
    console.log(JSON.stringify({ stopped: raw.runId, status: result.status, report: raw.report }))
    if (result.status === 'failed') process.exitCode = 1
  } else {
    const requestId = randomUUID()
    const response = await fetch(`${raw.url}/api/verification/reload`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: raw.instanceId, sessionId: raw.runId, requestId }), signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(await response.text())
    const result = await until(async () => JSON.parse(await readFile(resolve(values.session!), 'utf8')),
      (state) => state.reload?.requestId === requestId && state.reload.status !== 'running', 'Reload timed out. Inspect the session report.', 180000)
    console.log(JSON.stringify(result.reload))
    if (result.reload.status !== 'passed') process.exitCode = 1
  }
} else {
  if (!['dev', 'verify', 'install'].includes(action) || !Number.isFinite(timeout) || timeout <= 0) throw new Error('Use dev, verify, reload, or install with a positive --timeout')
  if (!['drawing', 'ask', 'render', 'pencil', 'gestures'].includes(scenario)) throw new Error('Unknown iPad scenario')
  const run = await createRun(scenario, 'ipad')
  let session: Session | undefined
  let device: Awaited<ReturnType<typeof selectDevice>> | undefined
  let launched = false
  let backedUp = false
  let stopping = false
  let reloading = false
  let reloadTask: Promise<void> | null = null
  const controller = new AbortController()
  const interrupt = () => { stopping = true; controller.abort() }
  const checkStopping = () => { if (stopping) throw new Error('Session interrupted') }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const sessionPath = resolve(run.dir, 'session.json')
  let reload: { requestId: string; status: 'running' | 'passed' | 'failed'; error?: string } | undefined
  const saveSession = async () => {
    const temporary = `${sessionPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ runId: run.report.runId, pid: process.pid, url: session?.url,
      instanceId: run.report.instanceId, buildId: run.report.buildId, report: resolve(run.dir, 'report.json'), reload }, null, 2))
    await rename(temporary, sessionPath)
  }
  try {
    device = await selectDevice(run, values.device)
    checkStopping()
    const selectedDevice = device
    if (action === 'install') { await installHost(run, selectedDevice, true); run.report.status = 'passed' }
    else {
      if (!values['no-install']) await run.check('Install the native host when its source changes', () => installHost(run, selectedDevice))
      checkStopping()
      const host = lanHost(values.host)
      const makeModels = () => values['live-model'] ? { ask: createPiAgent(),
        questionMark: createPiAgent({ systemPrompt: QUESTION_MARK_SYSTEM_PROMPT }), asked: [], recognized: [] } : undefined
      const reloadSession = async (requestId: string) => {
        reload = { requestId, status: 'running' }
        try {
          checkStopping()
          await saveSession()
          const previous = session!
          await captureDevice(run, previous, selectedDevice, `before-reload-${Date.now()}`)
          const build = await buildRun(run)
          checkStopping()
          const port = previous.port
          const dataDir = previous.dataDir
          await previous.app.close()
          const startServer = await loadServer(build)
          const models = makeModels() ?? previous.models
          const app = await startServer({ port, host: '0.0.0.0', dataDir, production: true, distDir: build,
            verificationSession: run.report.runId, ask: models.ask, questionMark: models.questionMark,
            onVerificationReload: requestReload, onVerificationStop: interrupt })
          session = { ...previous, app, models, close: async () => { await app.close(); await (await import('node:fs/promises')).rm(dataDir, { recursive: true, force: true }) } }
          const current = await session.status()
          Object.assign(run.report, { instanceId: current.instanceId, buildId: current.buildId })
          checkStopping()
          await launchDevice(run, session, selectedDevice, host)
          await captureDevice(run, session, selectedDevice, `reloaded-${Date.now()}`)
          reload.status = 'passed'
        } catch (error) { reload.status = 'failed'; reload.error = String(error).slice(0, 1000); run.report.status = 'failed'; run.report.error = reload.error; controller.abort() }
        finally { reloading = false; await saveSession(); await run.save() }
      }
      function requestReload(requestId: string) {
        if (stopping || reloading) throw new Error('Session is stopping or a reload is already running')
        reloading = true
        reloadTask = new Promise<void>((done) => setTimeout(done, 20)).then(() => reloadSession(requestId)).catch((error) => {
          reloading = false; run.report.status = 'failed'; run.report.error = String(error).slice(0, 1200); controller.abort()
        })
      }
      const distDir = await buildRun(run)
      checkStopping()
      session = await createSession(run, { distDir, host: '0.0.0.0', models: makeModels(),
        onReload: action === 'dev' ? requestReload : undefined, onStop: action === 'dev' ? interrupt : undefined })
      if (scenario === 'ask' || scenario === 'render') {
        const file = resolve(run.dir, 'seed.json')
        await writeFile(file, JSON.stringify([{ id: 'shape:device-check', type: 'geo', x: 100, y: 140, text: 'iPad verification',
          props: { geo: 'rectangle', w: 260, h: 120, color: 'blue' } }]))
        await session.cli('draw', file)
      }
      if (action === 'verify' && (scenario === 'pencil' || scenario === 'gestures')) {
        await showPhysicalInstruction(run, session, scenario === 'pencil' ? 'draw' : 'pan')
      }
      let loaded: Awaited<ReturnType<typeof launchDevice>> | undefined
      checkStopping()
      await run.check('Physical iPad loads the matching session and bundle', async () => { launched = true; loaded = await launchDevice(run, session!, selectedDevice, host) })
      await run.check('Device editor renders the test document', async () => {
        if (scenario === 'ask' || scenario === 'render') assert(loaded?.client?.shapeIds.includes('shape:device-check'))
        else if (action === 'verify' && (scenario === 'pencil' || scenario === 'gestures')) {
          assert.deepEqual(loaded?.client?.shapeIds, ['shape:physical-instruction'])
        } else assert.equal(loaded?.client?.shapeIds.length, 0, 'Drawing sessions start with an empty board')
      })
      await captureDevice(run, session, selectedDevice, 'ready')
      run.report.physicalChecks = { pressure: 'unverified', palmRejection: 'unverified', responsiveness: 'unverified', rotation: 'unverified' }
      await saveSession()
      if (action === 'dev') {
        prompt(`iPad ready. Session ${sessionPath}\nReload web changes with pnpm ipad:reload --session ${sessionPath}\nDraw on this scratch board. Ctrl-C saves the board and returns Canvas to its normal address.`)
        console.log(JSON.stringify({ ...summarize(run), session: sessionPath, model: values['live-model'] ? 'live' : 'scripted' }))
        await new Promise<void>((done) => { if (controller.signal.aborted) done(); else controller.signal.addEventListener('abort', () => done(), { once: true }) })
        await reloadTask
        if (run.report.status !== 'failed') run.report.status = 'incomplete'
      } else if (scenario === 'pencil') {
        const initial = await session.status()
        const initialPenUp = loaded?.client?.penUp ?? 0
        prompt('Draw one stroke with Pencil on the scratch board, then lift it. The runner waits for actual pen input and synced ink.')
        let strokeId = ''
        await run.check('Physical Pencil stroke is rendered and synced', async () => {
          await until(session!.status, (status) => {
            if (controller.signal.aborted) throw new Error('Physical check interrupted')
            const view = matchingView(status, run.report.runId, Date.parse(run.report.startedAt))
            strokeId = view?.client?.shapeIds.find((id) => !initial.view?.client?.shapeIds.includes(id)) ?? ''
            return !!strokeId && (view?.client?.penUp ?? 0) > initialPenUp
          }, 'No physical Pencil stroke was observed', timeout)
          const snapshot = await session!.snapshot()
          assert(snapshot.documents.some((r: { state: { id: string; type: string } }) => r.state.id === strokeId && r.state.type === 'draw'))
        })
        await captureDevice(run, session, selectedDevice, 'pencil')
        await showPhysicalInstruction(run, session, 'undo')
        prompt('Tap Undo on the iPad. The runner checks that the same stroke disappears.')
        await run.check('Physical Undo removes the Pencil stroke', async () => {
          await until(session!.status, (status) => {
            if (controller.signal.aborted) throw new Error('Physical check interrupted')
            const view = matchingView(status, run.report.runId, Date.parse(run.report.startedAt))
            return !!view && !view.client!.shapeIds.includes(strokeId)
          }, 'Undo was not observed', timeout)
          assert(!(await session!.snapshot()).documents.some((r: { state: { id: string } }) => r.state.id === strokeId))
        })
        await captureDevice(run, session, selectedDevice, 'undo')
        await showPhysicalInstruction(run, session, 'complete')
        await captureDevice(run, session, selectedDevice, 'complete')
        run.report.status = 'passed'
      } else if (scenario === 'gestures') {
        const original = loaded!.bounds
        prompt('Pan with one finger, then pinch to zoom. Do not draw. The runner checks the viewport and unchanged document.')
        const before = await session.snapshot()
        await run.check('Physical finger pan changes the viewport without ink', async () => {
          await until(session!.status, (status) => {
            if (controller.signal.aborted) throw new Error('Physical check interrupted')
            const view = matchingView(status, run.report.runId, Date.parse(run.report.startedAt))
            return !!view && (Math.abs(view.bounds.x - original.x) > 10 || Math.abs(view.bounds.y - original.y) > 10)
          }, 'Finger pan was not observed', timeout)
          assert.deepEqual(await session!.snapshot(), before)
        })
        await showPhysicalInstruction(run, session, 'zoom')
        const beforeZoom = await session.snapshot()
        await run.check('Physical pinch changes zoom without ink', async () => {
          await until(session!.status, (status) => {
            if (controller.signal.aborted) throw new Error('Physical check interrupted')
            const view = matchingView(status, run.report.runId, Date.parse(run.report.startedAt))
            return !!view && Math.abs(view.bounds.w - original.w) > original.w * .1
          }, 'Pinch was not observed', timeout)
          assert.deepEqual(await session!.snapshot(), beforeZoom)
        })
        await showPhysicalInstruction(run, session, 'complete')
        await captureDevice(run, session, selectedDevice, 'gestures'); run.report.status = 'passed'
      } else { run.report.status = 'passed' }
    }
  } catch (error) {
    run.report.status = 'failed'; run.report.error = String(error).slice(0, 1200); process.exitCode = 1
    if (session) {
      if (action === 'verify' && (scenario === 'pencil' || scenario === 'gestures')) await showPhysicalInstruction(run, session, 'ended').catch(() => {})
      if (device && launched) await captureDevice(run, session, device, 'failure').catch(() => {})
    }
  } finally {
    try {
      let returned = !launched
      if (device && launched) {
        try {
          await run.check('Return the native host to its saved everyday address', async () => {
            await (await import('./verification/session')).command(run, 'native-return', 'xcrun', ['devicectl', 'device', 'process', 'launch',
              '--device', device!.id, '--terminate-existing', 'in.texoport.tldrawipad'])
            returned = true
          })
        } catch { process.exitCode = 1 }
      }
      if (session) {
        try { await run.check('Preserve the final editable scratch board', async () => { await session!.backup(); backedUp = true }) }
        catch { process.exitCode = 1 }
      }
      if (session && (!backedUp || !returned)) {
        run.report.artifacts.scratchData = session.dataDir
        await session.app.close()
      } else await session?.close()
    } catch (error) {
      run.report.status = 'failed'; run.report.error = String(error).slice(0, 1200); process.exitCode = 1
    } finally {
      try { run.report.finishedAt = new Date().toISOString(); await run.save(); console.log(JSON.stringify(summarize(run))) }
      finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
    }
  }
}
