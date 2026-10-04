import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClientIdentity } from '../src/runtime'
import { createRun } from '../scripts/verification/report'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { matchingView } from '../scripts/verification/device'
import type { Status } from '../scripts/verification/session'

test('client readiness rejects invalid shape IDs and malformed identity', () => {
  const identity = { instanceId: 'server', buildId: 'bundle', loadId: 'document', sessionId: 'test', synced: true, shapeIds: ['shape:ink'], penUp: 1 }
  assert.deepEqual(parseClientIdentity(identity), identity)
  for (const change of [{ shapeIds: ['asset:one'] }, { shapeIds: Array(257).fill('shape:ink') }, { penUp: -1 },
    { synced: 'yes' }, { sessionId: {} }, { loadId: null }]) assert.equal(parseClientIdentity({ ...identity, ...change }), null)
  assert.equal(parseClientIdentity(null), null)
})

test('failed checkpoint preserves a bounded expected/actual report', async () => {
  const run = await createRun('failure-report-contract', 'browser')
  await assert.rejects(run.check('intentional mismatch', () => assert.equal('observed', 'required')))
  const report = JSON.parse(await readFile(resolve(run.dir, 'report.json'), 'utf8'))
  assert.equal(report.status, 'failed')
  assert.equal(report.checkpoints[0].expected, '"required"')
  assert.equal(report.checkpoints[0].actual, '"observed"')
})

test('device readiness rejects stale bundles, instances, tokens, loads and offline editors', () => {
  const client = { instanceId: 'server', buildId: 'bundle', loadId: 'new', sessionId: 'session', synced: true, shapeIds: [], penUp: 0 }
  const view = { pageId: 'page:one', bounds: { x: 0, y: 0, w: 100, h: 100 }, updatedAt: 200, source: 'ipad' as const, client }
  const status: Status = { instanceId: 'server', buildId: 'bundle', mode: 'verification', verificationSession: 'session',
    revision: 1, clients: 1, view, clientViews: [view] }
  assert.equal(matchingView(status, 'session', 100, 'old'), view)
  for (const change of [{ instanceId: 'old' }, { buildId: 'old' }, { sessionId: 'other' }, { synced: false }, { loadId: 'old' }]) {
    assert.equal(matchingView({ ...status, clientViews: [{ ...view, client: { ...client, ...change } }] }, 'session', 100, 'old'), undefined)
  }
  assert.equal(matchingView(status, 'session', 201), undefined)
  assert.equal(matchingView({ ...status, clientViews: [{ ...view, source: 'browser' }] }, 'session', 100), undefined)
})
