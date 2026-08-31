import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMonitorCommand, resolveTargetWorkspace } from '../lib/controller.js'

test('empty input means status', () => {
  assert.deepEqual(parseMonitorCommand(''), { kind: 'status' })
  assert.deepEqual(parseMonitorCommand('   '), { kind: 'status' })
})

test('start with explicit target', () => {
  assert.deepEqual(parseMonitorCommand('start C:\\work\\discussion'), { kind: 'start', target: 'C:\\work\\discussion' })
})

test('start without target yields undefined', () => {
  assert.deepEqual(parseMonitorCommand('start'), { kind: 'start', target: undefined })
})

test('stop and status', () => {
  assert.deepEqual(parseMonitorCommand('stop'), { kind: 'stop' })
  assert.deepEqual(parseMonitorCommand('status'), { kind: 'status' })
})

test('unknown subcommand returns error', () => {
  const r = parseMonitorCommand('bogus thing')
  assert.equal(r.kind, 'error')
  assert.match(r.text, /Unknown \/monitor subcommand/)
})

test('resolveTargetWorkspace prefers explicit target', () => {
  assert.equal(resolveTargetWorkspace('C:\\work\\discussion', 'D:\\session'), 'C:\\work\\discussion')
})

test('resolveTargetWorkspace falls back to session cwd', () => {
  assert.equal(resolveTargetWorkspace(undefined, 'D:\\session'), 'D:\\session')
  assert.equal(resolveTargetWorkspace('   ', 'D:\\session'), 'D:\\session')
})
