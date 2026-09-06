import { lstat, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

function portablePath(path) {
  return path.replaceAll('\\', '/')
}

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

function isUnreadableError(error) {
  return errorCode(error) !== 'ENOENT'
}

function unreadablePrefixesOf(snapshot) {
  return Array.isArray(snapshot?.unreadablePrefixes) ? snapshot.unreadablePrefixes : []
}

function isUnreadablePath(path, prefixes) {
  return prefixes.some((prefix) => prefix === '' || path === prefix || path.startsWith(`${prefix}/`))
}

function normalizeIgnoreRule(rule) {
  return portablePath(rule.trim()).replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

function isIgnored(relativePath, rules) {
  const path = portablePath(relativePath)
  const segments = path.split('/')
  return rules.some((rule) => {
    if (rule.length === 0) return false
    if (!rule.includes('/')) return segments.includes(rule)
    return path === rule || path.startsWith(`${rule}/`)
  })
}

function entryKind(info) {
  if (info.isSymbolicLink()) return 'symlink'
  if (info.isFile()) return 'file'
  return undefined
}

function snapshotEntry(info) {
  return Object.freeze({
    kind: entryKind(info),
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs),
  })
}

export async function scanWorkspace(root, options = {}) {
  const absoluteRoot = resolve(root)
  const fileSystem = options.fs ?? { stat, readdir, lstat }
  const rootInfo = await fileSystem.stat(absoluteRoot)
  if (!rootInfo.isDirectory()) throw new Error(`workspace is not a directory: ${absoluteRoot}`)

  const rules = (options.ignore ?? []).map(normalizeIgnoreRule).filter(Boolean)
  const maxEntries = options.maxEntries ?? 100_000
  const snapshot = new Map()
  const warnings = []
  const unreadablePrefixes = []
  const pending = [{ absolute: absoluteRoot, relative: '' }]
  let visitedEntries = 0

  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = await fileSystem.readdir(directory.absolute, { withFileTypes: true })
    } catch (error) {
      warnings.push(`${portablePath(directory.relative || '.')}: ${error instanceof Error ? error.message : String(error)}`)
      if (isUnreadableError(error)) unreadablePrefixes.push(directory.relative)
      continue
    }

    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relative = portablePath(directory.relative ? `${directory.relative}/${entry.name}` : entry.name)
      if (isIgnored(relative, rules)) continue
      visitedEntries += 1
      if (visitedEntries > maxEntries) {
        throw new Error(`workspace scan exceeded maxEntries (${maxEntries})`)
      }

      const absolute = resolve(directory.absolute, entry.name)
      let info
      try {
        info = await fileSystem.lstat(absolute)
      } catch (error) {
        if (isUnreadableError(error)) {
          unreadablePrefixes.push(relative)
          warnings.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }

      if (info.isDirectory()) {
        pending.push({ absolute, relative })
        continue
      }

      const kind = entryKind(info)
      if (kind !== undefined) snapshot.set(relative, snapshotEntry(info))
    }
  }

  const frozenUnreadablePrefixes = Object.freeze([...new Set(unreadablePrefixes)].sort((left, right) => left.localeCompare(right)))
  Object.defineProperty(snapshot, 'unreadablePrefixes', {
    value: frozenUnreadablePrefixes,
    enumerable: false,
  })

  return Object.freeze({
    root: absoluteRoot,
    snapshot,
    unreadablePrefixes: frozenUnreadablePrefixes,
    warnings: Object.freeze(warnings),
    visitedEntries,
  })
}

function changed(before, after) {
  return before.kind !== after.kind || before.size !== after.size || before.mtimeMs !== after.mtimeMs
}

export function diffSnapshots(before, after) {
  const added = []
  const modified = []
  const deleted = []

  for (const [path, current] of after) {
    const previous = before.get(path)
    if (previous === undefined) {
      added.push(Object.freeze({ path, current }))
    } else if (changed(previous, current)) {
      modified.push(Object.freeze({ path, previous, current }))
    }
  }

  for (const [path, previous] of before) {
    if (!after.has(path) && !isUnreadablePath(path, unreadablePrefixesOf(after))) {
      deleted.push(Object.freeze({ path, previous }))
    }
  }

  added.sort((left, right) => left.path.localeCompare(right.path))
  modified.sort((left, right) => left.path.localeCompare(right.path))
  deleted.sort((left, right) => left.path.localeCompare(right.path))

  return Object.freeze({
    added: Object.freeze(added),
    modified: Object.freeze(modified),
    deleted: Object.freeze(deleted),
    total: added.length + modified.length + deleted.length,
  })
}

export function mergeSnapshots(before, after) {
  const merged = new Map(after)
  const prefixes = unreadablePrefixesOf(after)
  for (const [path, metadata] of before) {
    if (!merged.has(path) && isUnreadablePath(path, prefixes)) merged.set(path, metadata)
  }
  return merged
}

function isoTime(ms) {
  return new Date(ms).toISOString()
}

function describeAdded(change) {
  return `新增 ${change.path}（${change.current.size} B，修改时间 ${isoTime(change.current.mtimeMs)}）`
}

function describeModified(change) {
  return `修改 ${change.path}（大小 ${change.previous.size} → ${change.current.size} B；修改时间 ${isoTime(change.previous.mtimeMs)} → ${isoTime(change.current.mtimeMs)}）`
}

function describeDeleted(change) {
  return `删除 ${change.path}（原大小 ${change.previous.size} B，原修改时间 ${isoTime(change.previous.mtimeMs)}）`
}

export function formatScanReport(result, options = {}) {
  const maxChanges = options.maxChanges ?? 200
  const lines = [
    `扫描时间：${new Date(result.scannedAt).toISOString()}`,
    `工作区：${result.root}`,
    `变化数量：${result.diff.total}（新增 ${result.diff.added.length}，修改 ${result.diff.modified.length}，删除 ${result.diff.deleted.length}）`,
  ]

  const details = [
    ...result.diff.added.map(describeAdded),
    ...result.diff.modified.map(describeModified),
    ...result.diff.deleted.map(describeDeleted),
  ]

  if (details.length === 0) {
    lines.push('本轮未发现文件变化。')
  } else {
    for (const detail of details.slice(0, maxChanges)) lines.push(`- ${detail}`)
    if (details.length > maxChanges) lines.push(`- 其余 ${details.length - maxChanges} 项变化已省略。`)
  }

  if (result.warnings.length > 0) {
    lines.push(`扫描警告：${result.warnings.length}`)
    for (const warning of result.warnings.slice(0, 20)) lines.push(`- ${warning}`)
    if (result.warnings.length > 20) lines.push(`- 其余 ${result.warnings.length - 20} 条警告已省略。`)
  }

  return lines.join('\n')
}
