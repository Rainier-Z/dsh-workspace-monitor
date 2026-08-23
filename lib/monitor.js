import { diffSnapshots, scanWorkspace } from './scanner.js'

export class PollingMonitor {
  #activeScan
  #baseline
  #running = false
  #stopped = false
  #timer

  constructor(options) {
    this.root = options.root
    this.intervalMs = options.intervalMs
    this.ignore = options.ignore ?? []
    this.maxEntries = options.maxEntries ?? 100_000
    this.onScan = options.onScan
    this.onError = options.onError
  }

  async start() {
    if (this.#running) return
    this.#running = true
    this.#stopped = false
    await this.#run(false)
    this.#schedule()
  }

  async stop() {
    if (this.#stopped) return
    this.#stopped = true
    this.#running = false
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    await this.#activeScan
  }

  #schedule() {
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#run(true).finally(() => { this.#schedule() })
    }, this.intervalMs)
    this.#timer.unref?.()
  }

  async #run(notify) {
    const scannedAt = Date.now()
    const operation = scanWorkspace(this.root, {
      ignore: this.ignore,
      maxEntries: this.maxEntries,
    })
    this.#activeScan = operation

    try {
      const scan = await operation
      if (this.#stopped) return
      if (this.#baseline === undefined) {
        this.#baseline = scan.snapshot
        return
      }

      const diff = diffSnapshots(this.#baseline, scan.snapshot)
      this.#baseline = scan.snapshot
      if (notify) {
        await this.onScan(Object.freeze({
          root: scan.root,
          scannedAt,
          diff,
          warnings: scan.warnings,
          visitedEntries: scan.visitedEntries,
        }))
      }
    } catch (error) {
      if (!this.#stopped) await this.onError(error, scannedAt)
    } finally {
      if (this.#activeScan === operation) this.#activeScan = undefined
    }
  }
}
