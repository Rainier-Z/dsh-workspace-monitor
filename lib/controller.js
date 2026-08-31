import { resolve } from 'node:path'

/**
 * 解析 /monitor 命令的 rawInput。
 * 语法： /monitor start [目录] | stop | status
 * 返回：
 *   { kind: 'start', target: string|undefined }   // target 为 undefined 表示走默认工作区
 *   { kind: 'stop' }
 *   { kind: 'status' }
 *   { kind: 'error', text: string }
 */
export function parseMonitorCommand(rawInput) {
  const input = String(rawInput ?? '').trim()
  if (input.length === 0) return { kind: 'status' }
  const [sub, ...rest] = input.split(/\s+/)
  const target = rest.join(' ').trim()
  switch (sub.toLowerCase()) {
    case 'start':
      return { kind: 'start', target: target.length > 0 ? target : undefined }
    case 'stop':
      return { kind: 'stop' }
    case 'status':
      return { kind: 'status' }
    default:
      return {
        kind: 'error',
        text: `Unknown /monitor subcommand "${sub}". Usage: /monitor start [目录] | stop | status`,
      }
  }
}

/** 解析要监测的工作区绝对路径。优先级：显式 target > sessionCwd > process.cwd()。 */
export function resolveTargetWorkspace(target, sessionCwd) {
  const candidate = (target && target.trim().length > 0) ? target.trim() : (sessionCwd ?? process.cwd())
  return resolve(candidate)
}
