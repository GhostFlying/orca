import type { RootTurnObservation } from '../../shared/root-turn-observation'

type RootHistoryRpc = {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

type RootHistoryIdentity = {
  sessionId: string
  turnId: string
  observedAt: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function milliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined
}

const transientErrors = new Map([
  ['httpConnectionFailed', 'http_connection_failed'],
  ['http_connection_failed', 'http_connection_failed'],
  ['responseStreamConnectionFailed', 'response_stream_connection_failed'],
  ['response_stream_connection_failed', 'response_stream_connection_failed'],
  ['responseStreamDisconnected', 'response_stream_disconnected'],
  ['response_stream_disconnected', 'response_stream_disconnected'],
  ['rateLimitExceeded', 'rate_limit_exceeded'],
  ['rate_limit_exceeded', 'rate_limit_exceeded']
])

function errorFact(value: unknown): { errorCode: string; retryable: boolean } {
  const error = record(value)
  const info = error?.codexErrorInfo
  if (typeof info === 'string') {
    const normalized = transientErrors.get(info)
    const permanent = new Map([
      ['unauthorized', 'unauthorized'],
      ['permissionDenied', 'permission_denied'],
      ['usageLimitExceeded', 'insufficient_quota']
    ])
    return {
      errorCode: normalized ?? permanent.get(info) ?? 'other',
      retryable: normalized === 'rate_limit_exceeded'
    }
  }
  for (const [key, detail] of Object.entries(record(info) ?? {})) {
    const normalized = transientErrors.get(key)
    const fields = record(detail)
    const status = fields?.httpStatusCode ?? fields?.http_status_code
    if (normalized) {
      return {
        errorCode: normalized,
        retryable: status == null || (typeof status === 'number' && status >= 500 && status <= 599)
      }
    }
  }
  return { errorCode: 'other', retryable: false }
}

const informationalItems = new Set([
  'functionCallOutput',
  'userMessage',
  'taskNotification',
  'hookPrompt',
  'agentMessage',
  'sessionPeerMessage',
  'plan',
  'reasoning',
  'webSearch',
  'imageView',
  'enteredReviewMode',
  'exitedReviewMode',
  'worktreeSessionEntered',
  'worktreeSessionExited',
  'contextCompaction',
  'sleep'
])

const operationItems = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'imageGeneration'
])

async function operationSettlement(
  rpc: RootHistoryRpc,
  identity: RootHistoryIdentity
): Promise<RootTurnObservation['operations']> {
  let cursor: string | null = null
  let settlement: RootTurnObservation['operations'] = 'settled'
  const cursors = new Set<string>()
  const terminalProcesses = new Set<string>()
  const settledProcesses = new Set<string>()
  for (let pages = 0; pages < 100; pages++) {
    const page = record(
      await rpc.request('thread/items/list', {
        threadId: identity.sessionId,
        turnId: identity.turnId,
        cursor,
        limit: 100,
        sortDirection: 'asc'
      })
    )
    if (!Array.isArray(page?.data)) {
      return 'unknown'
    }
    for (const value of page.data) {
      const entry = record(value)
      if (entry?.turnId !== identity.turnId) {
        return 'unknown'
      }
      const item = record(entry.item)
      if (!item || typeof item.type !== 'string') {
        return 'unknown'
      }
      if (item.type === 'terminalInteraction') {
        if (typeof item.processId !== 'string' || !item.processId) {
          settlement = 'unknown'
        } else {
          terminalProcesses.add(item.processId)
        }
        continue
      }
      if (
        item.type === 'commandExecution' &&
        typeof item.processId === 'string' &&
        ['completed', 'failed', 'declined', 'cancelled'].includes(String(item.status))
      ) {
        settledProcesses.add(item.processId)
      }
      if (informationalItems.has(item.type)) {
        continue
      }
      if (!operationItems.has(item.type)) {
        settlement = 'unknown'
        continue
      }
      if (item.status === 'inProgress' || item.status === 'in_progress') {
        return 'pending'
      }
      if (!['completed', 'failed', 'declined', 'cancelled'].includes(String(item.status))) {
        settlement = 'unknown'
      }
    }
    if (page.nextCursor === null) {
      if ([...terminalProcesses].some((id) => !settledProcesses.has(id))) {
        return 'unknown'
      }
      return settlement
    }
    if (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor)) {
      return 'unknown'
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  return 'unknown'
}

export async function readTraexRootHistory(
  rpc: RootHistoryRpc,
  identity: RootHistoryIdentity
): Promise<RootTurnObservation> {
  const unknown: RootTurnObservation = {
    version: 1,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    observedAt: identity.observedAt,
    startedAt: 0,
    source: 'native-api',
    state: 'unknown',
    operations: 'unknown',
    retryable: false
  }
  const metadata = record(
    await rpc.request('thread/read', {
      threadId: identity.sessionId,
      includeTurns: false
    })
  )
  if (record(metadata?.thread)?.id !== identity.sessionId) {
    return unknown
  }
  const page = record(
    await rpc.request('thread/turns/list', {
      threadId: identity.sessionId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded'
    })
  )
  const turn = Array.isArray(page?.data) ? record(page.data[0]) : undefined
  if (!turn || !identity.turnId || turn.id !== identity.turnId) {
    return unknown
  }
  const startedAt = milliseconds(turn.startedAt)
  if (!startedAt) {
    return unknown
  }
  const state: RootTurnObservation['state'] =
    turn.status === 'inProgress'
      ? 'running'
      : turn.status === 'completed'
        ? 'completed'
        : turn.status === 'failed'
          ? 'failed'
          : turn.status === 'interrupted'
            ? 'cancelled'
            : 'unknown'
  const result: RootTurnObservation = { ...unknown, startedAt, state }
  const completedAt = milliseconds(turn.completedAt)
  if (completedAt !== undefined) {
    result.completedAt = completedAt
  }
  if (state === 'failed') {
    Object.assign(result, errorFact(turn.error))
  }
  if (state !== 'running' && state !== 'unknown') {
    try {
      result.operations = await operationSettlement(rpc, identity)
    } catch {
      result.operations = 'unknown'
    }
  }
  return result
}
