#!/usr/bin/env -S node --import tsx
import { parseArgs } from 'node:util'
import { scenarios } from './verification/scenarios'
import { buildRun, createBrowserSession, createRun, summarize } from './verification/session'

const { values } = parseArgs({ options: { scenario: { type: 'string', default: 'all' }, list: { type: 'boolean' } } })
if (values.list) console.log(JSON.stringify({ scenarios: Object.keys(scenarios) }))
else {
  const names = values.scenario === 'all' ? Object.keys(scenarios) : [values.scenario!]
  if (names.some((name) => !Object.hasOwn(scenarios, name))) {
    console.error(JSON.stringify({ error: `Unknown scenario. Choose ${Object.keys(scenarios).join(', ')}` })); process.exitCode = 1
  } else {
    const build = await createRun('build', 'browser')
    let distDir: string | undefined
    try { await build.check('Build the current source', async () => { distDir = await buildRun(build) }); build.report.status = 'passed' }
    catch { console.error(JSON.stringify(summarize(build))); process.exitCode = 1 }
    finally { await build.save() }
    if (distDir) for (const name of names) {
      const run = await createRun(name, 'browser')
      run.report.artifacts.build = build.report.artifacts.build
      let session: Awaited<ReturnType<typeof createBrowserSession>> | undefined
      try {
        await run.check('Start an isolated matching editor', async () => { session = await createBrowserSession(run, distDir!) })
        await scenarios[name](session!, run)
        run.report.status = 'passed'
      } catch (error) { run.report.status = 'failed'; run.report.error ??= String(error).slice(0, 1200); process.exitCode = 1 }
      finally {
        try { await session?.close() } catch (error) { run.report.status = 'failed'; run.report.error = `Cleanup failed ${String(error)}`; process.exitCode = 1 }
        run.report.finishedAt = new Date().toISOString(); await run.save(); console.log(JSON.stringify(summarize(run)))
      }
    }
  }
}
