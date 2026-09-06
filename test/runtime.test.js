import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Delivery } from '../lib/delivery.js'
import { MonitorRuntime, deserializeSnapshot, serializeSnapshot } from '../lib/runtime.js'
import { MemoryTaskTable, TaskStore } from '../lib/task-store.js'
import { TaskService } from '../lib/task-service.js'

class FakeClock {
  now = 0
  timers = []
  setTimeout = (callback, delay) => {
    const timer = { at: this.now + delay, callback, cancelled: false }
    this.timers.push(timer)
    return timer
  }
  clearTimeout = (timer) => { if (timer) timer.cancelled = true }
  async advance(ms) {
    const target = this.now + ms
    while (true) {
      const next = this.timers.filter(timer => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.timers = this.timers.filter(timer => timer !== next)
      this.now = next.at
      next.callback()
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    }
    this.now = target
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  }
}

async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve))
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })
  const clock = new FakeClock()
  const reports = []
  const delivery = new Delivery({ deliver: async (agent, report, meta) => { reports.push({ agent, report, meta }) } })
  const owner = { id: 'session-a', session: { header: { cwd: root } } }
  const runtime = new MonitorRuntime({
    service,
    delivery,
    getAgent: id => id === owner.id ? owner : undefined,
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  t.after(() => runtime.dispose())
  return { root, service, clock, reports, owner, runtime }
}

test('create establishes a silent serialized baseline and schedules the next absolute run', async (t) => {
  const { root, service, owner, runtime } = await setup(t)
  await writeFile(join(root, 'before.txt'), 'before')
  const task = await runtime.createTask({ agent: owner, workspace: '.', intervalMs: 1_000, title: 'Project files' })

  assert.equal(task.workspace, root)
  assert.equal(task.intervalMs, 1_000)
  assert.equal(task.nextRunAt, 1_000)
  assert.ok(Array.isArray(task.baseline))
  assert.deepEqual(deserializeSnapshot(task.baseline).get('before.txt').kind, 'file')
  assert.equal((await service.getTask(task.taskId, owner.id)).baseline instanceof Map, false)
})

test('create uses a validated constructor default interval when omitted', async (t) => {
  const { root, service, owner, clock, delivery } = await setup(t)
  const runtime = new MonitorRuntime({
    service,
    delivery,
    getAgent: id => id === owner.id ? owner : undefined,
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    defaultIntervalMs: 2_000,
  })
  t.after(() => runtime.dispose())

  const task = await runtime.createTask({ agent: owner, workspace: root })
  assert.equal(task.intervalMs, 2_000)
  assert.equal(task.nextRunAt, 2_000)
})

test('constructor rejects an invalid default interval', async () => {
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })
  for (const defaultIntervalMs of [999, 1_000.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.throws(() => new MonitorRuntime({ service, defaultIntervalMs }), /defaultIntervalMs/)
  }
})

