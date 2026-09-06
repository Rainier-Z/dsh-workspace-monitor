const MAX_TIMER_DELAY_MS = 2_147_483_647

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new TypeError('taskId must be a non-empty string')
  }
}

function assertInterval(intervalMs) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new RangeError('intervalMs must be a safe integer of at least 1000ms')
  }
}

function view(state) {
  return Object.freeze({
    taskId: state.taskId,
    intervalMs: state.intervalMs,
    nextRunAt: state.nextRunAt,
    status: state.status,
    running: state.running,
  })
}

/**
 * Fixed-rate task scheduler. Timers are disposable projections of nextRunAt;
 * the absolute timestamp remains the source of truth and prevents drift.
 */
export class Scheduler {
  #tasks = new Map()
  #clock
  #setTimeout
  #clearTimeout
  #runTask
  #onError
  #disposed = false

  constructor(options = {}) {
    this.#clock = options.clock ?? (() => Date.now())
    this.#setTimeout = options.setTimeout ?? setTimeout
    this.#clearTimeout = options.clearTimeout ?? clearTimeout
    this.#runTask = options.runTask ?? (async () => {})
    this.#onError = options.onError ?? (() => {})
  }

  schedule(taskId, options = {}) {
    assertTaskId(taskId)
    assertInterval(options.intervalMs)
    if (this.#disposed) throw new Error('scheduler is disposed')
    const existing = this.#tasks.get(taskId)
    if (existing) this.#clear(existing)
    const now = this.#clock()
    const state = {
      taskId,
      intervalMs: options.intervalMs,
      nextRunAt: options.nextRunAt ?? now + options.intervalMs,
      status: options.paused ? 'PAUSED' : 'ACTIVE',
      running: false,
      pending: false,
      generation: 0,
      epoch: 0,
      timer: undefined,
      operation: undefined,
      scheduledAt: undefined,
    }
    if (!Number.isFinite(state.nextRunAt)) throw new RangeError('nextRunAt must be finite')
    this.#tasks.set(taskId, state)
    if (state.status === 'ACTIVE') this.#arm(state)
    return view(state)
  }

  reschedule(taskId, options = {}) {
    const state = this.#tasks.get(taskId)
    if (!state) return false
    assertInterval(options.intervalMs)
    this.#clear(state)
    state.epoch += 1
    state.pending = false
    state.intervalMs = options.intervalMs
    state.nextRunAt = options.nextRunAt ?? this.#clock() + options.intervalMs
    state.generation += 1
    if (state.status === 'ACTIVE') this.#arm(state)
    return view(state)
  }

  cancel(taskId) {
    const state = this.#tasks.get(taskId)
    if (!state) return false
    this.#clear(state)
    state.epoch += 1
    this.#tasks.delete(taskId)
    state.status = 'DELETED'
    state.generation += 1
    return true
  }

  pause(taskId) {
    const state = this.#tasks.get(taskId)
    if (!state) return false
    this.#clear(state)
    state.epoch += 1
    state.status = 'PAUSED'
    state.pending = false
    return view(state)
  }

  /** Resume immediately with one catch-up scan, then continue at a fixed rate. */
  resume(taskId) {
    const state = this.#tasks.get(taskId)
    if (!state) return false
    if (state.status === 'ACTIVE') return view(state)
    state.status = 'ACTIVE'
    state.pending = false
    state.epoch += 1
    state.nextRunAt = this.#clock() + state.intervalMs
    this.#clear(state)
    this.#arm(state)
    void this.#fire(state, { catchUp: true, scheduledAt: this.#clock() })
    return view(state)
  }

  get(taskId) {
    const state = this.#tasks.get(taskId)
    return state ? view(state) : undefined
  }

  list() {
    return Object.freeze([...this.#tasks.values()].map(view))
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    const operations = []
    for (const state of this.#tasks.values()) {
      this.#clear(state)
      state.epoch += 1
      state.status = 'PAUSED'
      if (state.operation) operations.push(state.operation)
    }
    this.#tasks.clear()
    await Promise.allSettled(operations)
  }

  #clear(state) {
    if (state.timer !== undefined) {
      this.#clearTimeout(state.timer)
      state.timer = undefined
    }
    state.generation += 1
  }

  #arm(state) {
    if (this.#disposed || state.status !== 'ACTIVE' || state.timer !== undefined) return
    const generation = ++state.generation
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, state.nextRunAt - this.#clock()))
    state.timer = this.#setTimeout(() => {
      if (this.#disposed || this.#tasks.get(state.taskId) !== state || state.generation !== generation) return
      state.timer = undefined
      const scheduledAt = state.nextRunAt
      let next = scheduledAt + state.intervalMs
      const now = this.#clock()
      if (next <= now) next += Math.ceil((now - next + 1) / state.intervalMs) * state.intervalMs
      state.nextRunAt = next
      this.#arm(state)
      void this.#fire(state, { catchUp: false, scheduledAt })
    }, delay)
    state.timer?.unref?.()
  }

  async #fire(state, { catchUp, scheduledAt }) {
    if (this.#disposed || this.#tasks.get(state.taskId) !== state || state.status !== 'ACTIVE') return
    if (state.running) {
      state.pending = true
      return
    }
    const epoch = state.epoch
    state.running = true
    state.scheduledAt = scheduledAt
    const operation = Promise.resolve()
      .then(() => this.#runTask(state.taskId, Object.freeze({
        scheduledAt,
        catchUp,
        task: view(state),
      })))
      .catch(async error => {
        if (this.#tasks.get(state.taskId) !== state || state.epoch !== epoch || state.status !== 'ACTIVE') return
        try { await this.#onError(error, state.taskId, scheduledAt) } catch { /* observer errors must not escape the timer */ }
      })
      .finally(() => {
        if (state.operation === operation) state.operation = undefined
        state.running = false
        if (this.#disposed || this.#tasks.get(state.taskId) !== state || state.status !== 'ACTIVE') return
        if (state.pending) {
          state.pending = false
          void this.#fire(state, { catchUp: true, scheduledAt: this.#clock() })
          return
        }
        if (state.epoch !== epoch) return
        this.#arm(state)
      })
    state.operation = operation
    await operation
  }
}
