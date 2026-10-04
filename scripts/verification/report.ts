import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
export type Checkpoint = { name: string; status: 'passed' } | { name: string; status: 'manual'; instruction: string } |
  { name: string; status: 'failed'; error: string; expected?: string; actual?: string }
export type Report = { runId: string; scenario: string; surface: 'browser' | 'ipad'; status: 'running' | 'passed' | 'failed' | 'incomplete';
  startedAt: string; finishedAt?: string; checkpoints: Checkpoint[]; artifacts: Record<string, string>; error?: string;
  url?: string; instanceId?: string; buildId?: string; deviceId?: string; physicalChecks?: Record<string, string> }

export async function createRun(scenario: string, surface: Report['surface']) {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const dir = resolve(root, 'test-results/verify', runId)
  await mkdir(dir, { recursive: true })
  const report: Report = { runId, scenario, surface, status: 'running', startedAt: new Date().toISOString(), checkpoints: [], artifacts: {} }
  const save = async () => {
    const temporary = resolve(dir, `report-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n')
    await rename(temporary, resolve(dir, 'report.json'))
  }
  const check = async (name: string, action: () => Promise<void> | void) => {
    try { await action(); report.checkpoints.push({ name, status: 'passed' }) }
    catch (error) {
      report.status = 'failed'
      report.error = error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200)
      const failure: Checkpoint = { name, status: 'failed', error: report.error }
      if (error && typeof error === 'object') {
        if ('expected' in error) failure.expected = JSON.stringify(error.expected)?.slice(0, 800)
        if ('actual' in error) failure.actual = JSON.stringify(error.actual)?.slice(0, 800)
      }
      report.checkpoints.push(failure)
      await save()
      throw error
    }
    await save()
  }
  await save()
  return { dir, report, save, check }
}
export type Run = Awaited<ReturnType<typeof createRun>>
