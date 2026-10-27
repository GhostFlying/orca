import type { RootTurnObservation } from '../../shared/root-turn-observation'
import {
  record,
  readTraexOperationSettlement,
  type RootHistoryIdentity,
  type RootHistoryRpc
} from './traex-root-operations'

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
  if (
    state !== 'running' &&
    state !== 'unknown' &&
    (completedAt === undefined || completedAt < startedAt)
  ) {
    return {
      ...result,
      state: 'unknown',
      operations: 'unknown',
      errorCode: 'ending_unconfirmed',
      retryable: false
    }
  }
  if (state === 'failed') {
    Object.assign(result, errorFact(turn.error))
  }
  if (state !== 'running' && state !== 'unknown') {
    try {
      result.operations = await readTraexOperationSettlement(rpc, identity)
    } catch {
      result.operations = 'unknown'
    }
    try {
      const finalPage = record(
        await rpc.request('thread/turns/list', {
          threadId: identity.sessionId,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'notLoaded'
        })
      )
      const finalTurn = Array.isArray(finalPage?.data) ? record(finalPage.data[0]) : undefined
      if (!finalTurn || finalTurn.id !== identity.turnId || finalTurn.status !== turn.status) {
        result.state = 'unknown'
        result.operations = 'unknown'
        result.retryable = false
        result.errorCode =
          finalTurn?.id !== identity.turnId ? 'ownership_changed' : 'observation_inconsistent'
      } else if (state === 'failed') {
        Object.assign(result, errorFact(finalTurn.error))
      }
    } catch {
      result.operations = 'unknown'
      result.retryable = false
    }
  }
  return result
}
