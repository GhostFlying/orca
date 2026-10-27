import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { codexCompatibleStateKey, isCodexCompatibleAgentType } from './codex-state'

/** Child hooks inherit the root owner, never the child's provider session. */
export function retainCodexRootObservation(
  state: HookListenerState,
  next: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload {
  const agent = next.payload.agentType
  if (
    !isCodexCompatibleAgentType(agent) ||
    previous?.payload.agentType !== agent ||
    next.launchToken !== previous.launchToken ||
    next.connectionId !== previous.connectionId
  ) {
    return next
  }
  const providerSession =
    next.providerSession ?? (next.toolAgentId ? previous.providerSession : undefined)
  const prior = previous.rootTurn
  const retain =
    !next.rootTurn &&
    prior &&
    providerSession?.id === prior.sessionId &&
    state.codexLeadStateByPaneKey.get(codexCompatibleStateKey(next.paneKey, agent))?.turnId ===
      prior.turnId
  const rootTurn =
    retain &&
    next.toolAgentId &&
    next.hookEventName &&
    next.isReplay !== true &&
    next.payload.state !== 'done' &&
    prior.operations === 'settled'
      ? { ...prior, operations: 'unknown' as const, retryable: false }
      : prior
  return {
    ...next,
    ...(providerSession ? { providerSession } : {}),
    ...(retain ? { rootTurn } : {})
  }
}
