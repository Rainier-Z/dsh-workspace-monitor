import assert from 'node:assert/strict'
import test from 'node:test'
import { Delivery } from '../lib/delivery.js'

test('delivers every idle report, including unchanged reports', async () => {
  const delivered = []
  const delivery = new Delivery({
    deliver: async (agent, report) => { delivered.push([agent, report]) },
    isBusy: () => false,
  })

  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', 'unchanged-1')
  await delivery.enqueue('task-a', 'unchanged-2')

  assert.deepEqual(delivered, [
    ['agent-a', 'unchanged-1'],
    ['agent-a', 'unchanged-2'],
  ])
})

test('merges busy reports to one bounded pending summary and flushes once idle', async () => {
  let busy = true
  let resolveIdle
  const delivered = []
  const delivery = new Delivery({
    deliver: async (agent, report) => { delivered.push([agent, report]) },
    isBusy: () => busy,
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve }),
    maxReportLength: 80,
  })

  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', 'report-1')
  await delivery.enqueue('task-a', 'report-2')
  await delivery.enqueue('task-a', 'report-3')
  assert.equal(delivery.pendingCount('task-a'), 1)
  assert.equal(delivered.length, 0)

  busy = false
  resolveIdle()
  await delivery.flush()
  assert.equal(delivered.length, 1)
  assert.match(delivered[0][1], /3 reports merged/)
  assert.ok(delivered[0][1].length <= 80)
  assert.equal(delivery.pendingCount('task-a'), 0)
})

test('default busy merge retains the earlier change and the latest report', async () => {
  let busy = true
  let resolveIdle
  const delivered = []
  const delivery = new Delivery({
    deliver: async (_agent, report, meta) => { delivered.push([report, meta]) },
    isBusy: () => busy,
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve }),
    maxReportLength: 120,
  })

  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', '新增 important.txt')
  await delivery.enqueue('task-a', '未变化')

  busy = false
  resolveIdle()
  await delivery.flush()

  assert.equal(delivered[0][1].count, 2)
  assert.match(delivered[0][0], /新增 important\.txt/)
  assert.match(delivered[0][0], /未变化/)
  assert.ok(delivered[0][0].length <= 120)
})

test('repeated unchanged reports do not swallow an earlier important change', async () => {
  let busy = true
  let resolveIdle
  const delivered = []
  const delivery = new Delivery({
    deliver: async (_agent, report, meta) => { delivered.push([report, meta]) },
    isBusy: () => busy,
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve }),
    maxReportLength: 80,
  })

  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', '新增 important.txt')
  await delivery.enqueue('task-a', '未变化')
  await delivery.enqueue('task-a', '未变化')
  await delivery.enqueue('task-a', '未变化')
  await delivery.enqueue('task-a', '未变化')

  busy = false
  resolveIdle()
  await delivery.flush()

  assert.equal(delivered[0][1].count, 5)
  assert.match(delivered[0][0], /新增 important\.txt/)
  assert.match(delivered[0][0], /未变化/)
  assert.ok(delivered[0][0].length <= 80)
})

test('pending reports can be cancelled when a task is paused or deleted', async () => {
  const delivery = new Delivery({
    deliver: async () => { throw new Error('should not deliver') },
    isBusy: () => true,
    whenIdle: async () => {},
  })
  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', 'report')
  assert.equal(delivery.cancel('task-a'), true)
  assert.equal(delivery.pendingCount('task-a'), 0)
  assert.equal(delivery.cancel('task-a'), false)
})

test('busy to idle transition flushes a pending report after the idle waiter settles', async () => {
  let busy = true
  let resolveIdle
  const delivered = []
  const delivery = new Delivery({
    deliver: async (_agent, report) => { delivered.push(report) },
    isBusy: () => busy,
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve }),
  })
  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', 'pending')
  busy = false
  resolveIdle()
  await delivery.flush()
  assert.deepEqual(delivered, ['pending'])
  assert.equal(delivery.pendingCount('task-a'), 0)
})

test('rebinding a task to the same agent is idempotent and preserves pending delivery state', async () => {
  let busy = true
  let resolveIdle
  let idleCalls = 0
  const delivered = []
  const delivery = new Delivery({
    deliver: async (agent, report, meta) => { delivered.push([agent, report, meta]) },
    isBusy: () => busy,
    whenIdle: () => {
      idleCalls += 1
      return new Promise(resolve => { resolveIdle = resolve })
    },
  })

  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', 'report-1')
  await delivery.enqueue('task-a', 'report-2')
  delivery.bind('task-a', 'agent-a')

  assert.equal(delivery.pendingCount('task-a'), 1)
  assert.equal(idleCalls, 1)

  busy = false
  resolveIdle()
  await delivery.flush()

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0][0], 'agent-a')
  assert.match(delivered[0][1], /2 reports merged/)
  assert.equal(delivered[0][2].count, 2)
})

test('rebinding a task prevents its old agent state from flushing', async () => {
  let busy = true
  let resolveIdle
  const delivered = []
  const delivery = new Delivery({
    deliver: async (agent, report) => { delivered.push([agent, report]) },
    isBusy: () => busy,
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve }),
  })
  delivery.bind('task-a', 'old-agent')
  await delivery.enqueue('task-a', 'old-report')
  delivery.bind('task-a', 'new-agent')
  await delivery.enqueue('task-a', 'new-report')
  busy = false
  resolveIdle()
  await delivery.flush()
  assert.deepEqual(delivered, [['new-agent', 'new-report']])
})

test('synchronous delivery failures are returned as rejected promises and custom merges stay bounded', async () => {
  const failing = new Delivery({ deliver: () => { throw new Error('delivery failed') } })
  failing.bind('task-a', 'agent-a')
  await assert.rejects(failing.enqueue('task-a', 'report'), /delivery failed/)

  let busy = true
  let resolveIdle
  const delivered = []
  const delivery = new Delivery({
    deliver: async (_agent, report) => { delivered.push(report) },
    isBusy: () => busy,
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve }),
    maxReportLength: 12,
    mergeReports: () => 'custom merge that is too long',
  })
  delivery.bind('task-a', 'agent-a')
  await delivery.enqueue('task-a', 'first')
  await delivery.enqueue('task-a', 'second')
  busy = false
  resolveIdle()
  await delivery.flush()
  assert.ok(delivered[0].length <= 12)
})
