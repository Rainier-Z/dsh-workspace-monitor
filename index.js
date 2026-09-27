import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { monitorDomainSpec } from './lib/domain.js'
import { Delivery } from './lib/delivery.js'
import { parseMonitorCommand, resolveTargetWorkspace } from './lib/controller.js'
import { MonitorRuntime } from './lib/runtime.js'
import { TaskService } from './lib/task-service.js'
import { TaskStore } from './lib/task-store.js'
import { registerMonitorTools } from './lib/tools.js'

export const name = 'dsh-workspace-monitor'
export const inject = ['agents', 'commands', 'tools', 'storageDomain']

// Session services are host capabilities: resolve them reflectively so an
// older profile can still install the plugin, while delivery fails closed
// until the Desktop session runtime is available.

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_IGNORE = ['.git', 'node_modules', '.dsh-workspace-monitor']

export const Config = z.object({
  intervalMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(60_000),
  ignore: z.array(z.string()).default(DEFAULT_IGNORE),
  maxEntries: z.number().step(1).min(1).default(100_000),
  maxChanges: z.number().step(1).min(1).default(200),
})

export function monitorNoticeSource(summary) {
  const text = String(summary)
  return {
    kind: 'dsh-workspace-monitor',
    form: 'notice',
    summary: text.length <= 120 ? text : `${text.slice(0, 119)}…`,
  }
}

function summaryForReport(report, count) {
  if (String(report).startsWith('工作区监测扫描失败')) return '工作区监测失败'
  const match = String(report).match(/变化数量：(\d+)/)
  if (match) return `工作区发生 ${match[1]} 项变化`
  return count > 1 ? `工作区监测更新（${count} 次）` : '工作区监测更新'
}

function optionalService(ctx, name) {
  return ctx.reflect?.get?.(name)
}

function missingService(name, capability) {
  return new Error(`DSH service "${name}" is unavailable; ${capability} cannot proceed`)
}

