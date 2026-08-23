import assert from 'node:assert/strict'
import { mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diffSnapshots, formatScanReport, scanWorkspace } from '../lib/scanner.js'

async function fixture(t) {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'dsh-monitor-')))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

test('detects added, modified, and deleted files', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'modified.txt'), 'before')
  await writeFile(join(root, 'deleted.txt'), 'gone')
  const before = await scanWorkspace(root)

  await writeFile(join(root, 'modified.txt'), 'after and larger')
  await utimes(join(root, 'modified.txt'), new Date(), new Date(Date.now() + 2_000))
  await rm(join(root, 'deleted.txt'))
  await writeFile(join(root, 'added.txt'), 'new')
  const after = await scanWorkspace(root)
  const diff = diffSnapshots(before.snapshot, after.snapshot)

  assert.deepEqual(diff.added.map(change => change.path), ['added.txt'])
  assert.deepEqual(diff.modified.map(change => change.path), ['modified.txt'])
  assert.deepEqual(diff.deleted.map(change => change.path), ['deleted.txt'])
  assert.equal(diff.total, 3)
})

test('recurses while respecting name and path ignore rules', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'src', 'generated'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'src', 'keep.js'), 'keep')
  await writeFile(join(root, 'src', 'generated', 'skip.js'), 'skip')
  await writeFile(join(root, 'node_modules', 'pkg', 'skip.js'), 'skip')

  const scan = await scanWorkspace(root, { ignore: ['node_modules', 'src/generated'] })
  assert.deepEqual([...scan.snapshot.keys()], ['src/keep.js'])
})

test('does not follow symbolic links outside the workspace', async (t) => {
  const root = await fixture(t)
  const outside = await fixture(t)
  await writeFile(join(outside, 'secret.txt'), 'outside')
  try {
    await symlink(outside, join(root, 'linked'), 'junction')
  } catch (error) {
    if (error && typeof error === 'object' && ['EPERM', 'EACCES'].includes(error.code)) t.skip('symbolic links unavailable')
    throw error
  }

  const scan = await scanWorkspace(root)
  assert.deepEqual([...scan.snapshot.keys()], ['linked'])
  assert.equal(scan.snapshot.get('linked').kind, 'symlink')
})

test('formats an explicit unchanged report and truncates long change lists', () => {
  const unchanged = formatScanReport({
    root: 'C:/workspace',
    scannedAt: 0,
    diff: { added: [], modified: [], deleted: [], total: 0 },
    warnings: [],
  })
  assert.match(unchanged, /本轮未发现文件变化/)

  const entry = Object.freeze({ kind: 'file', size: 1, mtimeMs: 0 })
  const changed = formatScanReport({
    root: 'C:/workspace',
    scannedAt: 0,
    diff: {
      added: [{ path: 'a', current: entry }, { path: 'b', current: entry }],
      modified: [],
      deleted: [],
      total: 2,
    },
    warnings: [],
  }, { maxChanges: 1 })
  assert.match(changed, /其余 1 项变化已省略/)
})

test('fails loudly when the scan exceeds its entry budget', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'a.txt'), 'a')
  await writeFile(join(root, 'b.txt'), 'b')
  await assert.rejects(scanWorkspace(root, { maxEntries: 1 }), /exceeded maxEntries/)
})
