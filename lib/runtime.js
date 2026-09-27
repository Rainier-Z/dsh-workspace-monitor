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

function sessionIdOf(owner) {
  const sessionId = typeof owner === 'string' ? owner : owner?.sessionId ?? owner?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required')
  return sessionId
}

function workspaceOf(owner, workspace, cwd) {
  const base = cwd ?? owner?.cwd ?? owner?.session?.header?.cwd ?? process.cwd()
  return resolve(base, workspace && workspace.trim().length > 0 ? workspace.trim() : '.')
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
  #getSessionCwd
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
    this.#getSessionCwd = options.getSessionCwd ?? (() => undefined)
    this.#scan = options.scanWorkspace ?? scanWorkspace
    this.#diff = options.diffSnapshots ?? diffSnapshots
    this.#format = options.formatScanReport ?? formatScanReport
    this.#ignore = options.ignore ?? []
    this.#maxEntries = options.maxEntries ?? 100_000
    this.#maxChanges = options.maxChanges ?? 200
    this.#clock = options.clock ?? (() => Date.now())
    this.#defaultIntervalMs = options.defaultIntervalMs ?? DEFAULT_INTERVAL_MS
    assertDefaultInterval(this.#defaultIntervalMs)
    this.#delivery = options.delivery ?? new Delivery({
      service: this.#service,
      resolveAgent: options.resolveAgent ?? (() => undefined),
      deliver: async () => {},
    })
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
      if (task.status === 'ACTIVE') this.#schedule(task)
    }
    void Promise.resolve(this.#delivery.recover?.()).catch(() => {})
  }

  async createTask({ agent, sessionId: requestedSessionId, workspace = '.', cwd, intervalMs, title } = {}) {
    const sessionId = sessionOf(requestedSessionId ?? agent)
    const root = workspaceOf(agent, workspace, cwd ?? this.#getSessionCwd(sessionId))
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
    this.#schedule(task)
    return task
  }

  async updateTask(taskId, patch = {}, agent) {
    return this.#withTaskLock(taskId, async () => {
      const sessionId = sessionOf(agent)
      const current = await this.#service.getTask(taskId, sessionId)
      if (!current) throw new Error(`task not found in session: ${taskId}`)
      const workspaceChanged = patch.workspace !== undefined
      const root = workspaceChanged ? workspaceOf(agent, patch.workspace, this.#getSessionCwd(sessionId)) : current.workspace
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
      return task
    })
  }

  async resumeTask(taskId, agent) {
    return this.#withTaskLock(taskId, async () => {
      const task = await this.#service.resumeTask(taskId, sessionOf(agent))
      if (this.scheduler.get(taskId)) this.scheduler.resume(taskId)
      else {
        this.scheduler.schedule(taskId, { intervalMs: task.intervalMs, nextRunAt: task.nextRunAt ?? this.#clock() + task.intervalMs, paused: true })
        this.scheduler.resume(taskId)
      }
      return task
    })
  }

  async listTasks(owner) { return this.#service.listTasks({ sessionId: sessionOf(owner) }) }

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

  async dispose() { await this.scheduler.dispose(); await this.#delivery.dispose?.(); this.#started = false }

  #schedule(task) {
    this.scheduler.schedule(task.taskId, { intervalMs: task.intervalMs, nextRunAt: task.nextRunAt ?? this.#clock() + task.intervalMs })
  }

  async #runScheduled(taskId, context) {
    const task = await this.#service.getTask(taskId)
    if (!task || task.status !== 'ACTIVE') return { skipped: true }
    const scannedAt = context.scheduledAt ?? this.#clock()
    const nextRunAt = context.task?.nextRunAt ?? task.nextRunAt ?? scannedAt + task.intervalMs
    let observation
    try {
      const scan = await this.#scan(task.workspace, { ignore: this.#ignore, maxEntries: this.#maxEntries })
      const before = deserializeSnapshot(task.baseline)
      const diff = this.#diff(before, scan.snapshot)
      const baseline = mergeSnapshots(before, scan.snapshot)
      const result = Object.freeze({
        root: scan.root,
        scannedAt,
        diff,
        warnings: scan.warnings,
        visitedEntries: scan.visitedEntries,
      })
      const report = this.#format(result, { maxChanges: this.#maxChanges })
      observation = {
        baseline: serializeSnapshot(baseline),
        lastRunAt: scannedAt,
        nextRunAt,
        report,
        count: 1,
        observedAt: scannedAt,
      }
    } catch (error) {
      observation = {
        baseline: task.baseline,
        lastRunAt: scannedAt,
        nextRunAt,
        report: [
          '工作区监测扫描失败',
          `工作区：${task.workspace}`,
          `扫描时间：${new Date(scannedAt).toISOString()}`,
          `错误：${error instanceof Error ? error.message : String(error)}`,
        ].join('\n'),
        count: 1,
        observedAt: scannedAt,
      }
    }
    const committed = await this.#service.recordObservation(taskId, observation, task.sessionId)
    void Promise.resolve(this.#delivery.request?.(taskId)).catch(() => {})
    return committed
  }

  #withTaskLock(taskId, work) {
    const prior = this.#tails.get(taskId) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(work)
    this.#tails.set(taskId, next)
    return next.finally(() => { if (this.#tails.get(taskId) === next) this.#tails.delete(taskId) })
  }
}