function sessionAgentResolver(ctx, initialController) {
  return async sessionId => {
    const sessionController = optionalService(ctx, 'sessionController') ?? initialController
    if (typeof sessionController?.resolveAgent !== 'function') {
      throw missingService('sessionController', `resolving session "${sessionId}"`)
    }
    const resolved = await sessionController.resolveAgent(sessionId)
    if (resolved && typeof resolved === 'object' && 'error' in resolved) {
      throw resolved.error ?? new Error(`sessionController could not resolve session "${sessionId}"`)
    }
    const agent = resolved?.agent ?? resolved
    if (!agent || typeof agent.followup !== 'function' || !agent.session) {
      throw new Error(`sessionController.resolveAgent("${sessionId}") did not return a live Agent`)
    }
    return agent
  }
}

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(monitorDomainSpec)
  try {
    const table = domain.table('tasks')
    const service = new TaskService(new TaskStore(table))
    const sessionController = optionalService(ctx, 'sessionController')
    const sessions = optionalService(ctx, 'sessions')
    const sessionPersistence = optionalService(ctx, 'sessionPersistence')
    const flushSession = async session => {
      const currentSessions = optionalService(ctx, 'sessions') ?? sessions
      if (typeof currentSessions?.flush !== 'function') throw missingService('sessions', 'acknowledging a monitor message')
      const acknowledged = await currentSessions.flush(session)
      if (acknowledged !== true) throw new Error('DSH sessions.flush did not acknowledge durable message persistence')
      return true
    }
    const delivery = new Delivery({
      service,
      resolveAgent: sessionAgentResolver(ctx, sessionController),
      sessions: { flush: flushSession },
      sessionPersistence,
      isBusy: agent => agent?.status === 'running',
      whenIdle: agent => agent?.whenIdle?.() ?? Promise.resolve(),
      deliver: (agent, report, meta = {}) => agent.followup(createUserMessage({
        content: [{ type: 'text', text: report }],
        source: monitorNoticeSource(meta.summary ?? summaryForReport(report, meta.count)),
      })),
    })
    const runtime = new MonitorRuntime({
      service,
      delivery,
      ignore: config.ignore,
      maxEntries: config.maxEntries,
      maxChanges: config.maxChanges,
      defaultIntervalMs: config.intervalMs,
    })
    const runtimeApi = {
      createTask: input => runtime.createTask({ ...input, intervalMs: input.intervalMs ?? config.intervalMs }),
      updateTask: (...args) => runtime.updateTask(...args),
      pauseTask: (...args) => runtime.pauseTask(...args),
      resumeTask: (...args) => runtime.resumeTask(...args),
      listTasks: (...args) => runtime.listTasks(...args),
      deleteTask: (...args) => runtime.deleteTask(...args),
    }
    const toolDisposers = new Map()
    const roots = () => ctx.agents.roots?.() ?? ctx.agents.list?.() ?? []
    const registerFor = agent => {
      if (!agent?.ctx || toolDisposers.has(agent) || !roots().includes(agent)) return
      let registration
      const disposer = agent.ctx.effect(
        () => {
          registration = registerMonitorTools(agent.ctx, runtimeApi, agent)
          return async () => {
            if (toolDisposers.get(agent) === disposer) toolDisposers.delete(agent)
            await registration?.()
          }
        },
        `dsh-workspace-monitor tools:${agent.id}`,
      )
      toolDisposers.set(agent, disposer)
    }
    await runtime.start()
    for (const agent of roots()) registerFor(agent)
    const onCreated = ctx.on('agent/created', ({ agent }) => registerFor(agent))
    const onSessionActivity = ctx.on('workspace/session-activity', async (request, next) => {
      const activity = typeof next === 'function' ? await next() : []
      const tasks = await service.listTasks({ sessionId: request?.sessionId })
      const active = tasks.filter(task => task.status === 'ACTIVE')
      if (active.length === 0) return activity
      return [
        ...activity,
        {
          kind: 'monitor',
          items: active.map(task => ({ id: task.taskId, label: task.title })),
        },
      ]
    })
    const onSessionStop = ctx.on('workspace/session-stop', async request => {
      const sessionId = request?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const tasks = await service.listTasks({ sessionId })
      await Promise.all(tasks
        .filter(task => task.status === 'ACTIVE')
        .map(task => runtime.pauseTask(task.taskId, sessionId, 'session_archived')))
    })
    const commandDisposer = ctx.commands.register({
      name: 'monitor',
      description: '按需启动/停止对某工作区的心跳监测',
      input: { hint: 'start [目录] | stop <taskId> | status' },
      handler: async invocation => {
        const command = parseMonitorCommand(invocation.rawInput)
        try {
          if (command.kind === 'start') {
            const sessionId = invocation.agent?.id
            if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('invocation.agent.id is required to identify the current session')
            const cwd = invocation.agent.session?.header?.cwd
            const task = await runtimeApi.createTask({ sessionId, cwd, workspace: resolveTargetWorkspace(command.target, cwd) })
            return { kind: 'success', text: `monitor task ${task.taskId} started for ${task.workspace}` }
          }
          if (command.kind === 'stop') {
            const task = await runtimeApi.pauseTask(command.taskId, invocation.agent?.id)
            return { kind: 'success', text: `monitor task ${task.taskId} paused.` }
          }
          if (command.kind === 'status' || command.kind === 'list') {
            const tasks = await runtimeApi.listTasks(invocation.agent?.id)
            if (tasks.length === 0) return { kind: 'success', text: 'No monitor tasks.' }
            return { kind: 'success', text: tasks.map(task => `${task.taskId} [${task.status}] ${task.workspace} every ${task.intervalMs}ms${task.pauseReason ? ` (${task.pauseReason})` : ''}`).join('\n') }
          }
          return command
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
    ctx.effect(() => async () => {
      await runtime.dispose()
      for (const dispose of [...toolDisposers.values()]) await dispose?.()
      await onCreated?.()
      await onSessionActivity?.()
      await onSessionStop?.()
      await commandDisposer?.()
      await domain.close()
    }, 'dsh-workspace-monitor: stop runtime, tools, and domain')
  } catch (error) {
    await domain.close()
    throw error
  }
}
