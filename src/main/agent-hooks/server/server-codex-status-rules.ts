import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import {
  isCodexCompatibleAgentType,
  reconcileRemoteCodexState
} from '../../../shared/agent-hook-listener/providers/codex-state'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** Reconcile remote children without letting one child erase its root session or model. */
export function reconcileCodexCompatibleStatus(
  state: HookListenerState,
  next: AgentHookEventPayload,
  previous: EnrichedAgentHookEventPayload | undefined
): AgentHookEventPayload {
  const agentType = isCodexCompatibleAgentType(next.payload.agentType)
    ? next.payload.agentType
    : undefined
  const reconciled =
    (next.connectionId || !next.hookEventName) &&
    agentType &&
    (next.hookEventName || next.payload.mainAgent)
      ? {
          ...next,
          payload: reconcileRemoteCodexState(
            state,
            next.paneKey,
            next.hookEventName,
            next.toolAgentId,
            next.payload,
            previous?.payload,
            agentType
          )
        }
      : next
  const previousRoot =
    agentType && reconciled.toolAgentId && previous?.payload.agentType === agentType
      ? previous
      : undefined
  const providerSession = !reconciled.providerSession ? previousRoot?.providerSession : undefined
  const model = !reconciled.payload.model ? previousRoot?.payload.model : undefined
  if (!providerSession && !model) {
    return reconciled
  }
  return {
    ...reconciled,
    ...(providerSession ? { providerSession } : {}),
    payload: model ? { ...reconciled.payload, model } : reconciled.payload
  }
}
