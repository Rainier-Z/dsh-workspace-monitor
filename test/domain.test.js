import assert from 'node:assert/strict'
import test from 'node:test'
import { getTasksTable, monitorDomainSpec, taskRecordSchema } from '../lib/domain.js'

function validRecord(overrides = {}) {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    title: 'Monitor',
    workspace: 'C:/workspace',
    intervalMs: 60_000,
    status: 'ACTIVE',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastRunAt: null,
    nextRunAt: null,
    baseline: [{ path: 'src/index.js', kind: 'file', size: 42, mtimeMs: 1_700_000_000_000 }],
    pauseReason: null,
    ...overrides,
  }
}

test('accepts a complete task record with a JSON snapshot baseline', () => {
  const result = taskRecordSchema.safeParse(validRecord())
  assert.equal(result.success, true)
})

test('accepts a null baseline and symlink snapshot entries', () => {
  const result = taskRecordSchema.safeParse(validRecord({
    status: 'PAUSED',
    pauseReason: 'manual',
    baseline: [{ path: 'linked', kind: 'symlink', size: 0, mtimeMs: 0 }],
  }))
  assert.equal(result.success, true)
  assert.equal(taskRecordSchema.safeParse(validRecord({ baseline: null })).success, true)
})

test('rejects a Map baseline, an illegal status, and an illegal snapshot entry', () => {
  assert.equal(taskRecordSchema.safeParse(validRecord({ baseline: new Map() })).success, false)
  assert.equal(taskRecordSchema.safeParse(validRecord({ status: 'RUNNING' })).success, false)
  assert.equal(taskRecordSchema.safeParse(validRecord({
    baseline: [{ path: 'a', kind: 'directory', size: 1, mtimeMs: 0 }],
  })).success, false)
})

test('rejects relative workspaces in persisted task records', () => {
  assert.equal(taskRecordSchema.safeParse(validRecord({ workspace: 'relative/workspace' })).success, false)
})

test('rejects extra record fields so the durable shape stays strict', () => {
  assert.equal(taskRecordSchema.safeParse(validRecord({ unexpected: true })).success, false)
})

test('declares the monitor tasks table and helper only resolves an existing domain table', () => {
  assert.equal(monitorDomainSpec.name, 'dsh_monitor')
  assert.equal(monitorDomainSpec.version, 1)
  assert.equal(monitorDomainSpec.layout, 'per-record')
  assert.deepEqual(Object.keys(monitorDomainSpec.tables), ['tasks'])

  let requested
  const table = {}
  const domain = { table(name) { requested = name; return table } }
  assert.equal(getTasksTable(domain), table)
  assert.equal(requested, 'tasks')
})
