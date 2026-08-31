import { statSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PollingMonitor } from './lib/monitor.js'
import { formatScanReport } from './lib/scanner.js'
import { parseMonitorCommand, resolveTargetWorkspace } from './lib/controller.js'

export const name = 'dsh-monitor'
export const inject = ['agents', 'commands']

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_IGNORE = ['.git', 'node_modules', '.dsh-monitor']
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-monitor' }

export const Config = z.object({
  intervalMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(120_000),
  ignore: z.array(z.string()).default(DEFAULT_IGNORE),
  reportUnchanged: z.boolean().default(true),
  maxEntries: z.number().step(1).min(1).default(100_000),
  maxChanges: z.number().step(1).min(1).default(200),
})

function asMonitoringReport(report) {
  return [
    '[dsh-Monitor 心跳监测通知]',
    '--- 本轮扫描摘要 ---',
    report,
  ].join('\n')
}

function asErrorReport(error, scannedAt, workspace) {
  return [
    '[dsh-Monitor 心跳监测通知]',
    '--- 本轮扫描摘要 ---',
    `扫描时间：${new Date(scannedAt).toISOString()}`,
    `工作区：${workspace}`,
    `扫描失败：${error instanceof Error ? error.message : String(error)}`,
  ].join('\n')
}

export function apply(ctx, config) {
  const monitors = new Map() // agent -> { monitor, workspace, startedAt, disposed }

  function stopFor(agent) {
    const state = monitors.get(agent)
    if (state === undefined) return false
    monitors.delete(agent)
    state.disposed = true
    void state.monitor.stop()
    ctx.logger.info(`dsh-monitor: stopped session ${agent.id}`)
    return true
  }

  function startFor(agent, target) {
    stopFor(agent)
    const workspace = resolveTargetWorkspace(target, agent.session?.header?.cwd)
    let info
    try {
      info = statSync(workspace)
    } catch {
      return { kind: 'error', text: `workspace does not exist: ${workspace}` }
    }
    if (!info.isDirectory()) {
      return { kind: 'error', text: `workspace is not a directory: ${workspace}` }
    }

    const state = { disposed: false, monitor: undefined, workspace, startedAt: Date.now() }
    const monitor = new PollingMonitor({
      root: workspace,
      intervalMs: config.intervalMs,
      ignore: config.ignore,
      maxEntries: config.maxEntries,
      async onScan(result) {
        if (state.disposed) return
        if (!config.reportUnchanged && result.diff.total === 0 && result.warnings.length === 0) return
        const report = formatScanReport(result, { maxChanges: config.maxChanges })
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: asMonitoringReport(report) }],
          source: PLUGIN_SOURCE,
        }))
      },
      async onError(error, scannedAt) {
        if (state.disposed) return
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: asErrorReport(error, scannedAt, workspace) }],
          source: PLUGIN_SOURCE,
        }))
      },
    })
    state.monitor = monitor
    monitors.set(agent, state)
    ctx.logger.info(`dsh-monitor: monitoring ${workspace} every ${config.intervalMs}ms for session ${agent.id}`)
    void monitor.start()
    return { kind: 'success', text: `monitoring ${workspace} every ${config.intervalMs}ms` }
  }

  function statusFor(agent) {
    const state = monitors.get(agent)
    if (state === undefined) {
      return { kind: 'success', text: 'not monitoring. Use /monitor start [目录] to begin.' }
    }
    return { kind: 'success', text: `monitoring ${state.workspace} every ${config.intervalMs}ms (since ${new Date(state.startedAt).toISOString()})` }
  }

  ctx.commands.register({
    name: 'monitor',
    description: '按需启动/停止对某工作区的心跳监测',
    input: { hint: 'start [目录] | stop | status' },
    handler: (invocation) => {
      const command = parseMonitorCommand(invocation.rawInput)
      switch (command.kind) {
        case 'start':
          return startFor(invocation.agent, command.target)
        case 'stop':
          return stopFor(invocation.agent)
            ? { kind: 'success', text: 'monitoring stopped.' }
            : { kind: 'error', text: 'not monitoring. Nothing to stop.' }
        case 'status':
          return statusFor(invocation.agent)
        case 'error':
          return command
      }
    },
  })

  ctx.on('agent/disposed', ({ agent }) => { stopFor(agent) })
  ctx.effect(() => () => {
    for (const agent of monitors.keys()) stopFor(agent)
  }, 'dsh-monitor: stop workspace monitors')
}
