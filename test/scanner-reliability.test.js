import assert from 'node:assert/strict'
import test from 'node:test'
import { diffSnapshots, scanWorkspace } from '../lib/scanner.js'

function directoryEntry(name) {
  return {
    name,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isFile: () => false,
  }
}

function fileEntry(name) {
  return {
    name,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFile: () => true,
  }
}

function directoryInfo() {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isFile: () => false,
    size: 0,
    mtimeMs: 0,
  }
}

function fileInfo(size = 1) {
  return {
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFile: () => true,
    size,
    mtimeMs: 0,
  }
}

function pathKey(path) {
  return path.replaceAll('\\', '/')
}

test('preserves old entries below an unreadable directory', async () => {
  let firstPass = true
  const fs = {
    stat: async () => directoryInfo(),
    readdir: async (path) => {
      const key = pathKey(path)
      if (key.endsWith('/private')) {
        if (!firstPass) {
          const error = new Error('access denied')
          error.code = 'EACCES'
          throw error
        }
        return [fileEntry('secret.txt')]
      }
      return firstPass
        ? [directoryEntry('private'), fileEntry('public.txt')]
        : [directoryEntry('private')]
    },
    lstat: async (path) => pathKey(path).endsWith('/private') ? directoryInfo() : fileInfo(),
  }

  const before = await scanWorkspace('C:/workspace', { fs })
  firstPass = false
  const after = await scanWorkspace('C:/workspace', { fs })
  const diff = diffSnapshots(before.snapshot, after.snapshot)

  assert.deepEqual(after.unreadablePrefixes, ['private'])
  assert.deepEqual(diff.deleted.map(change => change.path), ['public.txt'])
  assert.equal(diff.deleted.some(change => change.path.startsWith('private/')), false)
  assert.equal(after.snapshot.has('private/secret.txt'), false)
})

test('preserves an old file when its metadata becomes unreadable', async () => {
  let readable = true
  const fs = {
    stat: async () => directoryInfo(),
    readdir: async () => [fileEntry('protected.txt')],
    lstat: async () => {
      if (!readable) {
        const error = new Error('operation not permitted')
        error.code = 'EPERM'
        throw error
      }
      return fileInfo()
    },
  }

  const before = await scanWorkspace('C:/workspace', { fs })
  readable = false
  const after = await scanWorkspace('C:/workspace', { fs })
  const diff = diffSnapshots(before.snapshot, after.snapshot)

  assert.deepEqual(after.unreadablePrefixes, ['protected.txt'])
  assert.deepEqual(diff.deleted, [])
  assert.equal(diff.total, 0)
})

test('rejects maxEntries overflow with a stable error and no partial result', async () => {
  const fs = {
    stat: async () => directoryInfo(),
    readdir: async () => [fileEntry('a.txt'), fileEntry('b.txt')],
    lstat: async () => fileInfo(),
  }

  const attempts = await Promise.all([
    scanWorkspace('C:/workspace', { fs, maxEntries: 1 }).then(() => undefined, error => error),
    scanWorkspace('C:/workspace', { fs, maxEntries: 1 }).then(() => undefined, error => error),
  ])

  assert.equal(attempts[0] instanceof Error, true)
  assert.equal(attempts[1] instanceof Error, true)
  assert.equal(attempts[0].message, 'workspace scan exceeded maxEntries (1)')
  assert.equal(attempts[1].message, attempts[0].message)
})
