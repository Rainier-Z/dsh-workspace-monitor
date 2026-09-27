import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_INTERVAL_MS, MemoryTaskTable, TaskStore } from '../lib/task-store.js'

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function task(workspace, overrides = {}) {
  const now = Date.now()
  return {
    taskId: overrides.taskId ?? 'task-1',
    agentId: overrides.agentId ?? 'agent-1',
    sessionId: overrides.sessionId ?? 'session-1',
    title: overrides.title ?? 'Workspace monitor',
    workspace,
    intervalMs: overrides.intervalMs ?? DEFAULT_INTERVAL_MS,
    status: overrides.status ?? 'ACTIVE',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastRunAt: overrides.lastRunAt ?? null,
    nextRunAt: overrides.nextRunAt ?? null,
    baseline: overrides.baseline ?? [],
    pauseReason: overrides.pauseReason ?? null,
  }
}

test('stores tasks through a table-like adapter and isolates returned values', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const store = new TaskStore(table)
  const original = task(root)

  const saved = await store.create(original)
  saved.title = 'caller mutation'

  assert.equal((await store.get('task-1')).title, 'Workspace monitor')
  assert.equal(table.size, 1)
  assert.deepEqual(await store.keys(), ['task-1'])
  assert.equal((await store.entries())[0][0], 'task-1')
})

test('rejects a missing or relative workspace and an interval below the lower bound', async (t) => {
  const root = await directory(t)
  const store = new TaskStore(new MemoryTaskTable())

  await assert.rejects(store.create(task(join(root, 'missing'))), /workspace.*exist/i)
  await assert.rejects(store.create(task('relative/path')), /workspace.*absolute/i)
  await assert.rejects(store.create(task(root, { intervalMs: 999 })), /interval/i)
})

test('keeps the old task when an adapter update fails', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const store = new TaskStore(table)
  await store.create(task(root))
  table.failUpdates = true

  await assert.rejects(store.update('task-1', { title: 'new title' }), /update failed/)
  assert.equal((await store.get('task-1')).title, 'Workspace monitor')
})

test('keeps persisted active tasks active on restart without changing baseline', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const first = new TaskStore(table)
  await first.create(task(root, { baseline: [{ path: 'file', kind: 'file', size: 4, mtimeMs: 4 }] }))

  const restarted = new TaskStore(table)
  const recovered = await restarted.get('task-1')

  assert.equal(recovered.status, 'ACTIVE')
  assert.equal(recovered.pauseReason, null)
  assert.deepEqual(recovered.baseline, [{ path: 'file', kind: 'file', size: 4, mtimeMs: 4 }])
})

test('allows a persisted paused task to remain paused across restart', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const first = new TaskStore(table)
  await first.create(task(root))
  await first.update('task-1', { status: 'PAUSED', pauseReason: 'manual' })

  const restarted = new TaskStore(table)
  const recovered = await restarted.get('task-1')
  assert.equal(recovered.status, 'PAUSED')
  assert.equal(recovered.pauseReason, 'manual')
})

test('normalizes legacy records while using updater functions for domain table updates', async (t) => {
  const root = await directory(t)
  const values = new Map()
  const table = {
    get: key => values.get(key),
    entries: () => values.entries(),
    keys: () => values.keys(),
    get size() { return values.size },
    async put(key, value) { values.set(key, structuredClone(value)) },
    async update(key, updater) {
      assert.equal(typeof updater, 'function')
      values.set(key, structuredClone(updater(structuredClone(values.get(key)))))
    },
    async delete(key) { return values.delete(key) },
  }
  const store = new TaskStore(table)
  await store.create({
    ...task(root),
    baseline: [{ path: 'file', kind: 'file', size: 7, mtimeMs: 7 }],
  })

  const restarted = new TaskStore(table)
  const recovered = await restarted.get('task-1')
  assert.equal(recovered.status, 'ACTIVE')
  assert.equal(recovered.pauseReason, null)
  assert.deepEqual(recovered.baseline, [{ path: 'file', kind: 'file', size: 7, mtimeMs: 7 }])
})

test('loads and deletes an active task even if its old workspace is gone', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const first = new TaskStore(table)
  await first.create(task(root))
  await rm(root, { recursive: true, force: true })

  const restarted = new TaskStore(table)
  const recovered = await restarted.get('task-1')
  assert.equal(recovered.status, 'ACTIVE')
  assert.equal(await restarted.delete('task-1'), true)
})

test('normalizes legacy pause reasons without overriding manual or unknown pauses', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const seeded = new TaskStore(table)
  await seeded.create(task(root, { taskId: 'restart', status: 'PAUSED', pauseReason: 'restart_requires_confirmation' }))
  await seeded.create(task(root, { taskId: 'disposed', status: 'PAUSED', pauseReason: 'agent_disposed' }))
  await seeded.create(task(root, { taskId: 'manual', status: 'PAUSED', pauseReason: 'manual' }))
  await seeded.create(task(root, { taskId: 'unknown', status: 'PAUSED', pauseReason: 'future_reason' }))

  const restarted = new TaskStore(table)
  const records = Object.fromEntries((await restarted.list()).map(value => [value.taskId, value]))
  assert.equal(records.restart.status, 'ACTIVE')
  assert.equal(records.restart.pauseReason, null)
  assert.equal(records.disposed.status, 'ACTIVE')
  assert.equal(records.disposed.pauseReason, null)
  assert.equal(records.manual.status, 'PAUSED')
  assert.equal(records.manual.pauseReason, 'manual')
  assert.equal(records.unknown.status, 'PAUSED')
  assert.equal(records.unknown.pauseReason, 'future_reason')
})

