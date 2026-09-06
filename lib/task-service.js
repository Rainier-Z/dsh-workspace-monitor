import { randomUUID } from 'node:crypto'
import {
  DEFAULT_INTERVAL_MS,
  TaskStore,
  validateInterval,
  validateWorkspace,
} from './task-store.js'

function notFound(taskId) {
  const error = new Error(`task not found in session: ${taskId}`)
  error.code = 'TASK_NOT_FOUND'
  return error
}

function optionsFor(input) {
  if (input instanceof TaskStore) return { store: input }
  if (input && typeof input.get === 'function' && typeof input.entries === 'function') return { store: new TaskStore(input) }
  return input ?? {}
}

export class TaskService {
  #store
  #ready
  #listeners = new Map()
  #onObserverError

  constructor(input) {
    const options = optionsFor(input)
    this.#store = options.store ?? new TaskStore(options.adapter ?? options.table)
    this.#onObserverError = typeof options.onObserverError === 'function' ? options.onObserverError : () => {}
    this.#ready = typeof this.#store.ready === 'function' ? this.#store.ready() : Promise.resolve()
  }

  get store() { return this.#store }
  async ready() { await this.#ready }
  async initialize() { await this.ready(); return this }

  on(event, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  subscribe(event, listener) { return this.on(event, listener) }

  #reportObserverError(error) {
    try {
      const result = this.#onObserverError(error)
      if (result && typeof result.then === 'function') void result.catch(() => {})
    } catch { /* observer error reporting must never affect task operations */ }
  }

  #emit(event, task) {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        const result = listener(task)
        if (result && typeof result.then === 'function') void result.catch(error => this.#reportObserverError(error))
      } catch (error) { this.#reportObserverError(error) }
    }
  }

  async #owned(taskId, sessionId) {
    await this.ready()
    const task = await this.#store.get(taskId)
    if (task === null || (sessionId !== undefined && task.sessionId !== sessionId)) throw notFound(taskId)
    return task
  }

  async createTask(input, spec) {
    await this.ready()
    const source = typeof input === 'string' ? { ...spec, sessionId: spec?.sessionId ?? input } : { ...input }
    const workspace = validateWorkspace(source.workspace)
    const sessionId = source.sessionId ?? source.agentId
    const agentId = source.agentId ?? sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required')
    if (typeof agentId !== 'string' || agentId.length === 0) throw new TypeError('agentId is required')
    const intervalMs = source.intervalMs ?? DEFAULT_INTERVAL_MS
    validateInterval(intervalMs)
    const now = Date.now()
    const task = await this.#store.create({
      taskId: source.taskId ?? randomUUID(),
      agentId,
      sessionId,
      title: source.title ?? 'Workspace monitor',
      workspace,
      intervalMs,
      status: source.status ?? 'ACTIVE',
      createdAt: source.createdAt ?? now,
      updatedAt: source.updatedAt ?? now,
      lastRunAt: source.lastRunAt ?? null,
      nextRunAt: source.nextRunAt ?? null,
      baseline: source.baseline ?? null,
      pauseReason: source.pauseReason ?? null,
    })
    this.#emit('created', task)
    return task
  }

  async create(input, spec) { return this.createTask(input, spec) }

  async getTask(taskId, sessionId) {
    await this.ready()
    const task = await this.#store.get(taskId)
    if (task === null || (sessionId !== undefined && task.sessionId !== sessionId)) return null
    return task
  }

  async get(taskId, sessionId) { return this.getTask(taskId, sessionId) }

  async listTasks(filter) {
    await this.ready()
    if (typeof filter === 'string') return this.#store.list({ sessionId: filter })
    return this.#store.list(filter ?? {})
  }

  async list(filter) { return this.listTasks(filter) }

  async #applyUpdate(taskId, patch, sessionId, emitUpdated) {
    const current = await this.#owned(taskId, sessionId)
    if (patch.sessionId !== undefined && patch.sessionId !== current.sessionId) throw notFound(taskId)
    if (patch.agentId !== undefined && patch.agentId !== current.agentId) throw notFound(taskId)
    if (patch.workspace !== undefined) validateWorkspace(patch.workspace)
    if (patch.intervalMs !== undefined) validateInterval(patch.intervalMs)
    const next = { ...patch, updatedAt: Date.now() }
    delete next.taskId
    delete next.createdAt
    delete next.sessionId
    delete next.agentId
    const task = await this.#store.update(taskId, next)
    if (emitUpdated) this.#emit('updated', task)
    return task
  }

  async updateTask(taskId, patch = {}, sessionId) { return this.#applyUpdate(taskId, patch, sessionId, true) }

  async update(taskId, patch, sessionId) { return this.updateTask(taskId, patch, sessionId) }

  async recordRun(taskId, runtime = {}, sessionId) {
    const patch = {}
    for (const field of ['lastRunAt', 'nextRunAt', 'baseline']) {
      if (Object.hasOwn(runtime, field)) patch[field] = runtime[field]
    }
    const task = await this.#applyUpdate(taskId, patch, sessionId, false)
    this.#emit('ran', task)
    return task
  }

  async updateRuntime(taskId, runtime, sessionId) { return this.recordRun(taskId, runtime, sessionId) }

  async pauseTask(taskId, sessionOrOptions, maybeReason) {
    const options = sessionOrOptions && typeof sessionOrOptions === 'object' ? sessionOrOptions : {}
    const sessionId = typeof sessionOrOptions === 'string' ? sessionOrOptions : options.sessionId
    await this.#owned(taskId, sessionId)
    const task = await this.#store.update(taskId, {
      status: 'PAUSED',
      pauseReason: maybeReason ?? options.reason ?? 'manual',
      updatedAt: Date.now(),
    })
    this.#emit('paused', task)
    return task
  }

  async pause(taskId, sessionOrOptions, reason) { return this.pauseTask(taskId, sessionOrOptions, reason) }

  async resumeTask(taskId, sessionId) {
    const current = await this.#owned(taskId, sessionId)
    validateWorkspace(current.workspace)
    const task = await this.#store.update(taskId, { status: 'ACTIVE', pauseReason: null, updatedAt: Date.now() })
    this.#emit('resumed', task)
    return task
  }

  async resume(taskId, sessionId) { return this.resumeTask(taskId, sessionId) }

  async deleteTask(taskId, sessionId) {
    const task = await this.#store.get(taskId)
    if (task === null || (sessionId !== undefined && task.sessionId !== sessionId)) return false
    const deleted = await this.#store.delete(taskId)
    if (deleted) this.#emit('deleted', task)
    return deleted
  }

  async delete(taskId, sessionId) { return this.deleteTask(taskId, sessionId) }
}
