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

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_IGNORE = ['.git', 'node_modules', '.dsh-workspace-monitor']
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-workspace-monitor' }

export const Config = z.object({
  intervalMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(60_000),
  ignore: z.array(z.string()).default(DEFAULT_IGNORE),
  maxEntries: z.number().step(1).min(1).default(100_000),
  maxChanges: z.number().step(1).min(1).default(200),
})

function asMonitoringReport(report) {
  return [
    '[dsh-workspace-monitor 心跳监测通知]',
    '--- 本轮扫描摘要 ---',
    report,
  ].join('\n')
}

function asErrorReport(error, taskId, scannedAt, workspace) {
  return [
    '[dsh-workspace-monitor 心跳监测通知]',
    '--- 本轮扫描摘要 ---',
    `任务：${taskId}`,
    `扫描时间：${new Date(scannedAt).toISOString()}`,
    `工作区：${workspace}`,
    `扫描失败：${error instanceof Error ? error.message : String(error)}`,
  ].join('\n')
}

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(monitorDomainSpec)
  try {
    const table = domain.table('tasks')
    const service = new TaskService(new TaskStore(table))
    const getAgent = id => ctx.agents.get?.(id)
    const delivery = new Delivery({
      isBusy: agent => agent?.status === 'running',
      whenIdle: agent => agent?.whenIdle?.() ?? Promise.resolve(),
      deliver: (agent, report) => agent.followup(createUserMessage({
        content: [{ type: 'text', text: asMonitoringReport(report) }],
        source: PLUGIN_SOURCE,
      })),
    })
    const runtime = new MonitorRuntime({
      service,
      delivery,
      getAgent,
      ignore: config.ignore,
      maxEntries: config.maxEntries,
      maxChanges: config.maxChanges,
      defaultIntervalMs: config.intervalMs,
      onError: async (error, taskId, scannedAt) => {
        const task = await service.getTask(taskId)
        const agent = task && getAgent(task.agentId)
        if (!agent) return
        await delivery.enqueue(taskId, asErrorReport(error, taskId, scannedAt, task.workspace), { agent })
      },
    })
    const runtimeApi = {
      createTask: input => runtime.createTask({ ...input, intervalMs: input.intervalMs ?? config.intervalMs }),
      updateTask: (...args) => runtime.updateTask(...args),
      pauseTask: (...args) => runtime.pauseTask(...args),
      resumeTask: (...args) => runtime.resumeTask(...args),
      listTasks: (...args) => runtime.listTasks(...args),
      deleteTask: (...args) => runtime.deleteTask(...args),
    }
    const logDisposedError = error => {
      try {
        const logger = ctx.logger
        const log = logger?.error ?? logger?.warn
        log?.call(logger, 'dsh-workspace-monitor: failed to pause tasks for disposed agent', error)
      } catch { /* logging must not create an unhandled listener rejection */ }
    }
    const pauseDisposedTasks = async ({ agent } = {}) => {
      if (!agent?.id) return
      const tasks = await service.listTasks({ agentId: agent.id })
      await Promise.all(tasks
        .filter(task => task.status === 'ACTIVE')
        .map(task => runtime.pauseTask(task.taskId, agent, 'agent_disposed')))
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
    const commandDisposer = ctx.commands.register({
      name: 'monitor',
      description: '按需启动/停止对某工作区的心跳监测',
      input: { hint: 'start [目录] | stop <taskId> | status' },
      handler: async invocation => {
        const command = parseMonitorCommand(invocation.rawInput)
        try {
          if (command.kind === 'start') {
            const task = await runtimeApi.createTask({ agent: invocation.agent, workspace: resolveTargetWorkspace(command.target, invocation.agent.session?.header?.cwd) })
            return { kind: 'success', text: `monitor task ${task.taskId} started for ${task.workspace}` }
          }
          if (command.kind === 'stop') {
            const task = await runtimeApi.pauseTask(command.taskId, invocation.agent)
            return { kind: 'success', text: `monitor task ${task.taskId} paused.` }
          }
          if (command.kind === 'status' || command.kind === 'list') {
            const tasks = await runtimeApi.listTasks(invocation.agent)
            if (tasks.length === 0) return { kind: 'success', text: 'No monitor tasks.' }
            return { kind: 'success', text: tasks.map(task => `${task.taskId} [${task.status}] ${task.workspace} every ${task.intervalMs}ms${task.pauseReason ? ` (${task.pauseReason})` : ''}`).join('\n') }
          }
          return command
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
    const onDisposed = ctx.on('agent/disposed', event => pauseDisposedTasks(event).catch(logDisposedError))
    ctx.effect(() => async () => {
      await runtime.dispose()
      for (const dispose of [...toolDisposers.values()]) await dispose?.()
      await onCreated?.()
      await onDisposed?.()
      await commandDisposer?.()
      await domain.close()
    }, 'dsh-workspace-monitor: stop runtime, tools, and domain')
  } catch (error) {
    await domain.close()
    throw error
  }
}