test('atomically records observations and only acknowledges the matching delivery revision', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const store = new TaskStore(table)
  await store.create(task(root))

  const first = await store.recordObservation('task-1', {
    baseline: [{ path: 'one', kind: 'file', size: 1, mtimeMs: 1 }],
    lastRunAt: 100,
    nextRunAt: 200,
    report: 'change A',
    observedAt: 101,
  }, 'session-1')
  assert.equal(first.pendingDelivery.revision, 1)
  assert.equal(first.pendingDelivery.count, 1)
  assert.equal(first.pendingDelivery.firstObservedAt, 101)
  assert.equal(first.pendingDelivery.lastObservedAt, 101)
  assert.equal(first.lastRunAt, 100)
  assert.deepEqual((await table.get('task-1')).baseline, first.baseline)

  const second = await store.recordObservation('task-1', {
    baseline: [{ path: 'two', kind: 'file', size: 2, mtimeMs: 2 }],
    report: 'change B',
    observedAt: 202,
  }, 'session-1')
  assert.equal(second.pendingDelivery.revision, 2)
  assert.equal(second.pendingDelivery.count, 2)
  assert.equal(second.pendingDelivery.firstObservedAt, 101)
  assert.equal(second.pendingDelivery.lastObservedAt, 202)
  assert.match(second.pendingDelivery.report, /change A/)
  assert.match(second.pendingDelivery.report, /change B/)

  const staleAck = await store.ackDelivery('task-1', 1, { deliveredAt: 250, messageId: 'msg-1' }, 'session-1')
  assert.equal(staleAck.acknowledged, false)
  assert.equal(staleAck.task.pendingDelivery.revision, 2)
  assert.equal(staleAck.task.lastDeliveredAt, null)

  const currentAck = await store.ackDelivery('task-1', 2, { deliveredAt: 300, messageId: 'msg-2' }, 'session-1')
  assert.equal(currentAck.acknowledged, true)
  assert.equal(currentAck.task.pendingDelivery, null)
  assert.equal(currentAck.task.lastDeliveredAt, 300)
  assert.equal(currentAck.task.lastDeliveryMessageId, 'msg-2')
})

test('observation and acknowledgement enforce the session when one is supplied', async (t) => {
  const root = await directory(t)
  const store = new TaskStore(new MemoryTaskTable())
  await store.create(task(root))

  await assert.rejects(store.recordObservation('task-1', { report: 'x' }, 'other-session'), /not found/i)
  await assert.rejects(store.ackDelivery('task-1', 1, {}, 'other-session'), /not found/i)
})

test('bounds merged pending reports and upgrades missing durable fields', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const legacy = task(root)
  delete legacy.pendingDelivery
  delete legacy.lastDeliveredAt
  delete legacy.lastDeliveryMessageId
  await table.put(legacy.taskId, legacy)

  const store = new TaskStore(table)
  const loaded = await store.get(legacy.taskId)
  assert.equal(loaded.pendingDelivery, null)
  assert.equal(loaded.lastDeliveredAt, null)
  assert.equal(loaded.lastDeliveryMessageId, null)
  const observed = await store.recordObservation(legacy.taskId, {
    report: 'A'.repeat(100), observedAt: 10, maxReportLength: 32,
  })
  const merged = await store.recordObservation(legacy.taskId, {
    report: 'B'.repeat(100), observedAt: 20, maxReportLength: 32,
  })
  assert.ok(merged.pendingDelivery.report.length <= 32)
  assert.equal(observed.pendingDelivery.firstObservedAt, 10)
})

test('merges an update against the adapter current value without losing an external change', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const store = new TaskStore(table)
  await store.create(task(root, { baseline: [{ path: 'file', kind: 'file', size: 1, mtimeMs: 1 }] }))
  await table.put('task-1', { ...(await store.get('task-1')), baseline: [{ path: 'file', kind: 'file', size: 2, mtimeMs: 2 }] })

  const updated = await store.update('task-1', { title: 'new title' })
  assert.equal(updated.title, 'new title')
  assert.deepEqual(updated.baseline, [{ path: 'file', kind: 'file', size: 2, mtimeMs: 2 }])
})

test('serializes concurrent creates for the same task id', async (t) => {
  const root = await directory(t)
  const store = new TaskStore(new MemoryTaskTable())
  const records = [task(root), task(root, { title: 'second' })]
  const results = await Promise.allSettled(records.map(record => store.create(record)))

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal((await store.list()).length, 1)
})

test('rejects unknown update fields and non-JSON baseline values', async (t) => {
  const root = await directory(t)
  const store = new TaskStore(new MemoryTaskTable())
  await store.create(task(root))

  await assert.rejects(store.update('task-1', { notAField: true }), /unknown.*field/i)
  await assert.rejects(store.update('task-1', { baseline: new Map() }), /baseline/i)
  assert.equal((await store.get('task-1')).title, 'Workspace monitor')
})
