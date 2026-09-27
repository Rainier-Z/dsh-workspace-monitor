import assert from 'node:assert/strict'
import test from 'node:test'
import { Delivery } from '../lib/delivery.js'

function createService(pendingDelivery = { revision: 1, report: 'change A', count: 1 }) {
  const task = { taskId: 'task-a', sessionId: 'session-a', pendingDelivery }
  return {
    task,
    async getTask(taskId) { return taskId === task.taskId ? structuredClone(task) : null },
    async listTasks() { return [structuredClone(task)] },
    async ackDelivery(taskId, revision, meta, sessionId) {
      assert.equal(taskId, task.taskId)
      assert.equal(sessionId, task.sessionId)
      if (task.pendingDelivery?.revision !== revision) return { acknowledged: false, task: structuredClone(task) }
      task.pendingDelivery = null
      task.lastDeliveredAt = meta.deliveredAt
      return { acknowledged: true, task: structuredClone(task) }
    },
  }
}

function makeDelivery(service, options = {}) {
  const agent = options.agent ?? { id: 'agent-a', session: { id: 'session-a' } }
  const delivery = new Delivery({
    service,
    resolveAgent: options.resolveAgent ?? (async sessionId => sessionId === 'session-a' ? agent : undefined),
    deliver: options.deliver ?? (async () => {}),
    sessions: options.sessions ?? { flush: async () => true },
    isBusy: options.isBusy,
    whenIdle: options.whenIdle,
    clock: options.clock ?? (() => 1234),
  })
  return { delivery, agent }
}

test('delivers durable pending report through the resolved session and ACKs after flush', async () => {
  const service = createService()
  const sent = []
  const { delivery, agent } = makeDelivery(service, {
    deliver: async (...args) => { sent.push(args) },
  })

  const result = await delivery.request('task-a')

  assert.deepEqual(result, { pending: false, revision: 1 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], agent)
  assert.equal(sent[0][1], 'change A')
  assert.deepEqual(sent[0][2], {
    taskId: 'task-a', sessionId: 'session-a', revision: 1, count: 1, merged: false,
  })
  assert.equal(service.task.pendingDelivery, null)
  assert.equal(service.task.lastDeliveredAt, 1234)
})

test('agent busy waits for idle and leaves durable report intact until then', async () => {
  const service = createService({ revision: 2, report: '2 reports merged\nchange A\nchange B', count: 2 })
  let busy = true
  let resolveIdle
  const sent = []
  const { delivery } = makeDelivery(service, {
    isBusy: () => busy,
    whenIdle: () => new Promise(resolve => { resolveIdle = resolve }),
    deliver: async (_agent, report, meta) => { sent.push({ report, meta }) },
  })

  const request = delivery.request('task-a')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.task.pendingDelivery.revision, 2)
  assert.equal(sent.length, 0)

  busy = false
  resolveIdle()
  await request
  assert.equal(sent.length, 1)
  assert.equal(sent[0].meta.count, 2)
  assert.match(sent[0].report, /change A[\s\S]*change B/)
  assert.equal(service.task.pendingDelivery, null)
})

test('no live agent leaves durable pending delivery available for a later request', async () => {
  const service = createService()
  let agent
  const sent = []
  const { delivery } = makeDelivery(service, {
    resolveAgent: async () => agent,
    deliver: async (_agent, report) => { sent.push(report) },
  })

  assert.deepEqual(await delivery.request('task-a'), { pending: true, reason: 'agent_unavailable', revision: 1 })
  assert.equal(service.task.pendingDelivery.revision, 1)
  assert.deepEqual(sent, [])

  agent = { id: 'agent-restored', session: { id: 'session-a' } }
  await delivery.request('task-a')
  assert.deepEqual(sent, ['change A'])
  assert.equal(service.task.pendingDelivery, null)
})

test('flush failure retains pending report for a retry', async () => {
  const service = createService()
  let flushResult = false
  let sends = 0
  const { delivery } = makeDelivery(service, {
    deliver: async () => { sends += 1 },
    sessions: { flush: async () => flushResult },
  })

  const first = await delivery.request('task-a')
  assert.equal(first.reason, 'flush_not_confirmed')
  assert.equal(service.task.pendingDelivery.revision, 1)

  flushResult = true
  await delivery.request('task-a')
  assert.equal(sends, 2)
  assert.equal(service.task.pendingDelivery, null)
})

test('stale revision ACK cannot clear a newer observation and the newer revision is sent', async () => {
  const service = createService({ revision: 1, report: 'change A', count: 1 })
  const sent = []
  let releaseFirstSend
  const holdFirstSend = new Promise(resolve => { releaseFirstSend = resolve })
  const { delivery } = makeDelivery(service, {
    deliver: async (_agent, report) => {
      sent.push(report)
      if (report === 'change A') {
        service.task.pendingDelivery = { revision: 2, report: '2 reports merged\nchange A\nchange B', count: 2 }
        await holdFirstSend
      }
    },
  })

  const request = delivery.request('task-a')
  await new Promise(resolve => setImmediate(resolve))
  releaseFirstSend()
  await request

  assert.deepEqual(sent, ['change A', '2 reports merged\nchange A\nchange B'])
  assert.equal(service.task.pendingDelivery, null)
})

test('recover retries pending deliveries after a runtime restart', async () => {
  const service = createService({ revision: 4, report: 'durable after restart', count: 3 })
  const sent = []
  const { delivery } = makeDelivery(service, {
    deliver: async (_agent, report) => { sent.push(report) },
  })

  const results = await delivery.recover()

  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'fulfilled')
  assert.deepEqual(sent, ['durable after restart'])
  assert.equal(service.task.pendingDelivery, null)
})

test('dispose releases a busy waiter without clearing durable pending state', async () => {
  const service = createService()
  const { delivery } = makeDelivery(service, {
    isBusy: () => true,
    whenIdle: () => new Promise(() => {}),
  })
  const request = delivery.request('task-a')
  await new Promise(resolve => setImmediate(resolve))
  await delivery.dispose()
  await request
  assert.equal(service.task.pendingDelivery.revision, 1)
})
