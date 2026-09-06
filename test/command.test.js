import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { name, inject, apply } from '../index.js'

test('plugin exposes command-name and injections', () => {
  assert.equal(name, 'dsh-workspace-monitor')
  assert.deepEqual([...inject].sort(), ['agents', 'commands', 'storageDomain', 'tools'])
})

function createHarness({ failToolSetup = false } = {}) {
  const registered = {}
  const toolDisposers = []
  let closeCalls = 0
  const table = new MapTable()
  const domain = { table() { return table }, close: async () => { closeCalls += 1 } }
  const events = new Map()
  const effectDisposers = []
  const toolRegistry = { register() { const dispose = () => {}; toolDisposers.push(dispose); return dispose } }
  const root = { id: 'agent-1', status: 'idle', session: { header: { cwd: process.cwd() } }, ctx: { tools: toolRegistry, effect(fn) { if (failToolSetup) throw new Error('tool setup failed'); const disposer = fn(); effectDisposers.push(disposer); return disposer } }, followup() {} }
  const ctx = {
    logger: { info() {}, warn() {} },
    agents: { roots: () => [root], list: () => [root], get: id => id === root.id ? root : undefined },
    commands: {
      register(definition) { registered.definition = definition },
    },
    tools: toolRegistry,
    storageDomain: { async open() { return domain } },
    on(event, fn) { events.set(event, fn); return () => events.delete(event) },
    effect(fn) { const disposer = fn(); effectDisposers.push(disposer); return disposer },
  }
  return { ctx, root, registered, events, toolDisposers, effectDisposers, domain, table, get closeCalls() { return closeCalls } }
}

class MapTable {
  #values = new Map()
  failUpdates = false
  get(key) { return this.#values.get(key) }
  entries() { return this.#values.entries() }
  async put(key, value) { this.#values.set(key, value) }
  async update(key, fn) { if (this.failUpdates) throw new Error('update failed'); const next = fn(this.#values.get(key)); this.#values.set(key, next); return next }
  async delete(key) { return this.#values.delete(key) }
}

test('apply registers /monitor and routes rawInput through the handler', async () => {
  const { ctx, root, registered, domain } = createHarness()
  await apply(ctx, {})

  const def = registered.definition
  assert.equal(def.name, 'monitor')
  assert.equal(typeof def.handler, 'function')

  // /monitor stop always addresses an exact task id.
  const result = await def.handler({ agent: root, rawInput: 'stop missing' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not found|missing/)

  const status = await def.handler({ agent: root, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /No monitor tasks|没有监测任务/)
  await domain.close()
})

test('apply creates the durable runtime and attaches six scoped tools to roots', async () => {
  const { ctx, root, toolDisposers, domain } = createHarness()
  await apply(ctx, {})
  assert.equal(toolDisposers.length, 6)
  assert.equal(domain.closed, undefined)
  await domain.close()
})

test('apply closes the opened domain when setup fails', async () => {
  const harness = createHarness({ failToolSetup: true })
  await assert.rejects(apply(harness.ctx, {}), /tool setup failed/)
  assert.equal(harness.closeCalls, 1)
})

test('agent disposal pauses all active tasks and releases pending delivery', async (t) => {
  const harness = createHarness()
  await apply(harness.ctx, {})
  t.after(async () => {
    for (const dispose of harness.effectDisposers.reverse()) await dispose?.()
  })

  const start = await harness.registered.definition.handler({ agent: harness.root, rawInput: 'start .' })
  assert.equal(start.kind, 'success')
  const statusBefore = await harness.registered.definition.handler({ agent: harness.root, rawInput: 'status' })
  assert.match(statusBefore.text, /ACTIVE/)

  await harness.events.get('agent/disposed')({ agent: harness.root })
  const statusAfter = await harness.registered.definition.handler({ agent: harness.root, rawInput: 'status' })
  assert.match(statusAfter.text, /PAUSED/)
  assert.match(statusAfter.text, /agent_disposed/)
})

test('agent disposal listener logs failures without rejecting', async () => {
  const errors = []
  const harness = createHarness()
  harness.ctx.logger.error = (...args) => errors.push(args)
  await apply(harness.ctx, {})
  const event = harness.events.get('agent/disposed')
  const start = await harness.registered.definition.handler({ agent: harness.root, rawInput: 'start .' })
  assert.equal(start.kind, 'success')
  harness.table.failUpdates = true

  await assert.doesNotReject(event({ agent: harness.root }))
  assert.equal(errors.length, 1)
})
