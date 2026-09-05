import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import {
  mainAgentTurnInterrupted,
  type AgentLeadStatusResolution
} from '../../agent-lead-status-fold'
import { codexRosterToSnapshots } from '../../codex-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import {
  codexMainAgentStatusForPayload,
  codexCompatibleStateKey,
  resolveCodexPaneStatus,
  type CodexCompatibleAgentType
} from './codex-state'

export function buildCodexStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: AgentLeadStatusResolution & { updateLead: boolean },
  agentType: CodexCompatibleAgentType = 'codex'
): ParsedAgentStatusPayload | null {
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  const snapshot = options.updateLead
    ? resolveToolState(state, stateKey, extractToolFields(agentType, eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent(agentType, eventName)
      })
    : (state.lastToolByPaneKey.get(stateKey) ?? {})
  const lead = state.codexLeadStateByPaneKey.get(stateKey)

  return normalizeAgentStatusPayload({
    state: options.stateName,
    workingMode: options.workingMode,
    prompt: resolvePrompt(state, stateKey, promptText, {
      resetOnNewTurn: options.updateLead && isNewTurnEvent(agentType, eventName)
    }),
    agentType,
    model: lead?.model,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted: mainAgentTurnInterrupted(lead),
    subagents: codexRosterToSnapshots(state.codexSubagentRosterByPaneKey.get(stateKey)),
    mainAgent: codexMainAgentStatusForPayload(lead)
  })
}

export function buildCodexChildDrivenStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  agentType: CodexCompatibleAgentType = 'codex'
): ParsedAgentStatusPayload | null {
  // Why: a child event before any root event means the root is mid-turn; nothing else spawns.
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  const lead = state.codexLeadStateByPaneKey.get(stateKey) ?? { state: 'working' as const }
  return buildCodexStatusPayload(
    state,
    eventName,
    '',
    paneKey,
    hookPayload,
    { ...resolveCodexPaneStatus(state, paneKey, lead, agentType), updateLead: false },
    agentType
  )
}
