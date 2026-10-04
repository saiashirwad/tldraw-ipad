#!/usr/bin/env -S node --import tsx
import { readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { buildRun, createRun, root, summarize } from './verification/session'

const run = await createRun('suite', 'browser')
try {
  const { values } = parseArgs({ options: { browser: { type: 'boolean' }, match: { type: 'string' } } })
  const distDir = await buildRun(run)
  const files = (await readdir(resolve(root, 'tests'))).filter((name) => name.endsWith('.test.ts') &&
    (!values.browser || name === 'canvas.test.ts' || name.endsWith('.browser.test.ts')))
  const log = resolve(run.dir, 'tests.log')
  run.report.artifacts.tests = log
  const exec = promisify(execFile)
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec',
      ...(values.match ? [`--test-name-pattern=${values.match}`] : []), ...files.map((name) => resolve(root, 'tests', name))],
      { cwd: root, env: { ...process.env, TLDRAW_VERIFY_DIST: distDir }, timeout: 180000, maxBuffer: 12 * 1024 * 1024 })
    await writeFile(log, result.stdout + result.stderr)
    run.report.status = 'passed'
    console.log(result.stdout.split('\n').filter((line) => /^ℹ (tests|pass|fail|duration)/.test(line)).join('\n'))
  } catch (error) {
    if (error && typeof error === 'object') await writeFile(log,
      `${'stdout' in error ? error.stdout : ''}\n${'stderr' in error ? error.stderr : ''}`)
    throw new Error(`Test suite failed. See ${log}`)
  }
} catch (error) { run.report.status = 'failed'; run.report.error = String(error).slice(0, 1200); process.exitCode = 1 }
finally { run.report.finishedAt = new Date().toISOString(); await run.save(); console.log(JSON.stringify(summarize(run))) }
