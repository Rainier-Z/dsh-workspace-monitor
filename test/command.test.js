import assert from 'node:assert/strict'
import test from 'node:test'
import { name, inject, apply } from '../index.js'

test('plugin exposes command-name and injections', () => {
  assert.equal(name, 'dsh-monitor')
  assert.deepEqual(inject.sort(), ['agents', 'commands'])
})

test('apply registers /monitor and routes rawInput through the handler', () => {
  const registered = {}
  const logger = { info() {} }
  const ctx = {
    logger,
    agents: { list: () => [] },
    commands: {
      register(definition) { registered.definition = definition },
    },
    on() {},
    effect() {},
  }
  apply(ctx, {})

  const def = registered.definition
  assert.equal(def.name, 'monitor')
  assert.equal(typeof def.handler, 'function')

  // /monitor stop with nothing armed
  const result = def.handler({ agent: {}, rawInput: 'stop' })
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'not monitoring. Nothing to stop.')

  // /monitor status with nothing armed
  const status = def.handler({ agent: {}, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /not monitoring/)
})

test('apply no longer auto-attaches on session-start', () => {
  let sessionStartHandler = null
  const ctx = {
    logger: { info() {} },
    agents: { list: () => [] },
    commands: { register() {} },
    on(event, fn) { if (event === 'agent/session-start') sessionStartHandler = fn },
    effect() {},
  }
  apply(ctx, {})
  assert.equal(sessionStartHandler, null)
})
