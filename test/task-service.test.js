import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryTaskTable, TaskStore } from '../lib/task-store.js'
import { TaskService } from '../lib/task-service.js'

async function directory(t, name = 'dsh-task-service-') {
  const root = await mkdtemp(join(tmpdir(), name))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('creates tasks with a default interval and keeps sessions isolated', async (t) => {
  const root = await directory(t)
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })

  const first = await service.createTask({
    agentId: 'agent-a',
    sessionId: 'session-a',
    title: 'A',
    workspace: root,
  })
  const second = await service.createTask({
    agentId: 'agent-b',
    sessionId: 'session-b',
    title: 'B',
    workspace: root,
  })

  assert.equal(first.intervalMs, 60_000)
  assert.equal(first.status, 'ACTIVE')
  assert.equal((await service.listTasks('session-a')).length, 1)
  assert.equal((await service.listTasks('session-b'))[0]?.taskId, second.taskId)
  assert.equal((await service.listTasks('unknown')).length, 0)
})

test('updates task configuration and runtime fields while preserving baseline', async (t) => {
  const root = await directory(t)
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })
  const created = await service.createTask({ sessionId: 'session-a', workspace: root, baseline: [{ path: 'file', kind: 'file', size: 1, mtimeMs: 1 }] })

  const updated = await service.updateTask(created.taskId, { title: 'Renamed', intervalMs: 2_000 }, 'session-a')
  assert.equal(updated.title, 'Renamed')
  assert.equal(updated.intervalMs, 2_000)
  assert.deepEqual(updated.baseline, [{ path: 'file', kind: 'file', size: 1, mtimeMs: 1 }])

  const ran = await service.recordRun(created.taskId, {
    lastRunAt: 10,
    nextRunAt: 2_010,
    baseline: [{ path: 'file', kind: 'file', size: 2, mtimeMs: 2 }],
  }, 'session-a')
  assert.equal(ran.lastRunAt, 10)
  assert.equal(ran.nextRunAt, 2_010)
  assert.deepEqual(ran.baseline, [{ path: 'file', kind: 'file', size: 2, mtimeMs: 2 }])
})

test('supports pause, resume, delete and rejects cross-session mutations', async (t) => {
  const root = await directory(t)
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })
  const created = await service.createTask({ sessionId: 'owner', workspace: root })

  await assert.rejects(service.updateTask(created.taskId, { title: 'intruder' }, 'other'), /not found|session/i)
  const paused = await service.pauseTask(created.taskId, 'owner')
  assert.equal(paused.status, 'PAUSED')
  const resumed = await service.resumeTask(created.taskId, 'owner')
  assert.equal(resumed.status, 'ACTIVE')
  assert.equal(resumed.pauseReason, null)
  assert.equal(await service.deleteTask(created.taskId, 'other'), false)
  assert.equal(await service.deleteTask(created.taskId, 'owner'), true)
  assert.equal(await service.getTask(created.taskId, 'owner'), null)
})

test('new service recovers persisted active tasks as paused and retains baseline', async (t) => {
  const root = await directory(t)
  const table = new MemoryTaskTable()
  const first = new TaskService({ store: new TaskStore(table) })
  const created = await first.createTask({ sessionId: 'session-a', workspace: root, baseline: [{ path: 'file', kind: 'file', size: 3, mtimeMs: 3 }] })

  const restarted = new TaskService({ store: new TaskStore(table) })
  const recovered = await restarted.getTask(created.taskId, 'session-a')
  assert.equal(recovered.status, 'PAUSED')
  assert.equal(recovered.pauseReason, 'restart_requires_confirmation')
  assert.deepEqual(recovered.baseline, [{ path: 'file', kind: 'file', size: 3, mtimeMs: 3 }])
})

test('emits lifecycle events without coupling observers to storage', async (t) => {
  const root = await directory(t)
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })
  const events = []
  for (const name of ['created', 'updated', 'ran', 'paused', 'resumed', 'deleted']) {
    service.on(name, () => events.push(name))
  }
  const created = await service.createTask({ sessionId: 'session-a', workspace: root })
  await service.updateTask(created.taskId, { title: 'renamed' }, 'session-a')
  await service.recordRun(created.taskId, { lastRunAt: 1 }, 'session-a')
  await service.pauseTask(created.taskId, 'session-a')
  await service.resumeTask(created.taskId, 'session-a')
  await service.deleteTask(created.taskId, 'session-a')

  assert.deepEqual(events, ['created', 'updated', 'ran', 'paused', 'resumed', 'deleted'])
})

test('resume validates the workspace and leaves a paused task unchanged when it is gone', async (t) => {
  const root = await directory(t)
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })
  const created = await service.createTask({ sessionId: 'session-a', workspace: root, baseline: [{ path: 'file', kind: 'file', size: 1, mtimeMs: 1 }] })
  await service.pauseTask(created.taskId, 'session-a')
  await rm(root, { recursive: true, force: true })

  await assert.rejects(service.resumeTask(created.taskId, 'session-a'), /workspace.*exist/i)
  const unchanged = await service.getTask(created.taskId, 'session-a')
  assert.equal(unchanged.status, 'PAUSED')
  assert.equal(unchanged.pauseReason, 'manual')
})

test('absorbs rejected async lifecycle listeners and reports them through the observer hook', async (t) => {
  const root = await directory(t)
  const observerErrors = []
  const service = new TaskService({
    store: new TaskStore(new MemoryTaskTable()),
    onObserverError(error) { observerErrors.push(error) },
  })
  service.on('created', async () => { throw new Error('listener failed') })
  await service.createTask({ sessionId: 'session-a', workspace: root })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(observerErrors.length, 1)
  assert.match(observerErrors[0].message, /listener failed/)
})
