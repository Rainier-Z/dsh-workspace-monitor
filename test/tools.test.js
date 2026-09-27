import assert from 'node:assert/strict'
import test from 'node:test'
import { registerMonitorTools } from '../lib/tools.js'

function toolHarness() {
  const definitions = new Map()
  const toolCtx = { tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } } }
  const owner = { id: 'session-a', session: { header: { cwd: 'C:\\work' } } }
  const calls = []
  const runtime = {
    async createTask(input) { calls.push(['create', input]); return { taskId: 'task-1', ...input, intervalMs: input.intervalMs ?? 60_000, status: 'ACTIVE' } },
    async updateTask(taskId, patch, sessionId) { calls.push(['update', taskId, patch, sessionId]); return { taskId, ...patch, status: 'ACTIVE' } },
    async pauseTask(taskId, sessionId) { calls.push(['pause', taskId, sessionId]); return { taskId, status: 'PAUSED' } },
    async resumeTask(taskId, sessionId) { calls.push(['resume', taskId, sessionId]); return { taskId, status: 'ACTIVE' } },
    async listTasks(sessionId) { calls.push(['list', sessionId]); return [{ taskId: 'task-1', sessionId: 'session-a', status: 'ACTIVE' }] },
    async deleteTask(taskId, sessionId) { calls.push(['delete', taskId, sessionId]); return true },
  }
  registerMonitorTools(toolCtx, runtime, owner)
  return { definitions, owner, runtime, calls }
}

test('registers six owner-scoped tools and converts interval_seconds to milliseconds', async () => {
  const { definitions, owner, calls } = toolHarness()
  assert.deepEqual([...definitions.keys()], [
    'monitor_create', 'monitor_update', 'monitor_pause', 'monitor_resume', 'monitor_list', 'monitor_delete',
  ])
  const result = await definitions.get('monitor_create').execute({ workspace: 'tools', interval_seconds: 60, title: 'Tools' }, { agent: owner })
  assert.equal(result.ok, true)
  assert.equal(calls[0][0], 'create')
  assert.equal(calls[0][1].intervalMs, 60_000)
  assert.equal(calls[0][1].workspace, 'tools')
  assert.equal(calls[0][1].sessionId, owner.id)
  assert.equal(calls[0][1].cwd, owner.session.header.cwd)
  assert.deepEqual(definitions.get('monitor_create').output.render({}, result), [{ type: 'text', text: [
    '监测任务已创建',
    '任务 ID：task-1',
    '标题：Tools',
    '工作区：tools',
    '间隔：60 秒',
    '状态：ACTIVE',
  ].join('\n') }])
})

