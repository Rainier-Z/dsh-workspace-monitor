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

function intervalLabel(intervalMs) {
  if (!Number.isFinite(intervalMs)) return undefined
  return intervalMs % 1_000 === 0 ? `${intervalMs / 1_000} 秒` : `${intervalMs} 毫秒`
}

function renderTask(task, heading = '监测任务') {
  if (!task || typeof task !== 'object') return heading
  const lines = [heading]
  if (task.taskId) lines.push(`任务 ID：${task.taskId}`)
  if (task.title) lines.push(`标题：${task.title}`)
  if (task.workspace) lines.push(`工作区：${task.workspace}`)
  const interval = intervalLabel(task.intervalMs)
  if (interval) lines.push(`间隔：${interval}`)
  if (task.status) lines.push(`状态：${task.status}`)
  if (task.pauseReason) lines.push(`暂停原因：${task.pauseReason}`)
  if (Number.isFinite(task.baselineEntries)) lines.push(`基线文件数：${task.baselineEntries}`)
  return lines.join('\n')
}

function render(_args, value, action) {
  if (!value || typeof value !== 'object') return [{ type: 'text', text: '监测操作已完成。' }]
  if (value.ok === false) {
    const code = value.code ? `（${value.code}）` : ''
    return [{ type: 'text', text: `监测操作失败${code}：${value.message ?? '未知错误'}` }]
  }
  if (Array.isArray(value.tasks)) {
    const tasks = value.tasks
    const text = tasks.length === 0
      ? '当前会话没有监测任务。'
      : [`当前会话有 ${tasks.length} 项监测任务：`, ...tasks.map(task => renderTask(task))].join('\n\n')
    return [{ type: 'text', text }]
  }
  if (value.deleted === true) {
    return [{ type: 'text', text: `监测任务已删除\n任务 ID：${value.taskId ?? '未知'}` }]
  }
  const actionHeadings = {
    create: '监测任务已创建',
    update: '监测任务已更新',
    pause: '监测任务已暂停',
    resume: '监测任务已恢复',
  }
  const heading = value.taskId
    ? actionHeadings[action] ?? (value.status === 'PAUSED' ? '监测任务已暂停' : '监测任务信息')
    : '监测操作已完成。'
  return [{ type: 'text', text: renderTask(value, heading) }]
}
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
  return typeof owner?.id === 'string' && exec?.agent?.id === owner.id
    ? undefined
    : { ok: false, code: 'OWNER_MISMATCH', message: 'tool call is scoped to another session' }
}

function definitions(runtime, owner) {
  const guarded = (execute, transform = value => value) => async (args, exec) => {
    const mismatch = ownerCheck(owner, exec)
    if (mismatch) return mismatch
    try { return success(transform(await execute(args ?? {}))) } catch (error) { return failure(error) }
  }
  const output = action => ({ schema: OUTPUT_SCHEMA, render: (args, value) => render(args, value, action) })
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
      output: output('create'),
      execute: guarded(args => runtime.createTask({
        sessionId: owner.id,
        cwd: owner.session?.header?.cwd,
        workspace: args.workspace ?? '.',
        intervalMs: intervalMsFrom(args.interval_seconds),
        title: args.title,
      }), publicTask),
    },
    {
      name: 'monitor_update',
      description: 'Modify one monitor task (修改间隔) by exact task id. Use when the user says “修改间隔”.',
      parameters: { task_id: taskId, workspace: { type: 'string' }, interval_seconds: { type: 'integer' }, title: { type: 'string' } },
      output: output('update'),
      execute: guarded(args => runtime.updateTask(args.task_id, {
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
        ...(args.interval_seconds === undefined ? {} : { intervalMs: intervalMsFrom(args.interval_seconds) }),
        ...(args.title === undefined ? {} : { title: args.title }),
      }, owner.id), publicTask),
    },
    ...[
      ['monitor_pause', 'Stop one monitor task (停止监测). Use when the user says “停止监测”.', 'pauseTask'],
      ['monitor_resume', 'Continue one monitor task (继续监测) with catch-up. Use when the user says “继续监测”.', 'resumeTask'],
    ].map(([name, description, method]) => ({ name, description, parameters: { task_id: taskId }, output: output(method === 'pauseTask' ? 'pause' : 'resume'), execute: guarded(args => runtime[method](args.task_id, owner.id), publicTask) })),
    {
      name: 'monitor_list',
      description: 'List monitor tasks (列出监测) owned by this conversation. Use when the user says “列出监测”.',
      parameters: {},
      output: output('list'),
      execute: guarded(async () => ({ tasks: await runtime.listTasks(owner.id) }), publicTasks),
    },
    {
      name: 'monitor_delete',
      description: 'Delete one monitor task by exact task id.',
      parameters: { task_id: taskId },
      output: output('delete'),
      execute: guarded(async args => ({ deleted: await runtime.deleteTask(args.task_id, owner.id), taskId: args.task_id })),
    },
  ]
}

export function registerMonitorTools(toolCtx, runtime, owner) {
  if (!toolCtx?.tools?.register) throw new TypeError('tool context must provide tools.register')
  const disposers = definitions(runtime, owner).map(definition => toolCtx.tools.register(defineTool(definition)))
  return () => { for (const dispose of disposers.reverse()) dispose?.() }
}

export { definitions as monitorToolDefinitions }
