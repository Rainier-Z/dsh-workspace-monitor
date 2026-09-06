import { resolve } from 'node:path'
import { Delivery } from './delivery.js'
import { Scheduler } from './scheduler.js'
import { diffSnapshots, formatScanReport, mergeSnapshots, scanWorkspace } from './scanner.js'

const DEFAULT_INTERVAL_MS = 60_000

function assertDefaultInterval(intervalMs) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new RangeError('defaultIntervalMs must be a safe integer of at least 1000ms')
  }
}

function sessionIdOf(agent) {
  if (!agent || typeof agent.id !== 'string' || agent.id.length === 0) throw new TypeError('agent.id is required')
  return agent.id
}

function workspaceOf(agent, workspace) {
  const cwd = agent.session?.header?.cwd ?? process.cwd()
  return resolve(cwd, workspace && workspace.trim().length > 0 ? workspace.trim() : '.')
}

export function serializeSnapshot(snapshot) {
  const entries = snapshot instanceof Map ? snapshot.entries() : snapshot ?? []
  return [...entries].map(([path, metadata]) => ({
    path,
    kind: metadata.kind,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  }))
}

export function deserializeSnapshot(value) {
  if (value instanceof Map) return new Map(value)
  if (!Array.isArray(value)) return new Map()
  return new Map(value.map(entry => [entry.path, Object.freeze({
    kind: entry.kind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
  })]))
}

function sessionOf(agent) { return sessionIdOf(agent) }

/** Runtime adapter that composes durable task state, fixed-rate scheduling and delivery. */
export class MonitorRuntime {
  #service
  #delivery
  #getAgent
  #scan
  #diff
  #format
  #ignore
  #maxEntries
  #maxChanges
  #clock
  #defaultIntervalMs
  #started = false
  #tails = new Map()

