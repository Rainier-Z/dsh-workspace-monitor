import assert from 'node:assert/strict'
import test from 'node:test'
import { Scheduler } from '../lib/scheduler.js'

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
      const next = this.timers
        .filter(timer => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at)[0]
      if (!next) break
      this.timers = this.timers.filter(timer => timer !== next)
      this.now = next.at
      next.callback()
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    }
    this.now = target
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  }

  pending() { return this.timers.filter(timer => !timer.cancelled) }
}

test('schedules multiple tasks with absolute fixed-rate times', async (t) => {
  const clock = new FakeClock()
  const runs = []
  const scheduler = new Scheduler({
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runTask: async (taskId, context) => { runs.push({ taskId, ...context }) },
  })
  t.after(() => scheduler.dispose())

  scheduler.schedule('one', { intervalMs: 1_000, nextRunAt: 1_000 })
  scheduler.schedule('two', { intervalMs: 2_500, nextRunAt: 2_500 })
  await clock.advance(2_500)

  assert.deepEqual(runs.map(run => [run.taskId, run.scheduledAt]), [
    ['one', 1_000],
    ['one', 2_000],
    ['two', 2_500],
  ])
  assert.equal(scheduler.get('one').nextRunAt, 3_000)
  assert.equal(scheduler.get('two').nextRunAt, 5_000)
})

test('reschedule invalidates the old timer and pause cancels future runs', async (t) => {
  const clock = new FakeClock()
  const runs = []
  const scheduler = new Scheduler({
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runTask: async (taskId, context) => { runs.push({ taskId, ...context }) },
  })
  t.after(() => scheduler.dispose())

  scheduler.schedule('task', { intervalMs: 1_000, nextRunAt: 1_000 })
  scheduler.reschedule('task', { intervalMs: 3_000, nextRunAt: 3_000 })
  await clock.advance(2_500)
  assert.deepEqual(runs, [])
  await clock.advance(500)
  assert.deepEqual(runs.map(run => run.scheduledAt), [3_000])

  scheduler.pause('task')
  await clock.advance(1_000)
  assert.deepEqual(runs.map(run => run.scheduledAt), [3_000])
  assert.equal(scheduler.get('task').status, 'PAUSED')
})

test('reschedule while running arms only the new absolute timer', async (t) => {
  const clock = new FakeClock()
  const resolvers = []
  const starts = []
  const scheduler = new Scheduler({
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runTask: (taskId, context) => {
      starts.push({ taskId, ...context })
      return new Promise(resolve => resolvers.push(resolve))
    },
  })
  t.after(async () => {
    for (const resolve of resolvers.splice(0)) resolve()
    await scheduler.dispose()
  })

  scheduler.schedule('task', { intervalMs: 1_000, nextRunAt: 1_000 })
  await clock.advance(1_000)
  assert.equal(scheduler.get('task').running, true)

  scheduler.reschedule('task', { intervalMs: 2_000, nextRunAt: 3_000 })
  assert.deepEqual(clock.pending().map(timer => timer.at), [3_000])
  resolvers.shift()()
  await clock.advance(1_000)
  assert.deepEqual(starts.map(run => run.scheduledAt), [1_000])

  await clock.advance(1_000)
  assert.deepEqual(starts.map(run => run.scheduledAt), [1_000, 3_000])
  assert.equal(scheduler.get('task').running, true)
  resolvers.shift()()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
})

test('never runs the same task concurrently and resume performs catch-up first', async (t) => {
  const clock = new FakeClock()
  const resolvers = []
  const starts = []
  let active = 0
  let maxActive = 0
  const scheduler = new Scheduler({
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runTask: (taskId, context) => {
      starts.push({ taskId, ...context })
      active += 1
      maxActive = Math.max(maxActive, active)
      return new Promise(resolve => resolvers.push(() => { active -= 1; resolve() }))
    },
  })
  t.after(() => scheduler.dispose())

  scheduler.schedule('task', { intervalMs: 1_000, nextRunAt: 1_000 })
  await clock.advance(1_000)
  await clock.advance(1_000)
  assert.equal(starts.length, 1)
  assert.equal(maxActive, 1)
  resolvers.shift()()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  assert.equal(starts.length, 2)
  resolvers.shift()()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()

  scheduler.pause('task')
  clock.now = 5_500
  scheduler.resume('task')
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  assert.equal(starts.at(-1).catchUp, true)
  assert.equal(starts.at(-1).scheduledAt, 5_500)
  assert.equal(scheduler.get('task').nextRunAt, 6_500)
  resolvers.shift()()
  await Promise.resolve()
})

test('stale run failures do not report after reschedule and async error observers are contained', async (t) => {
  const clock = new FakeClock()
  let rejectRun
  const errors = []
  const scheduler = new Scheduler({
    clock: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runTask: () => new Promise((_, reject) => { rejectRun = reject }),
    onError: async error => { errors.push(error.message); throw new Error('observer failed') },
  })
  t.after(() => scheduler.dispose())

  scheduler.schedule('task', { intervalMs: 1_000, nextRunAt: 1_000 })
  await clock.advance(1_000)
  scheduler.reschedule('task', { intervalMs: 1_000, nextRunAt: 3_000 })
  rejectRun(new Error('stale failure'))
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  assert.deepEqual(errors, [])
})
