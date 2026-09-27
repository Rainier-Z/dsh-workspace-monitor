import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const DEFAULT_INTERVAL_MS = 60_000
export const MIN_INTERVAL_MS = 1_000
export const MAX_INTERVAL_MS = 2_147_483_647
export const TASK_STATUSES = Object.freeze(['ACTIVE', 'PAUSED'])
export const DEFAULT_MAX_PENDING_REPORT_LENGTH = 20_000
const TASK_FIELDS = new Set([
  'taskId', 'agentId', 'sessionId', 'title', 'workspace', 'intervalMs', 'status',
  'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt', 'baseline', 'pauseReason',
  'pendingDelivery', 'lastDeliveredAt', 'lastDeliveryMessageId',
])
const LEGACY_AUTO_RESUME_REASONS = new Set(['restart_requires_confirmation', 'agent_disposed'])

function copy(value) {
  if (value === undefined || value === null) return value
  try {
    return structuredClone(value)
  } catch {
    if (Array.isArray(value)) return value.map(copy)
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
    return value
  }
}

export class TaskValidationError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'TaskValidationError'
  }
}

export class MemoryTaskTable {
  #values = new Map()
  failUpdates = false

  constructor(entries = []) {
    for (const [key, value] of entries) this.#values.set(key, copy(value))
  }

