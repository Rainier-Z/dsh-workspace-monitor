import { resolve } from 'node:path'

/**
 * 解析 /monitor 命令的 rawInput。
 * 语法： /monitor start [目录] | stop [taskId] | status | list
 * 返回：
 *   { kind: 'start', target: string|undefined }   // target 为 undefined 表示走默认工作区
 *   { kind: 'stop', taskId: string }
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
      if (rest.length !== 1 || target.length === 0) {
        return { kind: 'error', text: 'Usage: /monitor start [目录] | stop <taskId> | status' }
      }
      return { kind: 'stop', taskId: target }
    case 'status':
      return { kind: 'status' }
    case 'list':
      return { kind: 'list' }
    default:
      return {
        kind: 'error',
        text: `Unknown /monitor subcommand "${sub}". Usage: /monitor start [目录] | stop <taskId> | status`,
      }
  }
}

/** 解析要监测的工作区绝对路径。优先级：显式 target > sessionCwd > process.cwd()。 */
export function resolveTargetWorkspace(target, sessionCwd) {
  const candidate = (target && target.trim().length > 0) ? target.trim() : (sessionCwd ?? process.cwd())
  return resolve(candidate)
}
