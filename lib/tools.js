import { defineTool } from '@deepseek-ai/dsh-tools'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    code: { type: 'string' },
    message: { type: 'string' },
  },
}

function render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] }
function success(value) { return { ok: true, ...value } }
function failure(error) { return { ok: false, code: error?.code ?? 'MONITOR_ERROR', message: error instanceof Error ? error.message : String(error) } }

const PUBLIC_TASK_FIELDS = [
  'taskId', 'title', 'workspace', 'intervalMs', 'status', 'createdAt', 'updatedAt',
  'lastRunAt', 'nextRunAt', 'pauseReason',
]

function publicTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task
  const summary = {}
  for (const field of PUBLIC_TASK_FIELDS) {
    if (Object.hasOwn(task, field)) summary[field] = task[field]
  }
  if (Array.isArray(task.baseline)) summary.baselineEntries = task.baseline.length
  return summary
}

function publicTasks(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value.tasks)) return { ...value, tasks: value.tasks.map(publicTask) }
  return publicTask(value)
}

function intervalMsFrom(seconds) {
  if (seconds === undefined) return undefined
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    const error = new TypeError('interval_seconds must be a positive integer')
    error.code = 'INVALID_INTERVAL'
    throw error
  }
  return seconds * 1_000
}

function ownerCheck(owner, exec) {
  return exec?.agent === owner ? undefined : { ok: false, code: 'OWNER_MISMATCH', message: 'tool call is scoped to another agent' }
}

function definitions(runtime, owner) {
  const guarded = (execute, transform = value => value) => async (args, exec) => {
    const mismatch = ownerCheck(owner, exec)
    if (mismatch) return mismatch
    try { return success(transform(await execute(args ?? {}))) } catch (error) { return failure(error) }
  }
  const taskId = { type: 'string', required: true, description: 'Exact monitor task id.' }
  return [
    {
      name: 'monitor_create',
      description: 'Start a persistent workspace monitor (开始监测) for this conversation. Use when the user says “开始监测”.',
      parameters: {
        workspace: { type: 'string', description: 'Workspace path, relative to the current session working directory when relative.' },
        interval_seconds: { type: 'integer', description: 'Positive interval in seconds; defaults to 60.' },
        title: { type: 'string', description: 'Human-readable monitor title.' },
      },
      output: { schema: OUTPUT_SCHEMA, render },
      execute: guarded(args => runtime.createTask({
        agent: owner,
        workspace: args.workspace ?? '.',
        intervalMs: intervalMsFrom(args.interval_seconds),
        title: args.title,
      }), publicTask),
    },
    {
      name: 'monitor_update',
      description: 'Modify one monitor task (修改间隔) by exact task id. Use when the user says “修改间隔”.',
      parameters: { task_id: taskId, workspace: { type: 'string' }, interval_seconds: { type: 'integer' }, title: { type: 'string' } },
      output: { schema: OUTPUT_SCHEMA, render },
      execute: guarded(args => runtime.updateTask(args.task_id, {
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args.interval_seconds === undefined ? {} : { intervalMs: intervalMsFrom(args.interval_seconds) }),
        ...(args.title === undefined ? {} : { title: args.title }),
      }, owner), publicTask),
    },
    ...[
      ['monitor_pause', 'Stop one monitor task (停止监测). Use when the user says “停止监测”.', 'pauseTask'],
      ['monitor_resume', 'Continue one monitor task (继续监测) with catch-up. Use when the user says “继续监测”.', 'resumeTask'],
    ].map(([name, description, method]) => ({ name, description, parameters: { task_id: taskId }, output: { schema: OUTPUT_SCHEMA, render }, execute: guarded(args => runtime[method](args.task_id, owner), publicTask) })),
    {
      name: 'monitor_list',
      description: 'List monitor tasks (列出监测) owned by this conversation. Use when the user says “列出监测”.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render },
      execute: guarded(async () => ({ tasks: await runtime.listTasks(owner) }), publicTasks),
    },
    {
      name: 'monitor_delete',
      description: 'Delete one monitor task by exact task id.',
      parameters: { task_id: taskId },
      output: { schema: OUTPUT_SCHEMA, render },
      execute: guarded(async args => ({ deleted: await runtime.deleteTask(args.task_id, owner), taskId: args.task_id })),
    },
  ]
}

export function registerMonitorTools(toolCtx, runtime, owner) {
  if (!toolCtx?.tools?.register) throw new TypeError('tool context must provide tools.register')
  const disposers = definitions(runtime, owner).map(definition => toolCtx.tools.register(defineTool(definition)))
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}

export { definitions as monitorToolDefinitions }
