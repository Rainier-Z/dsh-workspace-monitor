import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const DEFAULT_INTERVAL_MS = 60_000
export const MIN_INTERVAL_MS = 1_000
export const MAX_INTERVAL_MS = 2_147_483_647
export const TASK_STATUSES = Object.freeze(['ACTIVE', 'PAUSED'])
export const RESTART_PAUSE_REASON = 'restart_requires_confirmation'
const TASK_FIELDS = new Set([
  'taskId', 'agentId', 'sessionId', 'title', 'workspace', 'intervalMs', 'status',
  'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt', 'baseline', 'pauseReason',
])

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

function validateTask(task, { checkWorkspace = false } = {}) {
  if (!task || typeof task !== 'object') throw new TaskValidationError('task must be an object')
  if (typeof task.taskId !== 'string' || task.taskId.length === 0) throw new TaskValidationError('taskId is required')
  if (typeof task.sessionId !== 'string' || task.sessionId.length === 0) throw new TaskValidationError('sessionId is required')
  if (typeof task.agentId !== 'string' || task.agentId.length === 0) throw new TaskValidationError('agentId is required')
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
  return task
}

export class TaskStore {
  #table
  #tasks = new Map()
  #tails = new Map()
  #ready

  constructor(input) {
    this.#table = tableFrom(input)
    for (const [taskId, value] of readEntries(this.#table)) this.#tasks.set(taskId, copy(value))
    this.#ready = Promise.all([...this.#tasks]
      .filter(([, task]) => task.status === 'ACTIVE')
      .map(([taskId]) => this.#mutate(taskId, () => this.#recoverActiveTask(taskId))))
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

  async #recoverActiveTask(taskId) {
    const current = this.#tasks.get(taskId)
    if (current === undefined || current.status !== 'ACTIVE') return current
    const updatedAt = Date.now()
    const persisted = await this.#updateTable(taskId, currentValue => {
      const next = { ...currentValue, status: 'PAUSED', pauseReason: RESTART_PAUSE_REASON, updatedAt }
      validateTask(next)
      return next
    })
    const next = persisted ?? { ...current, status: 'PAUSED', pauseReason: RESTART_PAUSE_REASON, updatedAt }
    this.#tasks.set(taskId, copy(next))
    return copy(next)
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
      const value = copy(task)
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
      let persisted
      persisted = await this.#updateTable(taskId, currentValue => {
        const next = { ...currentValue, ...copy(patch) }
        validateTask(next, { checkWorkspace: Object.hasOwn(patch, 'workspace') })
        return next
      })
      const next = persisted ?? { ...current, ...copy(patch) }
      this.#tasks.set(taskId, copy(next))
      return copy(next)
    })
  }

  async updateTask(taskId, patch) { return this.update(taskId, patch) }

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