  constructor(options = {}) {
    if (!options.service) throw new TypeError('service is required')
    this.#service = options.service
    this.#getAgent = options.getAgent ?? (() => undefined)
    this.#scan = options.scanWorkspace ?? scanWorkspace
    this.#diff = options.diffSnapshots ?? diffSnapshots
    this.#format = options.formatScanReport ?? formatScanReport
    this.#ignore = options.ignore ?? []
    this.#maxEntries = options.maxEntries ?? 100_000
    this.#maxChanges = options.maxChanges ?? 200
    this.#clock = options.clock ?? (() => Date.now())
    this.#defaultIntervalMs = options.defaultIntervalMs ?? DEFAULT_INTERVAL_MS
    assertDefaultInterval(this.#defaultIntervalMs)
    this.#delivery = options.delivery ?? new Delivery({ deliver: async () => {} })
    this.scheduler = options.scheduler ?? new Scheduler({
      clock: this.#clock,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
      runTask: (taskId, context) => this.#withTaskLock(taskId, () => this.#runScheduled(taskId, context)),
      onError: options.onError,
    })
  }

  get service() { return this.#service }
  get delivery() { return this.#delivery }

  async start() {
    await this.#service.ready?.()
    if (this.#started) return
    this.#started = true
    const tasks = await this.#service.listTasks()
    for (const task of tasks) {
      const agent = this.#getAgent(task.agentId)
      if (agent) this.#delivery.bind(task.taskId, agent)
      if (task.status === 'ACTIVE') this.#schedule(task)
    }
  }

  async createTask({ agent, workspace = '.', intervalMs, title } = {}) {
    const sessionId = sessionOf(agent)
    const root = workspaceOf(agent, workspace)
    const scan = await this.#scan(root, { ignore: this.#ignore, maxEntries: this.#maxEntries })
    const cadence = intervalMs ?? this.#defaultIntervalMs
    const task = await this.#service.createTask({
      agentId: sessionId,
      sessionId,
      title: title ?? 'Workspace monitor',
      workspace: scan.root ?? root,
      intervalMs: cadence,
      status: 'ACTIVE',
      nextRunAt: this.#clock() + cadence,
      baseline: serializeSnapshot(scan.snapshot),
    })
    this.#delivery.bind(task.taskId, this.#getAgent(task.agentId) ?? agent)
    this.#schedule(task)
    return task
  }

  async updateTask(taskId, patch = {}, agent) {
    return this.#withTaskLock(taskId, async () => {
      const sessionId = sessionOf(agent)
      const current = await this.#service.getTask(taskId, sessionId)
      if (!current) throw new Error(`task not found in session: ${taskId}`)
      const workspaceChanged = patch.workspace !== undefined
      const root = workspaceChanged ? workspaceOf(agent, patch.workspace) : current.workspace
      const intervalMs = patch.intervalMs ?? current.intervalMs
      const scan = workspaceChanged
        ? await this.#scan(root, { ignore: this.#ignore, maxEntries: this.#maxEntries })
        : undefined
      const nextRunAt = this.#clock() + intervalMs
      const updated = await this.#service.updateTask(taskId, {
        ...patch,
        intervalMs,
        nextRunAt,
        ...(workspaceChanged ? {
          workspace: scan.root ?? root,
          baseline: serializeSnapshot(scan.snapshot),
        } : {}),
      }, sessionId)
      if (updated.status === 'ACTIVE') {
        if (this.scheduler.get(taskId)) this.scheduler.reschedule(taskId, { intervalMs: updated.intervalMs, nextRunAt: updated.nextRunAt })
        else this.#schedule(updated)
      } else if (this.scheduler.get(taskId)) {
        this.scheduler.reschedule(taskId, { intervalMs: updated.intervalMs, nextRunAt: updated.nextRunAt })
      }
      return updated
    })
  }

  async pauseTask(taskId, agent, reason) {
    return this.#withTaskLock(taskId, async () => {
      const pauseReason = reason && typeof reason === 'object' ? reason.reason : reason
      const task = await this.#service.pauseTask(taskId, sessionOf(agent), pauseReason)
      this.scheduler.pause(taskId)
      this.#delivery.cancel(taskId)
      return task
    })
  }

  async resumeTask(taskId, agent) {
    return this.#withTaskLock(taskId, async () => {
      const task = await this.#service.resumeTask(taskId, sessionOf(agent))
      if (this.scheduler.get(taskId)) this.scheduler.resume(taskId)
      else {
        this.#delivery.bind(taskId, this.#getAgent(task.agentId) ?? agent)
        this.scheduler.schedule(taskId, { intervalMs: task.intervalMs, nextRunAt: task.nextRunAt ?? this.#clock() + task.intervalMs, paused: true })
        this.scheduler.resume(taskId)
      }
      return task
    })
  }

  async listTasks(agent) { return this.#service.listTasks({ sessionId: sessionOf(agent) }) }

  async deleteTask(taskId, agent) {
    return this.#withTaskLock(taskId, async () => {
      const deleted = await this.#service.deleteTask(taskId, sessionOf(agent))
      if (deleted) {
        this.scheduler.cancel(taskId)
        this.#delivery.cancel(taskId)
      }
      return deleted
    })
  }

  async runOnce(taskId, context = {}) { return this.#withTaskLock(taskId, () => this.#runScheduled(taskId, context)) }

  async dispose() { await this.scheduler.dispose(); this.#started = false }

  #schedule(task) {
    this.scheduler.schedule(task.taskId, { intervalMs: task.intervalMs, nextRunAt: task.nextRunAt ?? this.#clock() + task.intervalMs })
  }

  async #runScheduled(taskId, context) {
    const task = await this.#service.getTask(taskId)
    if (!task || task.status !== 'ACTIVE') return { skipped: true }
    const scan = await this.#scan(task.workspace, { ignore: this.#ignore, maxEntries: this.#maxEntries })
    const before = deserializeSnapshot(task.baseline)
    const diff = this.#diff(before, scan.snapshot)
    const baseline = mergeSnapshots(before, scan.snapshot)
    const result = Object.freeze({
      root: scan.root,
      scannedAt: context.scheduledAt ?? this.#clock(),
      diff,
      warnings: scan.warnings,
      visitedEntries: scan.visitedEntries,
    })
    const report = [
      `[dsh-workspace-monitor] 任务：${task.taskId}`,
      `标题：${task.title}`,
      `补偿扫描：${context.catchUp === true ? '是' : '否'}`,
      this.#format(result, { maxChanges: this.#maxChanges }),
    ].join('\n')
    const agent = this.#getAgent(task.agentId)
    if (!agent) throw new Error(`agent is not live: ${task.agentId}`)
    this.#delivery.bind(taskId, agent)
    await this.#delivery.enqueue(taskId, report)
    const nextRunAt = context.task?.nextRunAt ?? task.nextRunAt
    return this.#service.recordRun(taskId, {
      lastRunAt: result.scannedAt,
      nextRunAt,
      baseline: serializeSnapshot(baseline),
    }, task.sessionId)
  }

  #withTaskLock(taskId, work) {
    const prior = this.#tails.get(taskId) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(work)
    this.#tails.set(taskId, next)
    return next.finally(() => { if (this.#tails.get(taskId) === next) this.#tails.delete(taskId) })
  }
}
