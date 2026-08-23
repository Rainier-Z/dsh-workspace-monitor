import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PollingMonitor } from '../lib/monitor.js'

test('establishes a silent baseline, then reports on the configured cadence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-monitor-loop-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  await writeFile(join(root, 'file.txt'), 'before')

  let resolveReport
  const report = new Promise(resolve => { resolveReport = resolve })
  const errors = []
  const monitor = new PollingMonitor({
    root,
    intervalMs: 20,
    onScan(result) { resolveReport(result) },
    onError(error) { errors.push(error) },
  })
  t.after(async () => { await monitor.stop() })

  await monitor.start()
  await writeFile(join(root, 'file.txt'), 'after and larger')
  const result = await Promise.race([
    report,
    new Promise((_, reject) => setTimeout(() => reject(new Error('monitor timeout')), 2_000)),
  ])

  assert.equal(result.diff.total, 1)
  assert.deepEqual(result.diff.modified.map(change => change.path), ['file.txt'])
  assert.deepEqual(errors, [])
})

test('stopping cancels future scans', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-monitor-stop-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  let scans = 0
  const monitor = new PollingMonitor({
    root,
    intervalMs: 20,
    onScan() { scans += 1 },
    onError(error) { throw error },
  })
  await monitor.start()
  await monitor.stop()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(scans, 0)
})
