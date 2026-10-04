#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = process.argv.slice(2)
function argument(name, fallback) {
  const index = options.indexOf(name)
  if (index === -1) return fallback
  if (!options[index + 1] || options[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`)
  return options[index + 1]
}
const device = argument('--device', '00008120-001C554628214032')
const scenario = argument('--scenario', 'render')
const runID = `standalone-${Date.now()}`
const boardID = argument('--board', runID)
const runDir = resolve(root, 'test-results/verify', runID)
const report = { runID, boardID, scenario, device, status: 'running', artifacts: {}, physicalInput: 'unverified' }

async function command(name, program, args, quiet = false) {
  const log = resolve(runDir, `${name}.log`)
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk; if (!quiet) process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { output += chunk; if (!quiet) process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('close', async (code) => {
      await writeFile(log, output)
      if (code === 0) accept(true)
      else if (quiet) accept(false)
      else reject(new Error(`${name} failed. See ${log}`))
    })
  })
}

try {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(boardID)) throw new Error('Use a bounded alphanumeric standalone board ID')
  if (!['render', 'stability', 'question', 'questions', 'live'].includes(scenario)) throw new Error('Choose render, stability, question, questions, or live (an alias for question)')
  await mkdir(runDir, { recursive: true })
  if (!options.includes('--skip-install')) await command('install', 'bash', ['scripts/run-ipad.sh', device, '--install-only'])
  if (options.includes('--provision')) {
    await command('provision', process.execPath, ['scripts/provision-deepseek.mjs', '--device', device,
      '--env-file', argument('--env-file', resolve(root, '.env'))])
  }
  await command('launch', 'xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device,
    '--terminate-existing', 'in.texoport.tldrawipad', '--standalone-board', boardID, '--standalone-verify', scenario, '--standalone-verify-run', runID])
  const nativeReport = resolve(runDir, 'native-report.json')
  const deadline = Date.now() + Number(argument('--timeout', scenario === 'questions' ? '420' : '180')) * 1000
  let found = false
  while (Date.now() < deadline) {
    found = await command('report-copy', 'xcrun', ['devicectl', 'device', 'copy', 'from', '--device', device,
      '--domain-type', 'appDataContainer', '--domain-identifier', 'in.texoport.tldrawipad',
      '--source', `Library/Application Support/Canvas/${boardID}/verification-report.json`, '--destination', nativeReport], true)
    if (found) {
      const received = JSON.parse(await readFile(nativeReport, 'utf8'))
      if (received.runID === runID) break
      found = false
    }
    await new Promise((accept) => setTimeout(accept, 1500))
  }
  await command('screenshot', 'xcrun', ['devicectl', 'device', 'capture', 'screenshot', '--device', device,
    '--destination', resolve(runDir, 'device.png')])
  report.artifacts.screenshot = resolve(runDir, 'device.png')
  if (!found) throw new Error('The standalone canvas did not write its verification report before timeout')
  report.native = JSON.parse(await readFile(nativeReport, 'utf8'))
  if (options.includes('--expect-existing') && !report.native.loadedShapeIds?.includes('shape:standalone-verification')) {
    throw new Error('The standalone canvas did not restore its saved verification shape')
  }
  const expectedBuild = JSON.parse(await readFile(resolve(root, 'dist/build.json'), 'utf8')).buildId
  if (report.native.status === 'passed' && report.native.buildId !== expectedBuild) {
    throw new Error('The standalone canvas loaded a different frontend build')
  }
  report.artifacts.nativeReport = nativeReport
  report.status = report.native.status === 'passed' ? 'passed' : 'failed'
  if (scenario === 'stability' && report.status === 'passed') {
    report.status = 'running'
    for (const seconds of [8, 95]) {
      const path = resolve(runDir, `stability-${seconds}.json`)
      let copied = false
      while (Date.now() < deadline) {
        copied = await command(`stability-${seconds}`, 'xcrun', ['devicectl', 'device', 'copy', 'from', '--device', device,
          '--domain-type', 'appDataContainer', '--domain-identifier', 'in.texoport.tldrawipad',
          '--source', `Documents/canvas-stability-${runID}-${seconds}.state.json`, '--destination', path], true)
        if (copied) {
          const state = JSON.parse(await readFile(path, 'utf8'))
          if (state.javascript || state.error) break
          copied = false
        }
        await new Promise((accept) => setTimeout(accept, 1500))
      }
      if (!copied) throw new Error(`Missing ${seconds}-second stability observation`)
      report.artifacts[`stability${seconds}`] = path
      const state = JSON.parse(await readFile(path, 'utf8'))
      if (state.runID !== runID || !state.javascript?.canvasElement || state.javascript.licenseGate ||
        state.javascript.controls < 3 || state.javascript.visibility !== 'visible' || state.javascript.errors?.length) {
        throw new Error(`Canvas did not remain visible at ${seconds} seconds. See ${path}`)
      }
    }
    await command('screenshot-after-95s', 'xcrun', ['devicectl', 'device', 'capture', 'screenshot', '--device', device,
      '--destination', resolve(runDir, 'device-after-95s.png')])
    report.artifacts.screenshot = resolve(runDir, 'device-after-95s.png')
    report.status = 'passed'
  }
  if (report.status !== 'passed') process.exitCode = 1
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  process.exitCode = 1
} finally {
  await mkdir(runDir, { recursive: true })
  const path = resolve(runDir, 'report.json')
  await writeFile(path, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, report: path, boardID }, null, 2))
}
