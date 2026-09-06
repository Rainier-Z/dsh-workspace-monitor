function defaultMerge(previous, next, count, maxLength) {
  const prefix = `${count} reports merged\n`
  if (prefix.length >= maxLength) return bound(prefix, maxLength)
  const previousText = String(previous)
  const nextText = String(next)
  const full = `${prefix}${previousText}\n${nextText}`
  if (full.length <= maxLength) return full

  const previousBody = previousText.replace(/^\d+ reports merged\n/, '')
  if (previousBody.includes(nextText)) {
    const repeated = `${prefix}${previousBody}`
    if (repeated.length <= maxLength) return repeated
  }

  const available = maxLength - prefix.length - 1
  const previousLength = Math.ceil(available / 2)
  const nextLength = Math.floor(available / 2)
  return `${prefix}${bound(previousText, previousLength)}\n${bound(nextText, nextLength)}`
}

function bound(value, maxLength) {
  const text = String(value)
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

/** Per-task report delivery with one bounded pending summary while an agent is busy. */
export class Delivery {
  #deliver
  #isBusy
  #whenIdle
  #maxReportLength
  #merge
  #tasks = new Map()
  #waiting = new Map()

  constructor(options = {}) {
    if (typeof options.deliver !== 'function') throw new TypeError('deliver must be a function')
    this.#deliver = options.deliver
    this.#isBusy = options.isBusy ?? (() => false)
    this.#whenIdle = options.whenIdle ?? (async () => {})
    this.#maxReportLength = options.maxReportLength ?? 20_000
    if (!Number.isSafeInteger(this.#maxReportLength) || this.#maxReportLength < 1) throw new RangeError('maxReportLength must be a positive safe integer')
    this.#merge = options.mergeReports ?? defaultMerge
  }

  bind(taskId, agent) {
    const previous = this.#tasks.get(taskId)
    if (previous?.agent === agent) return
    if (previous) {
      previous.generation += 1
      previous.pending = undefined
    }
    this.#tasks.set(taskId, { taskId, agent, pending: undefined, delivering: false, generation: 0 })
  }

  enqueue(taskId, report, options = {}) {
    let state = this.#tasks.get(taskId)
    if (!state) {
      if (options.agent === undefined) throw new Error(`task ${taskId} is not bound to an agent`)
      this.bind(taskId, options.agent)
      state = this.#tasks.get(taskId)
    } else if (options.agent !== undefined && options.agent !== state.agent) {
      throw new Error(`task ${taskId} is already bound to another agent`)
    }
    if (state.pending !== undefined || state.delivering || this.#isBusy(state.agent)) {
      state.pending = state.pending === undefined
        ? { report, count: 1 }
        : { report: bound(this.#merge(state.pending.report, report, state.pending.count + 1, this.#maxReportLength), this.#maxReportLength), count: state.pending.count + 1 }
      this.#waitForIdle(state)
      return Promise.resolve({ queued: true, pending: true })
    }
    state.delivering = true
    return Promise.resolve().then(() => this.#deliver(state.agent, report, Object.freeze({ taskId, count: 1 })))
      .finally(() => {
        state.delivering = false
        if (this.#tasks.get(taskId) === state) void this.#flushState(state).catch(() => {})
      })
  }

  pendingCount(taskId) {
    return this.#tasks.get(taskId)?.pending === undefined ? 0 : 1
  }

  cancel(taskId) {
    const state = this.#tasks.get(taskId)
    if (!state) return false
    state.generation += 1
    state.pending = undefined
    this.#tasks.delete(taskId)
    return true
  }

  async flush() {
    await Promise.allSettled([...this.#tasks.values()].map(state => this.#flushState(state)))
  }

  async #flushState(state) {
    if (this.#tasks.get(state.taskId) !== state || state.pending === undefined || state.delivering) return
    if (this.#isBusy(state.agent)) {
      this.#waitForIdle(state)
      return
    }
    const pending = state.pending
    state.pending = undefined
    state.delivering = true
    try {
      await this.#deliver(state.agent, bound(pending.report, this.#maxReportLength), Object.freeze({ taskId: state.taskId, count: pending.count, merged: pending.count > 1 }))
    } finally {
      state.delivering = false
      if (this.#tasks.get(state.taskId) === state && state.pending !== undefined) void this.#flushState(state).catch(() => {})
    }
  }

  #waitForIdle(state) {
    if (this.#waiting.has(state.taskId)) return
    const generation = state.generation
    let wait
    wait = Promise.resolve().then(() => this.#whenIdle(state.agent))
      .then(() => {
        if (this.#tasks.get(state.taskId) === state && state.generation === generation) return this.#flushState(state)
      })
      .catch(() => {})
      .finally(() => { if (this.#waiting.get(state.taskId) === wait) this.#waiting.delete(state.taskId) })
    this.#waiting.set(state.taskId, wait)
  }
}