  get(key) { return copy(this.#values.get(key)) }
  entries() { return [...this.#values.entries()].map(([key, value]) => [key, copy(value)]) }
  keys() { return [...this.#values.keys()] }
  get size() { return this.#values.size }

  async put(key, value) {
    this.#values.set(key, copy(value))
  }

  async update(key, updater) {
    if (this.failUpdates) throw new Error('update failed')
    if (!this.#values.has(key)) throw new Error(`task not found: ${key}`)
    if (typeof updater !== 'function') throw new TypeError('update requires an updater function')
    const next = updater(copy(this.#values.get(key)))
    this.#values.set(key, copy(next))
    return copy(next)
  }

  async delete(key) { return this.#values.delete(key) }
}

export function createMemoryTaskTable(entries) {
  return new MemoryTaskTable(entries)
}

export const MemoryTaskAdapter = MemoryTaskTable
export const createMemoryTaskAdapter = createMemoryTaskTable

function tableFrom(input) {
  if (input === undefined) return new MemoryTaskTable()
  if (input.adapter !== undefined) return input.adapter
  if (input.table !== undefined) return input.table
  return input
}

function readEntries(table) {
  if (typeof table.entries !== 'function') return []
  return [...table.entries()]
}

function errorForTask(taskId) {
  const error = new Error(`task not found: ${taskId}`)
  error.code = 'TASK_NOT_FOUND'
  return error
}

export function validateInterval(intervalMs) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new TaskValidationError(`intervalMs must be a safe integer between ${MIN_INTERVAL_MS}ms and ${MAX_INTERVAL_MS}ms`)
  }
  return intervalMs
}

export function validateWorkspace(workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
    throw new TaskValidationError('workspace must be an absolute path')
  }
  let info
  try {
    info = statSync(workspace)
  } catch {
    throw new TaskValidationError(`workspace does not exist: ${workspace}`)
  }
  if (!info.isDirectory()) throw new TaskValidationError(`workspace is not a directory: ${workspace}`)
  return workspace
}

function validateBaseline(baseline) {
  if (baseline === null) return
  if (!Array.isArray(baseline)) throw new TaskValidationError('baseline must be null or an array of snapshot entries')
  for (const entry of baseline) {
    if (entry === null || typeof entry !== 'object' || entry instanceof Map || entry instanceof Date) {
      throw new TaskValidationError('baseline entries must be JSON-safe objects')
    }
    const keys = Object.keys(entry).sort()
    if (keys.join(',') !== 'kind,mtimeMs,path,size') throw new TaskValidationError('baseline entry has unknown or missing fields')
    if (typeof entry.path !== 'string' || entry.path.length === 0) throw new TaskValidationError('baseline entry path must be a string')
    if (!['file', 'symlink'].includes(entry.kind)) throw new TaskValidationError(`invalid baseline entry kind: ${entry.kind}`)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new TaskValidationError('baseline entry size must be a non-negative integer')
    if (!Number.isSafeInteger(entry.mtimeMs) || entry.mtimeMs < 0) throw new TaskValidationError('baseline entry mtimeMs must be a non-negative integer')
  }
}

function validatePendingDelivery(pendingDelivery) {
  if (pendingDelivery === null || pendingDelivery === undefined) return
  if (!pendingDelivery || typeof pendingDelivery !== 'object' || Array.isArray(pendingDelivery)) {
    throw new TaskValidationError('pendingDelivery must be null or an object')
  }
  const keys = Object.keys(pendingDelivery).sort()
  if (keys.join(',') !== 'count,firstObservedAt,lastObservedAt,report,revision') {
    throw new TaskValidationError('pendingDelivery has unknown or missing fields')
  }
  if (!Number.isSafeInteger(pendingDelivery.revision) || pendingDelivery.revision < 1) {
    throw new TaskValidationError('pendingDelivery revision must be a positive safe integer')
  }
  if (typeof pendingDelivery.report !== 'string') throw new TaskValidationError('pendingDelivery report must be a string')
  if (!Number.isSafeInteger(pendingDelivery.count) || pendingDelivery.count < 1) {
    throw new TaskValidationError('pendingDelivery count must be a positive safe integer')
  }
  for (const field of ['firstObservedAt', 'lastObservedAt']) {
    if (!Number.isSafeInteger(pendingDelivery[field]) || pendingDelivery[field] < 0) {
      throw new TaskValidationError(`pendingDelivery ${field} must be a non-negative safe integer`)
    }
  }
}

function validateDeliveryMetadata(task) {
  if (task.lastDeliveredAt !== undefined && task.lastDeliveredAt !== null
    && (!Number.isSafeInteger(task.lastDeliveredAt) || task.lastDeliveredAt < 0)) {
    throw new TaskValidationError('lastDeliveredAt must be a non-negative safe integer or null')
  }
  if (task.lastDeliveryMessageId !== undefined && task.lastDeliveryMessageId !== null
    && typeof task.lastDeliveryMessageId !== 'string') {
    throw new TaskValidationError('lastDeliveryMessageId must be a string or null')
  }
}

function normalizeTask(task) {
  const normalized = {
    ...copy(task),
    pendingDelivery: task.pendingDelivery ?? null,
    lastDeliveredAt: task.lastDeliveredAt ?? null,
    lastDeliveryMessageId: task.lastDeliveryMessageId ?? null,
  }
  if (normalized.status === 'PAUSED' && LEGACY_AUTO_RESUME_REASONS.has(normalized.pauseReason)) {
    normalized.status = 'ACTIVE'
    normalized.pauseReason = null
    normalized.updatedAt = Date.now()
  }
  return normalized
}

function bound(value, maxLength) {
  const text = String(value)
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function mergePendingReport(previous, next, count, maxLength) {
  const prefix = `${count} reports merged\n`
  if (prefix.length >= maxLength) return bound(prefix, maxLength)
  const full = `${prefix}${previous}\n${next}`
  if (full.length <= maxLength) return full
  const previousBody = previous.replace(/^\d+ reports merged\n/, '')
  if (previousBody.includes(next)) {
    const repeated = `${prefix}${previousBody}`
    if (repeated.length <= maxLength) return repeated
  }
  const available = maxLength - prefix.length - 1
  const previousLength = Math.ceil(available / 2)
  const nextLength = Math.floor(available / 2)
  return `${prefix}${bound(previous, previousLength)}\n${bound(next, nextLength)}`
}

function validateTask(task, { checkWorkspace = false } = {}) {
  if (!task || typeof task !== 'object') throw new TaskValidationError('task must be an object')
  if (typeof task.taskId !== 'string' || task.taskId.length === 0) throw new TaskValidationError('taskId is required')
  if (typeof task.sessionId !== 'string' || task.sessionId.length === 0) throw new TaskValidationError('sessionId is required')
  if (task.agentId !== undefined && (typeof task.agentId !== 'string' || task.agentId.length === 0)) {
    throw new TaskValidationError('agentId must be a non-empty string when provided')
  }
  if (typeof task.title !== 'string') throw new TaskValidationError('title must be a string')
  if (typeof task.workspace !== 'string' || !isAbsolute(task.workspace)) {
    throw new TaskValidationError('workspace must be an absolute path')
  }
  if (checkWorkspace) validateWorkspace(task.workspace)
  validateInterval(task.intervalMs)
  if (!TASK_STATUSES.includes(task.status)) throw new TaskValidationError(`invalid task status: ${task.status}`)
  for (const field of ['createdAt', 'updatedAt']) {
    if (!Number.isFinite(task[field])) throw new TaskValidationError(`${field} must be a timestamp`)
  }
  for (const field of ['lastRunAt', 'nextRunAt']) {
    if (task[field] !== null && !Number.isFinite(task[field])) throw new TaskValidationError(`${field} must be a timestamp or null`)
  }
  validateBaseline(task.baseline)
  validatePendingDelivery(task.pendingDelivery)
  validateDeliveryMetadata(task)
  return task
}

export class TaskStore {
  #table
  #tasks = new Map()
  #tails = new Map()
  #ready

  constructor(input) {
    this.#table = tableFrom(input)
    const entries = readEntries(this.#table)
    for (const [taskId, value] of entries) this.#tasks.set(taskId, normalizeTask(value))
    this.#ready = Promise.all(entries.map(([taskId, value]) => this.#normalizeStoredTask(taskId, value)))
  }

  async ready() { await this.#ready }

  async initialize() { await this.ready(); return this }
  async recover() { await this.ready(); return this.list() }

  #mutate(taskId, operation) {
    const previous = this.#tails.get(taskId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.#tails.set(taskId, tail)
    void tail.then(() => {
      if (this.#tails.get(taskId) === tail) this.#tails.delete(taskId)
    })
    return result
  }

  async #normalizeStoredTask(taskId, original) {
    const normalizedOriginal = normalizeTask(original)
    if (JSON.stringify(original) === JSON.stringify(normalizedOriginal)) return
    let computed
    const persisted = await this.#updateTable(taskId, currentValue => {
      computed = normalizeTask(currentValue)
      validateTask(computed)
      return computed
    })
    const next = persisted ?? computed ?? normalizedOriginal
    this.#tasks.set(taskId, copy(next))
  }

  async #putTable(taskId, value) {
    if (typeof this.#table.put === 'function') return this.#table.put(taskId, copy(value))
    if (typeof this.#table.set === 'function') return this.#table.set(taskId, copy(value))
    throw new TypeError('task table must implement put')
  }

  async #updateTable(taskId, updater) {
    if (typeof this.#table.update === 'function') return this.#table.update(taskId, current => updater(copy(current)))
    const current = this.#tasks.get(taskId)
    return this.#putTable(taskId, updater(copy(current)))
  }

  async #deleteTable(taskId) {
    if (typeof this.#table.delete === 'function') return this.#table.delete(taskId)
    throw new TypeError('task table must implement delete')
  }

  async create(task) {
    await this.ready()
    return this.#mutate(task.taskId, async () => {
      validateTask(task, { checkWorkspace: true })
      if (this.#tasks.has(task.taskId)) throw new Error(`task already exists: ${task.taskId}`)
      const value = normalizeTask(task)
      validateTask(value, { checkWorkspace: true })
      await this.#putTable(task.taskId, value)
      this.#tasks.set(task.taskId, value)
      return copy(value)
    })
  }

  async createTask(task) { return this.create(task) }

  async get(taskId) {
    await this.ready()
    return this.#tasks.has(taskId) ? copy(this.#tasks.get(taskId)) : null
  }

  async getTask(taskId) { return this.get(taskId) }

  async list(filter = {}) {
    await this.ready()
    const criteria = typeof filter === 'string' ? { sessionId: filter } : filter
    return [...this.#tasks.values()]
      .filter(task => criteria.sessionId === undefined || task.sessionId === criteria.sessionId)
      .filter(task => criteria.agentId === undefined || task.agentId === criteria.agentId)
      .map(copy)
  }

  async listTasks(filter) { return this.list(filter) }

  async entries() {
    await this.ready()
    return [...this.#tasks.entries()].map(([key, value]) => [key, copy(value)])
  }

  async keys() {
    await this.ready()
    return [...this.#tasks.keys()]
  }

  get size() { return this.#tasks.size }

  async update(taskId, patch) {
    await this.ready()
    return this.#mutate(taskId, async () => {
      const current = this.#tasks.get(taskId)
      if (current === undefined) throw errorForTask(taskId)
      if (patch === null || typeof patch !== 'object') throw new TaskValidationError('update patch must be an object')
      for (const key of Object.keys(patch)) {
        if (!TASK_FIELDS.has(key)) throw new TaskValidationError(`unknown task field in update: ${key}`)
      }
      if (patch.taskId !== undefined && patch.taskId !== current.taskId) throw new TaskValidationError('taskId cannot be changed')
      if (patch.createdAt !== undefined && patch.createdAt !== current.createdAt) throw new TaskValidationError('createdAt cannot be changed')
      if (patch.sessionId !== undefined && patch.sessionId !== current.sessionId) throw new TaskValidationError('sessionId cannot be changed')
      if (patch.agentId !== undefined && patch.agentId !== current.agentId) throw new TaskValidationError('agentId cannot be changed')
      let computed
      let persisted
      persisted = await this.#updateTable(taskId, currentValue => {
        const next = normalizeTask({ ...currentValue, ...copy(patch) })
        validateTask(next, { checkWorkspace: Object.hasOwn(patch, 'workspace') })
        computed = next
        return next
      })
      const next = persisted ?? computed ?? normalizeTask({ ...current, ...copy(patch) })
      this.#tasks.set(taskId, copy(next))
      return copy(next)
    })
  }

  async updateTask(taskId, patch) { return this.update(taskId, patch) }

  async recordObservation(taskId, observation, sessionId) {
    await this.ready()
    return this.#mutate(taskId, async () => {
      if (!this.#tasks.has(taskId)) throw errorForTask(taskId)
      if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
        throw new TaskValidationError('observation must be an object')
      }
      const allowed = new Set(['baseline', 'lastRunAt', 'nextRunAt', 'report', 'count', 'observedAt', 'maxReportLength'])
      for (const key of Object.keys(observation)) {
        if (!allowed.has(key)) throw new TaskValidationError(`unknown observation field: ${key}`)
      }
      if (observation.report !== undefined && observation.report !== null && typeof observation.report !== 'string') {
        throw new TaskValidationError('observation report must be a string or null')
      }
      const count = observation.count ?? 1
      if (!Number.isSafeInteger(count) || count < 0) throw new TaskValidationError('observation count must be a non-negative safe integer')
      const observedAt = observation.observedAt ?? Date.now()
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new TaskValidationError('observedAt must be a non-negative safe integer')
      const maxReportLength = observation.maxReportLength ?? DEFAULT_MAX_PENDING_REPORT_LENGTH
      if (!Number.isSafeInteger(maxReportLength) || maxReportLength < 1) throw new TaskValidationError('maxReportLength must be a positive safe integer')
      if (observation.lastRunAt !== undefined && (!Number.isSafeInteger(observation.lastRunAt) || observation.lastRunAt < 0)) {
        throw new TaskValidationError('lastRunAt must be a non-negative safe integer')
      }
      if (observation.nextRunAt !== undefined && observation.nextRunAt !== null
        && (!Number.isSafeInteger(observation.nextRunAt) || observation.nextRunAt < 0)) {
        throw new TaskValidationError('nextRunAt must be a non-negative safe integer or null')
      }
      if (Object.hasOwn(observation, 'baseline')) validateBaseline(observation.baseline)
      if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0)) throw new TypeError('sessionId must be a non-empty string')

      let computed
      const persisted = await this.#updateTable(taskId, currentValue => {
        const current = normalizeTask(currentValue)
        if (sessionId !== undefined && current.sessionId !== sessionId) throw errorForTask(taskId)
        const next = { ...current }
        for (const field of ['baseline', 'lastRunAt', 'nextRunAt']) {
          if (Object.hasOwn(observation, field)) next[field] = copy(observation[field])
        }
        const report = observation.report
        if (typeof report === 'string' && report.length > 0) {
          if (count < 1) throw new TaskValidationError('observation count must be positive when report is provided')
          const previous = current.pendingDelivery
          const deliveryCount = (previous?.count ?? 0) + count
          const mergedReport = previous === null
            ? bound(report, maxReportLength)
            : bound(mergePendingReport(previous.report, report, deliveryCount, maxReportLength), maxReportLength)
          next.pendingDelivery = {
            revision: (previous?.revision ?? 0) + 1,
            report: mergedReport,
            count: deliveryCount,
            firstObservedAt: previous?.firstObservedAt ?? observedAt,
            lastObservedAt: observedAt,
          }
        }
        next.updatedAt = Date.now()
        validateTask(next)
        computed = next
        return next
      })
      const next = persisted ?? computed
      if (next === undefined) throw errorForTask(taskId)
      this.#tasks.set(taskId, copy(next))
      return copy(next)
    })
  }

  async ackDelivery(taskId, revision, deliveryMeta = {}, sessionId) {
    await this.ready()
    return this.#mutate(taskId, async () => {
      if (!this.#tasks.has(taskId)) throw errorForTask(taskId)
      if (!Number.isSafeInteger(revision) || revision < 1) throw new TaskValidationError('revision must be a positive safe integer')
      if (!deliveryMeta || typeof deliveryMeta !== 'object' || Array.isArray(deliveryMeta)) {
        throw new TaskValidationError('deliveryMeta must be an object')
      }
      const deliveredAt = deliveryMeta.deliveredAt ?? deliveryMeta.lastDeliveredAt ?? Date.now()
      const messageId = deliveryMeta.messageId ?? deliveryMeta.lastDeliveryMessageId ?? null
      if (!Number.isSafeInteger(deliveredAt) || deliveredAt < 0) throw new TaskValidationError('deliveredAt must be a non-negative safe integer')
      if (messageId !== null && typeof messageId !== 'string') throw new TaskValidationError('messageId must be a string or null')
      let computed
      let acknowledged = false
      const persisted = await this.#updateTable(taskId, currentValue => {
        const current = normalizeTask(currentValue)
        if (sessionId !== undefined && current.sessionId !== sessionId) throw errorForTask(taskId)
        if (current.pendingDelivery?.revision !== revision) {
          computed = current
          return current
        }
        acknowledged = true
        computed = {
          ...current,
          pendingDelivery: null,
          lastDeliveredAt: deliveredAt,
          lastDeliveryMessageId: messageId,
          updatedAt: Date.now(),
        }
        validateTask(computed)
        return computed
      })
      const next = persisted ?? computed
      if (next === undefined) throw errorForTask(taskId)
      this.#tasks.set(taskId, copy(next))
      return { acknowledged, task: copy(next) }
    })
  }

  async delete(taskId) {
    await this.ready()
    return this.#mutate(taskId, async () => {
      if (!this.#tasks.has(taskId)) return false
      await this.#deleteTable(taskId)
      this.#tasks.delete(taskId)
      return true
    })
  }

  async deleteTask(taskId) { return this.delete(taskId) }
}
