import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { command, root, type Run, type Session, until, type Status } from './session'
import type { PhysicalInstructionStep } from '../../src/runtime'

type Device = { id: string; name: string; udid: string; type: string; connected: boolean }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected devicectl JSON')
  return Object.fromEntries(Object.entries(value))
}

export async function selectDevice(run: Run, selected?: string): Promise<Device> {
  const path = resolve(run.dir, 'devices.json')
  await command(run, 'devices', 'xcrun', ['devicectl', 'list', 'devices', '--json-output', path])
  const result = object(object(JSON.parse(await readFile(path, 'utf8'))).result)
  if (!Array.isArray(result.devices)) throw new Error('devicectl did not list devices')
  const devices = result.devices.map((row: unknown) => {
    const item = object(row), properties = object(item.properties)
    const hardware = object(properties.hardware), state = object(properties.state), connection = object(properties.connection)
    return { id: String(item.identifier), name: String(state.name), udid: String(hardware.udid),
      type: String(hardware.deviceType), connected: connection.state === 'connected' }
  }).filter((device) => device.type === 'iPad' && device.connected)
  const matches = selected ? devices.filter((device) => [device.id, device.udid, device.name].includes(selected)) : devices
  if (matches.length !== 1) throw new Error(`Choose one connected iPad with --device. Found ${matches.map((device) => device.name).join(', ') || 'none'}`)
  run.report.deviceId = matches[0].id
  return matches[0]
}

export function lanHost(explicit?: string) {
  if (explicit) {
    if (!/^[a-zA-Z0-9.-]+$/.test(explicit) || explicit === 'localhost' || explicit.startsWith('127.')) throw new Error('Use a LAN address for --host')
    return explicit
  }
  const addresses = Object.entries(networkInterfaces()).filter(([name]) => name.startsWith('en')).flatMap(([, entries]) =>
    (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')).map((entry) => entry.address))
  if (addresses.length !== 1) throw new Error(`Choose the iPad-reachable Mac address with --host. Found ${addresses.join(', ') || 'none'}`)
  return addresses[0]
}

export async function installHost(run: Run, device: Device, force = false) {
  const hash = createHash('sha256')
  for (const name of ['ipad/Canvas.swift', 'ipad/Info.plist', 'ipad/Canvas.xcodeproj/project.pbxproj']) hash.update(await readFile(resolve(root, name)))
  const fingerprint = hash.digest('hex')
  const stamp = resolve(root, 'ipad/build/installed.json')
  let installed: unknown = null
  try { installed = JSON.parse(await readFile(stamp, 'utf8')) } catch {}
  if (!force && installed && typeof installed === 'object' && 'fingerprint' in installed && installed.fingerprint === fingerprint &&
    'deviceId' in installed && installed.deviceId === device.id) return
  await command(run, 'native-install', 'bash', [resolve(root, 'scripts/run-ipad.sh'), device.udid, 'http://home.local:4789', '--install-only'])
  await mkdir(resolve(root, 'ipad/build'), { recursive: true })
  await writeFile(stamp, JSON.stringify({ fingerprint, deviceId: device.id }))
}

export function matchingView(status: Status, sessionId: string, launchedAt: number, previousLoad?: string) {
  return status.clientViews.find((view) => view.source === 'ipad' && view.updatedAt >= launchedAt &&
    view.client?.instanceId === status.instanceId && view.client.buildId === status.buildId &&
    view.client.sessionId === sessionId && view.client.synced && view.client.loadId !== previousLoad)
}

export async function launchDevice(run: Run, session: Session, device: Device, host: string, previousLoad?: string) {
  const url = `http://${host}:${session.port}/?verify=${run.report.runId}`
  const launchedAt = Date.now()
  await command(run, 'native-launch', 'xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.id,
    '--terminate-existing', 'in.texoport.tldrawipad', '--verification-url', url])
  const status = await until(session.status, (status) => !!matchingView(status, run.report.runId, launchedAt, previousLoad),
    'iPad did not load this session and bundle. Check the device is unlocked and on the Mac network.', 45000)
  return matchingView(status, run.report.runId, launchedAt, previousLoad)!
}

export async function captureDevice(run: Run, session: Session, device: Device, name: string) {
  const image = resolve(run.dir, `${name}-device.png`)
  await command(run, `${name}-device`, 'xcrun', ['devicectl', 'device', 'capture', 'screenshot', '--device', device.id, '--destination', image])
  run.report.artifacts[`${name}-device`] = image
  const capture = await session.cli<{ image: string }>('capture', '--output', resolve(run.dir, `${name}-canvas.png`))
  run.report.artifacts[`${name}-canvas`] = capture.image
  const statusFile = resolve(run.dir, `${name}-status.json`)
  await writeFile(statusFile, JSON.stringify(await session.status(), null, 2))
  run.report.artifacts[`${name}-status`] = statusFile
  await session.backup()
  await run.save()
}

const physicalInstructions = {
  draw: 'Pencil check. Draw one stroke below, then lift the Pencil.\nWait for this instruction to change before tapping Undo.',
  undo: 'Stroke received. Tap Undo until your test stroke disappears.\nThe check will then close this scratch board automatically.',
  pan: 'Gesture check. Pan with one finger. Do not draw.\nWait for this instruction to change before pinching.',
  zoom: 'Pan received. Pinch to zoom. Do not draw.\nThe check will then close this scratch board automatically.',
  complete: 'Check complete. You can stop interacting.\nReturning to your normal board.',
  ended: 'Check ended. You can stop interacting.\nReturning to your normal board. The report records the result.',
} satisfies Record<PhysicalInstructionStep, string>

export async function showPhysicalInstruction(run: Run, session: Session, step: keyof typeof physicalInstructions) {
  const before = await session.status()
  const view = before.view
  const visibleClient = view?.client
  const waitForClient = view && Date.now() - view.updatedAt < 15000 && visibleClient?.instanceId === before.instanceId &&
    visibleClient.buildId === before.buildId && visibleClient.sessionId === run.report.runId && visibleClient.synced
  const scale = Math.min(1, (view?.bounds.w ?? 680) / 680)
  const file = resolve(run.dir, 'instruction.json')
  await writeFile(file, JSON.stringify([{ id: 'shape:physical-instruction', type: 'text',
    x: (view?.bounds.x ?? 0) + 40 * scale, y: (view?.bounds.y ?? 0) + 40 * scale, text: physicalInstructions[step],
    meta: { verificationInstruction: step },
    props: { w: 600, scale, autoSize: false, size: 's', font: 'sans', color: 'grey' } }]))
  const updatedAt = Date.now()
  await session.cli('draw', file)
  if (waitForClient) {
    await until(session.status, (status) => status.instanceId === before.instanceId && status.buildId === before.buildId &&
      !!status.view && status.view.updatedAt >= updatedAt && status.view.client?.loadId === visibleClient.loadId &&
      status.view.client.instanceId === status.instanceId && status.view.client.buildId === status.buildId &&
      status.view.client.sessionId === run.report.runId && status.view.client.synced && status.view.client.instructionStep === step,
      `Visible client did not acknowledge the ${step} instruction`)
  }
}
