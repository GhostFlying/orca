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
