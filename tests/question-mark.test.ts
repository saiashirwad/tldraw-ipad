import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmedQuestionMark, findQuestionMarks, type InkStroke } from '../src/question-mark'

const hook = (id = 'hook', x = 0, scale = 1): InkStroke => ({
  id, bounds: { x, y: 0, w: 30 * scale, h: 60 * scale },
  points: [[0, 10], [10, 0], [25, 5], [30, 15], [25, 30], [15, 40], [15, 60]]
    .map(([px, py]) => ({ x: x + px * scale, y: py * scale })),
})
const dot = (id = 'dot', x = 0, scale = 1): InkStroke => ({
  id, bounds: { x: x + 14 * scale, y: 72 * scale, w: 2 * scale, h: 2 * scale },
  points: [{ x: x + 14 * scale, y: 72 * scale }],
})

test('a separate hook and dot produce one complete question marker in either drawing direction', () => {
  const strokes = [hook(), dot()]
  const expected = [{ ids: ['hook', 'dot'], bounds: { x: 0, y: 0, w: 30, h: 74 } }]
  assert.deepEqual(findQuestionMarks(strokes, new Set(['dot']), 1), expected)
  assert.deepEqual(findQuestionMarks([{ ...hook(), points: hook().points.reverse() }, dot()], new Set(['hook']), 1), expected)
  assert.deepEqual(findQuestionMarks([hook()], new Set(['hook']), 1), [])
})

test('lines, tiny hooks, displaced dots and oversized second strokes do not qualify', () => {
  const line = { ...hook(), points: hook().points.map((point) => ({ ...point, x: 15 })) }
  const cases = [
    [line, dot()],
    [hook('hook', 0, .1), dot('dot', 0, .1)],
    [hook(), { ...dot(), bounds: { x: 100, y: 72, w: 2, h: 2 } }],
    [hook(), { ...dot(), bounds: { x: 14, y: 200, w: 2, h: 2 } }],
    [hook(), { ...dot(), bounds: { x: 14, y: 72, w: 40, h: 2 } }],
  ]
  for (const strokes of cases) assert.deepEqual(findQuestionMarks(strokes, new Set(['hook', 'dot']), 1), [])
})

test('question eligibility follows visible size at the current zoom', () => {
  const strokes = [hook('hook', 0, .1), dot('dot', 0, .1)]
  assert.equal(findQuestionMarks(strokes, new Set(['dot']), 2).length, 1)
  assert.deepEqual(findQuestionMarks(strokes, new Set(['dot']), 1), [])
})

test('only changed markers qualify and the latest completed marker is offered first', () => {
  const strokes = [hook('old-hook'), dot('old-dot'), hook('new-hook', 200), dot('new-dot', 200)]
  assert.deepEqual(findQuestionMarks(strokes, new Set(), 1), [])
  assert.deepEqual(findQuestionMarks(strokes, new Set(['new-dot']), 1).map((candidate) => candidate.ids), [['new-hook', 'new-dot']])
  assert.deepEqual(findQuestionMarks(strokes, new Set(['old-dot', 'new-dot']), 1).map((candidate) => candidate.ids),
    [['new-hook', 'new-dot'], ['old-hook', 'old-dot']])
})

test('recognition accepts only an unambiguous YES response', () => {
  assert.equal(confirmedQuestionMark('YES'), true)
  assert.equal(confirmedQuestionMark('  YES\n'), true)
  for (const reply of ['NO', '', 'yes', 'YES.', 'YES, it is a question mark', 'Yesterday', 'NO\nYES']) {
    assert.equal(confirmedQuestionMark(reply), false, reply)
  }
})
