import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { reconcileCodexStatusEvent } from '../../../shared/agent-hook-listener/providers/codex/codex-session-start'
import {
  isCodexCompatibleAgentType,
  markCodexLeadTurnInterrupted,
  reconcileRemoteCodexState,
  type CodexRemoteRosterAuthority
} from '../../../shared/agent-hook-listener/providers/codex/codex-state'
import type {
  AgentType,
  ParsedAgentStatusPayload
} from '../../../shared/agent-status/contracts/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** Codex keeps upstream's session-start reconciliation; Trae-compatible rows use the generalized path. */
export function reconcileCodexStatusForAgentType(
  state: HookListenerState,
  next: AgentHookEventPayload,
  previous: EnrichedAgentHookEventPayload | undefined,
  remoteRosterAuthority?: CodexRemoteRosterAuthority
): AgentHookEventPayload | null {
  return next.payload.agentType === 'codex'
    ? reconcileCodexStatusEvent(state, next, previous, remoteRosterAuthority)
    : reconcileCodexCompatibleStatus(state, next, previous, remoteRosterAuthority)
}

/** Reconcile remote children without letting one child erase its root session or model. */
export function reconcileCodexCompatibleStatus(
  state: HookListenerState,
  next: AgentHookEventPayload,
  previous: EnrichedAgentHookEventPayload | undefined,
  remoteRosterAuthority?: CodexRemoteRosterAuthority
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
            agentType,
            remoteRosterAuthority
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

/** Record cancellation only for Codex-compatible leads; other agent types own their own interrupt state. */
export function markCodexCompatibleLeadInterrupted(
  state: HookListenerState,
  paneKey: string,
  agentType: AgentType | undefined
): void {
  if (isCodexCompatibleAgentType(agentType)) {
    markCodexLeadTurnInterrupted(state, paneKey, agentType)
  }
}

/** Codex-compatible aggregates keep live children; the lead is marked only when cancellation proceeds. */
export function blocksCodexCompatibleCancel(
  state: HookListenerState,
  paneKey: string,
  payload: ParsedAgentStatusPayload,
  agentType: AgentType | undefined
): boolean {
  const childWorkEvidenced =
    payload.subagents?.some((subagent) => subagent.state !== 'idle') === true ||
    (agentType === 'claude' &&
      (state.claudeRunningNonAgentTasksByPaneKey.has(paneKey) ||
        state.claudeActiveSessionCronPaneKeys.has(paneKey)))
  if (
    payload.mainAgent
      ? payload.mainAgent.state !== 'working' ||
        (isCodexCompatibleAgentType(agentType) && childWorkEvidenced)
      : childWorkEvidenced
  ) {
    return true
  }
  if (isCodexCompatibleAgentType(agentType)) {
    markCodexLeadTurnInterrupted(state, paneKey, agentType)
  }
  return false
}
