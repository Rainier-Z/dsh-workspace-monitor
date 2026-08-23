import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PollingMonitor } from './lib/monitor.js'
import { formatScanReport } from './lib/scanner.js'

export const name = 'dsh-monitor'
export const inject = ['agents']

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_IGNORE = ['.git', 'node_modules', '.dsh-monitor']
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-monitor' }

export const Config = z.object({
  intervalMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(60_000),
  workspace: z.string().default(''),
  ignore: z.array(z.string()).default(DEFAULT_IGNORE),
  reportUnchanged: z.boolean().default(true),
  maxEntries: z.number().step(1).min(1).default(100_000),
  maxChanges: z.number().step(1).min(1).default(200),
  prompt: z.string().default(''),
})

function targetWorkspace(agent, configuredWorkspace) {
  if (configuredWorkspace.trim().length > 0) return resolve(configuredWorkspace)
  return resolve(agent.session.header.cwd ?? process.cwd())
}

function asAgentPrompt(report, configuredPrompt) {
  if (configuredPrompt.trim().length > 0) {
    // 对标 Codex Thread Heartbeat Automations：注入用户自定义监测指令 + 扫描摘要
    return [
      '[dsh-Monitor 心跳监测通知]',
      configuredPrompt.trim(),
      '',
      '--- 本轮扫描摘要 ---',
      report,
    ].join('\n')
  }
  return [
    '[dsh-Monitor 定时扫描通知]',
    report,
    '',
    '请只向用户简要汇报本轮扫描结果；不要修改文件，不要运行工具，也不要把本通知解释为新的开发任务。',
  ].join('\n')
}

export function apply(ctx, config) {
  const states = new Map()

  function detach(agent) {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    void state.monitor.stop()
    ctx.logger.info(`dsh-monitor: stopped session ${agent.id}`)
  }

  function attach(agent) {
    if (states.has(agent)) return

    const workspace = targetWorkspace(agent, config.workspace)
    const state = { disposed: false, monitor: undefined }
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
          content: [{ type: 'text', text: asAgentPrompt(report, config.prompt) }],
          source: PLUGIN_SOURCE,
        }))
      },
      async onError(error, scannedAt) {
        if (state.disposed) return
        const report = [
          `扫描时间：${new Date(scannedAt).toISOString()}`,
          `工作区：${workspace}`,
          `扫描失败：${error instanceof Error ? error.message : String(error)}`,
        ].join('\n')
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: asAgentPrompt(report) }],
          source: PLUGIN_SOURCE,
        }))
      },
    })

    state.monitor = monitor
    states.set(agent, state)
    ctx.logger.info(`dsh-monitor: monitoring ${workspace} every ${config.intervalMs}ms for session ${agent.id}`)
    void monitor.start()
  }

  ctx.on('agent/session-start', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => { detach(agent) })

  ctx.effect(() => () => Promise.allSettled([...states.entries()].map(async ([agent, state]) => {
    state.disposed = true
    states.delete(agent)
    await state.monitor.stop()
  })), 'dsh-monitor: stop workspace monitors')

  for (const agent of ctx.agents.list()) attach(agent)
}
