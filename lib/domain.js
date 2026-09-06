import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const MAX_INTERVAL_MS = 2_147_483_647
const safeNonNegativeInteger = () => z.number().int().safe().nonnegative()

export const snapshotEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'symlink']),
  size: safeNonNegativeInteger(),
  mtimeMs: safeNonNegativeInteger(),
}).strict()

export const baselineSchema = z.union([
  z.array(snapshotEntrySchema),
  z.null(),
])

export const taskRecordSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string(),
  workspace: z.string().min(1).refine(isAbsolute, 'workspace must be an absolute path'),
  intervalMs: safeNonNegativeInteger().min(1_000).max(MAX_INTERVAL_MS),
  status: z.enum(['ACTIVE', 'PAUSED']),
  createdAt: safeNonNegativeInteger(),
  updatedAt: safeNonNegativeInteger(),
  lastRunAt: safeNonNegativeInteger().nullable(),
  nextRunAt: safeNonNegativeInteger().nullable(),
  baseline: baselineSchema,
  pauseReason: z.string().nullable(),
}).strict()

export const monitorDomainSpec = defineDomain({
  name: 'dsh_monitor',
  version: 1,
  layout: 'per-record',
  tables: {
    tasks: domainTable(taskRecordSchema),
  },
})

export function getTasksTable(domain) {
  return domain.table('tasks')
}

export const getTaskTable = getTasksTable
export const tasksTable = getTasksTable
