/**
 * Durable session-scoped report delivery. Pending reports live on the task;
 * this class only drives delivery and acknowledges the exact sent revision.
 */
export class Delivery {
  #service
  #resolveAgent
  #deliver
  #sessions
  #isBusy
  #whenIdle
  #clock
  #requests = new Map()
  #disposed = false
  #disposeWait
  #releaseDisposeWait

  constructor(options = {}) {
    if (!options.service) throw new TypeError('service is required')
    if (typeof options.deliver !== 'function') throw new TypeError('deliver must be a function')
    this.#service = options.service
    this.#resolveAgent = options.resolveAgent ?? (async () => undefined)
    if (typeof this.#resolveAgent !== 'function') throw new TypeError('resolveAgent must be a function')
    this.#deliver = options.deliver
    this.#sessions = options.sessions
    this.#isBusy = options.isBusy ?? (agent => agent?.status === 'running')
    this.#whenIdle = options.whenIdle ?? (agent => agent?.whenIdle?.() ?? Promise.resolve())
    this.#clock = options.clock ?? (() => Date.now())
    this.#disposeWait = new Promise(resolve => { this.#releaseDisposeWait = resolve })
  }

  /** Request delivery; concurrent requests for one task share a single driver. */
  request(taskId) {
    if (this.#disposed) return Promise.resolve({ pending: true, disposed: true })
    const existing = this.#requests.get(taskId)
    if (existing) return existing.promise
    const state = { cancelled: false, promise: undefined }
    state.promise = Promise.resolve()
      .then(() => this.#drive(taskId, state))
      .finally(() => {
        if (this.#requests.get(taskId) === state) this.#requests.delete(taskId)
      })
    this.#requests.set(taskId, state)
    return state.promise
  }

  /** Retry all durable pending deliveries after runtime startup. */
  async recover() {
    if (this.#disposed) return []
    const tasks = await this.#service.listTasks()
    return Promise.allSettled(tasks
      .filter(task => task.pendingDelivery)
      .map(task => this.request(task.taskId)))
  }

  /** Cancel only the in-memory attempt. The durable pending report is retained. */
  cancel(taskId) {
    const state = this.#requests.get(taskId)
    if (!state) return false
    state.cancelled = true
    return true
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#releaseDisposeWait()
    await Promise.allSettled([...this.#requests.values()].map(state => state.promise))
  }

  async #drive(taskId, state) {
    // If a newer observation lands while an older revision is being sent,
    // ackDelivery rejects the stale revision and this loop sends the latest.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (this.#disposed || state.cancelled) return { pending: true, cancelled: true }
      const task = await this.#service.getTask(taskId)
      if (!task?.pendingDelivery) return { pending: false }
      const pending = task.pendingDelivery
      let resolved
      try { resolved = await this.#resolveAgent(task.sessionId) } catch {
        return { pending: true, reason: 'agent_unavailable', revision: pending.revision }
      }
      if (resolved?.error) return { pending: true, reason: 'agent_unavailable', revision: pending.revision }
      const agent = resolved?.agent ?? resolved
      if (!agent) return { pending: true, reason: 'agent_unavailable', revision: pending.revision }

      if (this.#isBusy(agent)) {
        const idle = Promise.resolve().then(() => this.#whenIdle(agent))
        await Promise.race([idle, this.#disposeWait])
        if (this.#disposed || state.cancelled) return { pending: true, cancelled: true }
        // Resolve again after idle; a session can acquire a different Agent.
        continue
      }

      const meta = Object.freeze({
        taskId,
        sessionId: task.sessionId,
        revision: pending.revision,
        count: pending.count,
        merged: pending.count > 1,
      })
      const deliveryResult = await this.#deliver(agent, pending.report, meta)
      if (this.#disposed || state.cancelled) return { pending: true, cancelled: true }

      const flushed = await this.#sessions?.flush?.(agent.session)
      if (flushed === false || typeof this.#sessions?.flush !== 'function') {
        return { pending: true, reason: 'flush_not_confirmed', revision: pending.revision }
      }

      const ack = await this.#service.ackDelivery(taskId, pending.revision, {
        deliveredAt: this.#clock(),
        messageId: deliveryResult?.messageId ?? deliveryResult?.id ?? null,
      }, task.sessionId)
      if (ack?.acknowledged) {
        const latest = await this.#service.getTask(taskId)
        if (!latest?.pendingDelivery) return { pending: false, revision: pending.revision }
      }
      // Revision changed during followup/flush. Re-read and attempt the newer
      // durable summary; a stale ACK must never clear it.
    }
    return { pending: true, reason: 'revision_churn' }
  }
}
