import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import type { ClearedStatusTiming, EnrichedAgentHookEventPayload } from './server-types'
import { CLEARED_STATUS_TIMINGS_MAX } from './server-constants'

export function recordClearedStatusTiming(
  timings: Map<string, ClearedStatusTiming>,
  paneKey: string,
  entry: EnrichedAgentHookEventPayload,
  connectionId: string
): void {
  timings.delete(paneKey)
  timings.set(paneKey, {
    connectionId,
    source: entry.source,
    launchToken: entry.launchToken,
    state: entry.payload.state,
    agentType: entry.payload.agentType,
    prompt: entry.payload.prompt,
    promptInteractionKey: entry.promptInteractionKey,
    providerPromptId: entry.providerPromptId,
    providerSession: entry.providerSession,
    toolUseId: entry.toolUseId,
    interrupted: entry.payload.interrupted,
    sessionBoundary: entry.payload.sessionBoundary,
    turnCompletedAt: entry.payload.turnCompletedAt,
    stateStartedAt: entry.stateStartedAt,
    turnStartedAt: entry.turnStartedAt
  })
  while (timings.size > CLEARED_STATUS_TIMINGS_MAX) {
    const oldest = timings.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    timings.delete(oldest)
  }
}

export function replayReclaimsClearedStatusTiming(
  cleared: ClearedStatusTiming | undefined,
  payload: AgentHookEventPayload
): cleared is ClearedStatusTiming {
  return (
    cleared !== undefined &&
    payload.isReplay === true &&
    cleared.connectionId === payload.connectionId &&
    cleared.source === payload.source &&
    cleared.launchToken === payload.launchToken &&
    cleared.state === payload.payload.state &&
    cleared.agentType === payload.payload.agentType &&
    cleared.prompt === payload.payload.prompt &&
    cleared.promptInteractionKey === payload.promptInteractionKey &&
    cleared.providerPromptId === payload.providerPromptId &&
    agentProviderSessionsEqual(
      payload.payload.agentType,
      cleared.providerSession,
      payload.providerSession
    ) &&
    cleared.toolUseId === payload.toolUseId &&
    cleared.interrupted === payload.payload.interrupted &&
    cleared.sessionBoundary === payload.payload.sessionBoundary &&
    cleared.turnCompletedAt === payload.payload.turnCompletedAt
  )
}
