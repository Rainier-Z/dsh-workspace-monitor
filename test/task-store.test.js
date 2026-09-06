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

test('pauses persisted active tasks on restart without changing baseline', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const first = new TaskStore(table)
  await first.create(task(root, { baseline: [{ path: 'file', kind: 'file', size: 4, mtimeMs: 4 }] }))

  const restarted = new TaskStore(table)
  const recovered = await restarted.get('task-1')

  assert.equal(recovered.status, 'PAUSED')
  assert.equal(recovered.pauseReason, 'restart_requires_confirmation')
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

test('uses updater functions for domain table updates', async (t) => {
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
  assert.equal(recovered.status, 'PAUSED')
  assert.equal(recovered.pauseReason, 'restart_requires_confirmation')
  assert.deepEqual(recovered.baseline, [{ path: 'file', kind: 'file', size: 7, mtimeMs: 7 }])
})

test('recovers and deletes a task even if its old workspace is gone', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const first = new TaskStore(table)
  await first.create(task(root))
  await rm(root, { recursive: true, force: true })

  const restarted = new TaskStore(table)
  const recovered = await restarted.get('task-1')
  assert.equal(recovered.status, 'PAUSED')
  assert.equal(await restarted.delete('task-1'), true)
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
