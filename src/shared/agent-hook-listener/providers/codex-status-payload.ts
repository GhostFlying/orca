import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'
import {
  mainAgentTurnInterrupted,
  type AgentLeadStatusResolution
} from '../../agent-status/lifecycle/agent-lead-status-fold'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import type { AgentHookSource } from '../transport/agent-hook-relay'
import { codexWaitBesideQuestion, pendingCodexAsyncQuestion } from './codex/codex-async-questions'
import {
  codexMainAgentStatusForPayload,
  codexCompatibleStateKey,
  resolveCodexPaneStatus,
  type CodexCompatibleAgentType
} from './codex/codex-state'
import { codexRosterToSnapshots } from './codex/codex-subagent-roster'

export function buildCodexStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: AgentLeadStatusResolution & {
    updateLead: boolean
    sessionBoundary?: true
    reviewerOwnsApproval?: boolean
  },
  agentType: CodexCompatibleAgentType = 'codex'
): ParsedAgentStatusPayload | null {
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  // TraeX shares Trae's hook protocol, so its tool fields and turn boundaries read as trae.
  const hookSource: AgentHookSource = agentType === 'traex' ? 'trae' : agentType
  const reviewed = options.reviewerOwnsApproval === true
  const snapshot = options.updateLead
    ? (codexWaitBesideQuestion(state, stateKey, eventName, hookPayload, reviewed) ??
      resolveToolState(state, stateKey, extractToolFields(hookSource, eventName, hookPayload), {
        resetOnNewTurn: isNewTurnEvent(hookSource, eventName)
      }))
    : (state.lastToolByPaneKey.get(stateKey) ?? {})
  const lead = state.codexLeadStateByPaneKey.get(stateKey)
  // A human's approval or blocking question on screen wins; otherwise a waiting row shows the open async question.
  const asyncQuestion =
    options.stateName === 'waiting' && !snapshot.interactivePrompt
      ? pendingCodexAsyncQuestion(state, stateKey)
      : undefined

  return normalizeAgentStatusPayload({
    state: options.stateName,
    workingMode: options.workingMode,
    sessionBoundary: options.sessionBoundary,
    prompt: resolvePrompt(state, stateKey, promptText, {
      resetOnNewTurn: options.updateLead && isNewTurnEvent(hookSource, eventName)
    }),
    agentType,
    model: lead?.model,
    toolName: asyncQuestion?.toolName ?? snapshot.toolName,
    // The snapshot's input belongs to whatever tool runs now, not the question.
    toolInput: asyncQuestion ? asyncQuestion.title : snapshot.toolInput,
    interactivePrompt: asyncQuestion?.prompt ?? snapshot.interactivePrompt,
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
