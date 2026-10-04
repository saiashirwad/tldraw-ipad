import { test } from 'node:test'
import { resolve } from 'node:path'
import { scenarios } from '../scripts/verification/scenarios'
import { createBrowserSession, createRun } from '../scripts/verification/session'

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`focused ${name}`, { timeout: 60000 }, async () => {
    const run = await createRun(name, 'browser')
    let session: Awaited<ReturnType<typeof createBrowserSession>> | undefined
    try {
      session = await createBrowserSession(run, process.env.TLDRAW_VERIFY_DIST ?? resolve(import.meta.dirname, '../dist'))
      await scenario(session, run)
      run.report.status = 'passed'
    } catch (error) {
      run.report.status = 'failed'; run.report.error = String(error).slice(0, 1200)
      throw error
    } finally { await session?.close(); run.report.finishedAt = new Date().toISOString(); await run.save() }
  })
}