test('update during an in-flight and queued run keeps the new cadence alive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new TaskService({ store: new TaskStore(new MemoryTaskTable()) })
  const clock = new FakeClock()
  const owner = { id: 'session-race', session: { header: { cwd: root } } }
  const delivery = new Delivery({ deliver: async () => {} })
  let scans = 0
  let releaseInFlight
  let releaseQueued
  const scan = async scanRoot => {
    scans += 1
    if (scans === 2) await new Promise(resolve => { releaseInFlight = resolve })
    if (scans === 3) await new Promise(resolve => { releaseQueued = resolve })
    return { root: scanRoot, snapshot: new Map(), warnings: [], visitedEntries: 0 }
  }
  const runtime = new MonitorRuntime({
    service,
    delivery,
    getAgent: id => id === owner.id ? owner : undefined,
    scanWorkspace: scan,
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  t.after(async () => {
    releaseInFlight?.()
    releaseQueued?.()
    await runtime.dispose()
  })

  const task = await runtime.createTask({ agent: owner, workspace: '.', intervalMs: 1_000 })
  const inFlight = runtime.runOnce(task.taskId, { scheduledAt: 500, task: { nextRunAt: 1_000 } })
  for (let i = 0; i < 12 && !releaseInFlight; i += 1) await new Promise(resolve => setImmediate(resolve))
  await clock.advance(1_000)
  const update = runtime.updateTask(task.taskId, { intervalMs: 2_000 }, owner)
  releaseInFlight()
  for (let i = 0; i < 12 && !releaseQueued; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.ok(releaseQueued)
  releaseQueued()
  await inFlight
  const updated = await update
  assert.equal(updated.nextRunAt, 3_000)

  await clock.advance(2_000)
  assert.equal(scans, 4)
})

test('each scheduled cycle reports unchanged state and only then advances the baseline', async (t) => {
  const { root, service, clock, reports, owner, runtime } = await setup(t)
  const task = await runtime.createTask({ agent: owner, workspace: root, intervalMs: 1_000 })
  await runtime.runOnce(task.taskId, { scheduledAt: 1_000, task: { nextRunAt: 2_000 } })
  assert.equal(reports.length, 1)
  assert.match(reports[0].report, /本轮未发现文件变化/)
  assert.equal((await service.getTask(task.taskId, owner.id)).lastRunAt, 1_000)

  await writeFile(join(root, 'after.txt'), 'after')
  await runtime.runOnce(task.taskId, { scheduledAt: 2_000, task: { nextRunAt: 3_000 } })
  assert.equal(reports.length, 2)
  assert.match(reports[1].report, /新增 after\.txt/)
  const saved = await service.getTask(task.taskId, owner.id)
  assert.ok(deserializeSnapshot(saved.baseline).has('after.txt'))
})

test('failed update leaves the old task and scheduler untouched', async (t) => {
  const { root, service, clock, owner, runtime } = await setup(t)
  const task = await runtime.createTask({ agent: owner, workspace: root, intervalMs: 1_000 })
  await assert.rejects(runtime.updateTask(task.taskId, { workspace: join(root, 'missing'), intervalMs: 2_000 }, owner), /exist|directory/i)
  const saved = await service.getTask(task.taskId, owner.id)
  assert.equal(saved.workspace, root)
  assert.equal(saved.intervalMs, 1_000)
  assert.equal(runtime.scheduler.get(task.taskId).nextRunAt, 1_000)
  await clock.advance(1_000)
})

test('interval and title updates preserve the established baseline', async (t) => {
  const { root, service, owner, runtime } = await setup(t)
  await writeFile(join(root, 'baseline.txt'), 'baseline')
  const created = await runtime.createTask({ agent: owner, workspace: root, intervalMs: 1_000 })
  const before = await service.getTask(created.taskId, owner.id)
  const updated = await runtime.updateTask(created.taskId, { intervalMs: 2_000, title: 'Renamed' }, owner)
  assert.equal(updated.title, 'Renamed')
  assert.equal(updated.intervalMs, 2_000)
  assert.deepEqual(updated.baseline, before.baseline)
})

test('pause cancels delivery and resume performs an immediate catch-up', async (t) => {
  const { root, clock, reports, owner, runtime } = await setup(t)
  const task = await runtime.createTask({ agent: owner, workspace: root, intervalMs: 1_000 })
  await runtime.pauseTask(task.taskId, owner)
  await clock.advance(2_000)
  assert.equal(reports.length, 0)
  await runtime.resumeTask(task.taskId, owner)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(reports.length, 1)
  assert.match(reports[0].report, /本轮未发现文件变化/)
  assert.equal(await runtime.deleteTask(task.taskId, owner), true)
  assert.equal(runtime.scheduler.get(task.taskId), undefined)
})

test('pause accepts and persists an explicit reason', async (t) => {
  const { service, owner, runtime } = await setup(t)
  const task = await runtime.createTask({ agent: owner, workspace: owner.session.header.cwd, intervalMs: 1_000 })

  const paused = await runtime.pauseTask(task.taskId, owner, 'agent_disposed')

  assert.equal(paused.status, 'PAUSED')
  assert.equal(paused.pauseReason, 'agent_disposed')
  assert.equal((await service.getTask(task.taskId, owner.id)).pauseReason, 'agent_disposed')
})

test('unreadable scan retains the prior baseline until the path recovers', async (t) => {
  const { service, owner, runtime } = await setup(t)
  let readable = true
  const scan = async root => ({
    root,
    snapshot: readable
      ? new Map([['private/secret.txt', Object.freeze({ kind: 'file', size: 1, mtimeMs: 0 })]])
      : Object.assign(new Map(), { unreadablePrefixes: Object.freeze(['private']) }),
    unreadablePrefixes: readable ? Object.freeze([]) : Object.freeze(['private']),
    warnings: readable ? Object.freeze([]) : Object.freeze(['private: access denied']),
    visitedEntries: 1,
  })
  const reports = []
  const reportingRuntime = new MonitorRuntime({
    service,
    delivery: new Delivery({ deliver: async (_agent, report) => reports.push(report) }),
    getAgent: id => id === owner.id ? owner : undefined,
    scanWorkspace: scan,
    clock: () => 0,
    setTimeout: () => undefined,
    clearTimeout: () => {},
  })
  t.after(() => reportingRuntime.dispose())
  const task = await reportingRuntime.createTask({ agent: owner, workspace: owner.session.header.cwd, intervalMs: 1_000 })

  readable = false
  await reportingRuntime.runOnce(task.taskId, { scheduledAt: 1_000, task: { nextRunAt: 2_000 } })
  const unreadableBaseline = deserializeSnapshot((await service.getTask(task.taskId, owner.id)).baseline)
  assert.deepEqual([...unreadableBaseline.keys()], ['private/secret.txt'])
  assert.match(reports.at(-1), /扫描警告：1/)

  readable = true
  await reportingRuntime.runOnce(task.taskId, { scheduledAt: 2_000, task: { nextRunAt: 3_000 } })
  assert.match(reports.at(-1), /本轮未发现文件变化/)
  assert.doesNotMatch(reports.at(-1), /新增 private\/secret\.txt/)
})

test('snapshot serialization round-trips a scanner Map without leaking Map into persistence', () => {
  const snapshot = new Map([['a.txt', Object.freeze({ kind: 'file', size: 1, mtimeMs: 2 })]])
  const encoded = serializeSnapshot(snapshot)
  assert.ok(Array.isArray(encoded))
  assert.deepEqual([...deserializeSnapshot(encoded)], [...snapshot])
})
