import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import { codexCompatibleStateKey, type CodexCompatibleAgentType } from './codex-state'

// Enough for any run of /side chats in one pane; the oldest ended long ago.
const MAX_FORKS_PER_PANE = 16

/**
 * Whether a root Codex hook comes from an ephemeral thread that is not the pane's own, such as a
 * /side fork. That thread shares the pane and process but must not move the pane's status.
 * The fork's own SessionStart names it; when that start was missed, the stored row, which outlives
 * an Orca restart, names the pane's thread. Neither depends on the parsed rollout.
 */
export function isForeignEphemeralCodexThread(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  agentType: CodexCompatibleAgentType = 'codex'
): boolean {
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId || readString(hookPayload, 'agent_id') || hookPayload.transcript_path !== null) {
    return false
  }
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  const forks = state.codexEphemeralForkSessionsByPaneKey.get(stateKey) ?? []
  if (forks.includes(sessionId)) {
    return true
  }
  const source = eventName === 'SessionStart' ? readString(hookPayload, 'source') : undefined
  if (source === 'fork') {
    state.codexEphemeralForkSessionsByPaneKey.set(
      stateKey,
      [...forks, sessionId].slice(-MAX_FORKS_PER_PANE)
    )
    return true
  }
  if (source === 'startup' || source === 'clear') {
    return false
  }
  return rowHoldsOtherCodexThread(state.lastStatusByPaneKey.get(stateKey), sessionId, agentType)
}

/** Whether the pane's stored Codex row is a different thread, one with a rollout. */
export function rowHoldsOtherCodexThread(
  row: Pick<AgentHookEventPayload, 'payload' | 'providerSession'> | undefined,
  sessionId: string,
  agentType: CodexCompatibleAgentType = 'codex'
): boolean {
  const thread = row?.payload.agentType === agentType ? row.providerSession : undefined
  return Boolean(thread?.transcriptPath && thread.id !== sessionId)
}
