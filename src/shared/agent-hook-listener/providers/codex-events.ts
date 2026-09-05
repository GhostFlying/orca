import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { normalizeOptionalField } from '../../agent-status-field-normalization'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  codexRosterEffectiveState,
  codexRosterToSnapshots,
  finishCodexSubagent,
  upsertCodexSubagent
} from '../../codex-subagent-roster'
import { reconcileCodexSubagentTranscript } from '../../codex-subagent-transcript'
import {
  codexTurnApprovalsAreAutoReviewed,
  reconcileCodexSubagentReviewer
} from '../../codex-subagent-reviewer'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import {
  clearCodexCompatibleState,
  codexCompatibleStateKey,
  type CodexCompatibleAgentType,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  hasCodexTranscriptSubagents
} from './codex-state'

export function buildCodexStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: { stateName: 'working' | 'waiting' | 'done'; updateLead: boolean },
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
    subagents: codexRosterToSnapshots(state.codexSubagentRosterByPaneKey.get(stateKey))
  })
}

export function buildCodexChildDrivenStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  agentType: CodexCompatibleAgentType = 'codex'
): ParsedAgentStatusPayload | null {
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  const leadState = state.codexLeadStateByPaneKey.get(stateKey)?.state ?? 'working'
  const stateName = codexRosterEffectiveState(
    state.codexSubagentRosterByPaneKey.get(stateKey),
    leadState
  )
  return buildCodexStatusPayload(
    state,
    eventName,
    '',
    paneKey,
    hookPayload,
    { stateName, updateLead: false },
    agentType
  )
}

export function normalizeCodexSubagentLifecycleEvent(
  state: HookListenerState,
  eventName: 'SubagentStart' | 'SubagentStop',
  paneKey: string,
  hookPayload: Record<string, unknown>,
  agentType: CodexCompatibleAgentType = 'codex'
): ParsedAgentStatusPayload | null {
  const agentId = readString(hookPayload, 'agent_id')
  if (!agentId) {
    return null
  }
  const roster = getOrCreateCodexSubagentRoster(state, paneKey, agentType)
  if (eventName === 'SubagentStart') {
    upsertCodexSubagent(
      roster,
      agentId,
      {
        agentType: readString(hookPayload, 'agent_type'),
        model: readString(hookPayload, 'model'),
        state: 'working'
      },
      Date.now()
    )
  } else {
    finishCodexSubagent(roster, agentId)
  }
  return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload, agentType)
}

/**
 * Drops a `PermissionRequest` wait that Codex's own review agent owns.
 *
 * Codex runs this hook as decider #1, ahead of both its review agent and the user, so the event
 * alone is "a decision is being made", not "a human is blocked". Under `approvals_reviewer =
 * auto_review` ("Approve for me") the review agent resolves it seconds later and the pane flapped
 * between Needs You and Working for every gated tool call (STA-7698).
 *
 * `request_user_input` is untouched: it arrives as `PreToolUse`, and no reviewer can answer a
 * question addressed to the user (#9861).
 */
function resolveCodexApprovalOwnedState(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  transcriptPath: string | undefined,
  stateName: 'working' | 'waiting' | 'done',
  agentType: CodexCompatibleAgentType
): 'working' | 'waiting' | 'done' {
  if (stateName !== 'waiting' || eventName !== 'PermissionRequest') {
    return stateName
  }
  return codexTurnApprovalsAreAutoReviewed(
    state.codexSubagentTranscriptByPaneKey.get(codexCompatibleStateKey(paneKey, agentType)),
    transcriptPath
  )
    ? 'working'
    : stateName
}

export function normalizeCodexEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  agentType: CodexCompatibleAgentType = 'codex'
): ParsedAgentStatusPayload | null {
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return normalizeCodexSubagentLifecycleEvent(state, eventName, paneKey, hookPayload, agentType)
  }

  // Why: Codex's request_user_input (0.145+) is auto-allowed, so it fires PreToolUse while blocked on a human answer; map to waiting like grok's ask_user_question.
  const isUserInputPreTool =
    eventName === 'PreToolUse' &&
    isAskUserQuestionTool(readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name'))
  const stateName =
    eventName === 'SessionStart' ||
    eventName === 'UserPromptSubmit' ||
    (eventName === 'PreToolUse' && !isUserInputPreTool) ||
    eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'PermissionRequest' || isUserInputPreTool
        ? 'waiting'
        : eventName === 'Stop'
          ? 'done'
          : null
  if (!stateName) {
    return null
  }

  const agentId = readString(hookPayload, 'agent_id')
  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  if (eventName === 'SessionStart' && !agentId) {
    // Why: a pane can host a new Codex process after the old one exited without child Stop hooks.
    clearCodexCompatibleState(state, paneKey, agentType)
  }
  if (agentId && transcriptPath && eventName === 'PermissionRequest') {
    const transcriptState = getOrCreateCodexSubagentTranscriptState(state, paneKey, agentType)
    if (transcriptState.parent.filePath === transcriptPath) {
      reconcileCodexSubagentTranscript(
        transcriptState,
        getOrCreateCodexSubagentRoster(state, paneKey, agentType),
        transcriptPath
      )
    } else {
      reconcileCodexSubagentReviewer(transcriptState, transcriptPath)
    }
  }
  if (transcriptPath && !agentId) {
    reconcileCodexSubagentTranscript(
      getOrCreateCodexSubagentTranscriptState(state, paneKey, agentType),
      getOrCreateCodexSubagentRoster(state, paneKey, agentType),
      transcriptPath
    )
  }
  if (agentId) {
    // Why: reconcile the child rollout reviewer before classifying its approval, including after relay restart.
    const childState = resolveCodexApprovalOwnedState(
      state,
      eventName,
      paneKey,
      transcriptPath,
      stateName,
      agentType
    )
    upsertCodexSubagent(
      getOrCreateCodexSubagentRoster(state, paneKey, agentType),
      agentId,
      {
        agentType: readString(hookPayload, 'agent_type'),
        model: readString(hookPayload, 'model'),
        state: childState === 'waiting' ? 'waiting' : 'working'
      },
      Date.now()
    )
    return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload, agentType)
  }

  if (eventName === 'Stop' && !hasCodexTranscriptSubagents(state, paneKey, agentType)) {
    // Why: Codex CLI 0.144 can omit child Stop hooks; later child activity safely recreates any agent still running.
    const stateKey = codexCompatibleStateKey(paneKey, agentType)
    state.codexSubagentRosterByPaneKey.delete(stateKey)
  }
  // Why: resolved after the transcript reconcile above, so this turn's reviewer is read from the
  // rollout during the very PermissionRequest being classified, not from a prior event.
  const ownedState = resolveCodexApprovalOwnedState(
    state,
    eventName,
    paneKey,
    transcriptPath,
    stateName,
    agentType
  )
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  const previousLead = state.codexLeadStateByPaneKey.get(stateKey)
  state.codexLeadStateByPaneKey.set(stateKey, {
    state: ownedState,
    model:
      normalizeOptionalField(hookPayload['model'], AGENT_MODEL_MAX_LENGTH) ??
      (eventName === 'SessionStart' ? undefined : previousLead?.model)
  })
  const effectiveState = codexRosterEffectiveState(
    state.codexSubagentRosterByPaneKey.get(stateKey),
    ownedState
  )
  return buildCodexStatusPayload(
    state,
    eventName,
    promptText,
    paneKey,
    hookPayload,
    { stateName: effectiveState, updateLead: true },
    agentType
  )
}
