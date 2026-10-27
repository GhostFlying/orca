import { codexTranscriptTurnEnd } from './codex-subagent-transcript'
import { codexCompatibleStateKey, type CodexCompatibleAgentType } from './codex-state'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'

/** Replay rollout-confirmed root ends as missing Stops, including /review; drop delayed hooks once the lead moved to another turn. */
export function codexHookEventForEndedTurn(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  agentType: CodexCompatibleAgentType = 'codex'
): unknown {
  const turnId = readString(hookPayload, 'turn_id')
  if (
    !turnId ||
    eventName === 'Stop' ||
    eventName === 'Interrupt' ||
    readString(hookPayload, 'agent_id')
  ) {
    return eventName
  }
  const key = codexCompatibleStateKey(paneKey, agentType)
  const lead = state.codexLeadStateByPaneKey.get(key)
  if (
    !(lead?.state === 'done' && lead.turnId === turnId && eventName !== 'UserPromptSubmit') &&
    !codexTranscriptTurnEnd(state.codexSubagentTranscriptByPaneKey.get(key), turnId)
  ) {
    return eventName
  }
  const leadTurnId = state.codexLeadStateByPaneKey.get(key)?.turnId
  return leadTurnId && leadTurnId !== turnId ? undefined : 'Stop'
}