test('rejects calls from a different agent before invoking the runtime', async () => {
  const { definitions, calls } = toolHarness()
  const result = await definitions.get('monitor_list').execute({}, { agent: { id: 'other' } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'OWNER_MISMATCH')
  assert.equal(calls.length, 0)
})

test('accepts a distinct live Agent object for the same session owner id', async () => {
  const { definitions, owner, calls } = toolHarness()
  const result = await definitions.get('monitor_list').execute({}, { agent: { id: owner.id } })
  assert.equal(result.ok, true)
  assert.equal(calls[0][0], 'list')
  assert.equal(calls[0][1], owner.id)
})

test('returns a stable error for an invalid interval without invoking the runtime', async () => {
  const { definitions, owner, calls } = toolHarness()
  const result = await definitions.get('monitor_create').execute({ workspace: 'tools', interval_seconds: 0 }, { agent: owner })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INVALID_INTERVAL')
  assert.equal(calls.length, 0)
})

test('routes update, pause, resume, list and delete through stable task ids', async () => {
  const { definitions, owner, calls } = toolHarness()
  await definitions.get('monitor_update').execute({ task_id: 'task-1', interval_seconds: 120 }, { agent: owner })
  await definitions.get('monitor_pause').execute({ task_id: 'task-1' }, { agent: owner })
  await definitions.get('monitor_resume').execute({ task_id: 'task-1' }, { agent: owner })
  await definitions.get('monitor_list').execute({}, { agent: owner })
  await definitions.get('monitor_delete').execute({ task_id: 'task-1' }, { agent: owner })
  assert.deepEqual(calls.map(call => call[0]), ['update', 'pause', 'resume', 'list', 'delete'])
  assert.equal(calls[0][2].intervalMs, 120_000)
  assert.ok(calls.slice(0, 4).every(call => call.at(-1) === owner.id))
})

test('public task results omit the persisted baseline and render in bounded size', async () => {
  const { definitions, owner } = toolHarness()
  const baseline = Array.from({ length: 100_000 }, (_, index) => ({
    path: `entry-${index}.txt`, kind: 'file', size: index, mtimeMs: index,
  }))
  const task = {
    taskId: 'task-1', title: 'Bounded', workspace: 'C:/workspace', intervalMs: 60_000,
    status: 'ACTIVE', createdAt: 1, updatedAt: 2, lastRunAt: null, nextRunAt: 3,
    pauseReason: null, baseline,
  }
  const runtime = {
    async createTask() { return task },
  }
  const ctx = { tools: { register(definition) { if (definition.name === 'monitor_create') this.definition = definition; return () => {} } } }
  registerMonitorTools(ctx, runtime, owner)
  const definition = ctx.tools.definition
  const result = await definition.execute({}, { agent: owner })
  assert.equal(result.baseline, undefined)
  assert.equal(result.taskId, task.taskId)
  assert.equal(result.baselineEntries, baseline.length)
  assert.equal(definition.output.render({}, result)[0].text.includes('"baseline":'), false)
  assert.ok(definition.output.render({}, result)[0].text.length < 1_000)
  assert.match(definition.output.render({}, result)[0].text, /监测任务已创建/)
  assert.doesNotMatch(definition.output.render({}, result)[0].text, /\{"ok"/)
})

test('create, update, pause, resume and list expose only public task fields', async () => {
  const { definitions, owner } = toolHarness()
  const fullTask = {
    taskId: 'task-1', title: 'Public', workspace: 'C:/workspace', intervalMs: 60_000,
    status: 'ACTIVE', createdAt: 1, updatedAt: 2, lastRunAt: null, nextRunAt: 3,
    pauseReason: null, baseline: [{ path: 'file.txt', kind: 'file', size: 1, mtimeMs: 1 }],
    sessionId: 'private-session', agent: owner, internal: 'private',
  }
  const runtime = {
    async createTask() { return fullTask },
    async updateTask() { return fullTask },
    async pauseTask() { return { ...fullTask, status: 'PAUSED' } },
    async resumeTask() { return fullTask },
    async listTasks() { return [fullTask] },
  }
  const ctx = { tools: { register(definition) { this.definitions ??= new Map(); this.definitions.set(definition.name, definition); return () => {} } } }
  registerMonitorTools(ctx, runtime, owner)
  const expected = ['taskId', 'title', 'workspace', 'intervalMs', 'status', 'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt', 'pauseReason', 'baselineEntries']

  for (const name of ['monitor_create', 'monitor_update', 'monitor_pause', 'monitor_resume']) {
    const args = name === 'monitor_create' ? {} : { task_id: 'task-1' }
    const result = await ctx.tools.definitions.get(name).execute(args, { agent: owner })
    assert.deepEqual(Object.keys(result).filter(key => key !== 'ok'), expected)
    assert.equal(result.baselineEntries, 1)
    assert.equal(result.baseline, undefined)
  }

  const list = await ctx.tools.definitions.get('monitor_list').execute({}, { agent: owner })
  assert.deepEqual(Object.keys(list.tasks[0]), expected)
  assert.equal(list.tasks[0].baseline, undefined)
})

test('tool descriptions explain natural-language monitoring intents', () => {
  const { definitions } = toolHarness()
  assert.match(definitions.get('monitor_create').description, /start|开始/i)
  assert.match(definitions.get('monitor_pause').description, /stop|停止/i)
  assert.match(definitions.get('monitor_resume').description, /resume|继续/i)
  assert.match(definitions.get('monitor_update').description, /update|修改/i)
  assert.match(definitions.get('monitor_list').description, /list|查看/i)
})
