import { buildCodexStatusPayload, buildCodexChildDrivenStatusPayload } from './codex-status-payload'
export { buildCodexStatusPayload, buildCodexChildDrivenStatusPayload } from './codex-status-payload'
import { AGENT_MODEL_MAX_LENGTH, type ParsedAgentStatusPayload } from '../../agent-status-types'
import { normalizeOptionalField } from '../../agent-status-field-normalization'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  enrichCodexSubagentIdentity,
  finishCodexSubagent,
  upsertCodexSubagent
} from '../../codex-subagent-roster'
import {
  codexTranscriptTurnEnd,
  reconcileCodexSubagentTranscript
} from '../../codex-subagent-transcript'
import {
  codexTurnApprovalsAreAutoReviewed,
  reconcileCodexSubagentReviewer
} from '../../codex-subagent-reviewer'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import {
  codexLeadOutcomeForEvent,
  clearCodexCompatibleState,
  codexCompatibleStateKey,
  type CodexCompatibleAgentType,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  hasCodexTranscriptSubagents,
  resolveCodexPaneStatus,
  setCodexMainAgentTurnState
} from './codex-state'

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
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
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
    enrichCodexSubagentIdentity(
      roster,
      agentId,
      readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
    )
    const parentPath =
      state.codexSubagentTranscriptByPaneKey.get(stateKey)?.parent.filePath ??
      state.lastStatusByPaneKey.get(stateKey)?.providerSession?.transcriptPath
    if (parentPath) {
      reconcileCodexSubagentTranscript(
        getOrCreateCodexSubagentTranscriptState(state, paneKey, agentType),
        roster,
        parentPath
      )
    }
  } else {
    finishCodexSubagent(roster, agentId)
    state.codexSubagentTranscriptByPaneKey.get(stateKey)?.subagents.delete(agentId)
  }
  return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload, agentType)
}

/** Codex PermissionRequest precedes reviewer/user decisions; suppress reviewer-owned waiting (STA-7698). request_user_input still blocks a human on PreToolUse (#9861). */
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
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return normalizeCodexSubagentLifecycleEvent(state, eventName, paneKey, hookPayload, agentType)
  }

  // Auto-allowed request_user_input still blocks on PreToolUse (Codex0.145+).
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
        : eventName === 'Stop' || eventName === 'Interrupt'
          ? 'done'
          : null
  if (!stateName) {
    return null
  }

  const agentId = readString(hookPayload, 'agent_id')
  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  if (eventName === 'SessionStart' && !agentId) {
    // New processes must not retain children whose Stop hooks were lost.
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
  if (!agentId && (eventName === 'UserPromptSubmit' || eventName === 'SessionStart')) {
    const transcript = state.codexSubagentTranscriptByPaneKey.get(stateKey)
    if (transcript) {
      transcript.rootTurn.interrupted = false
    }
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
    enrichCodexSubagentIdentity(
      getOrCreateCodexSubagentRoster(state, paneKey, agentType),
      agentId,
      transcriptPath
    )
    return buildCodexChildDrivenStatusPayload(state, eventName, paneKey, hookPayload, agentType)
  }

  if (eventName === 'Stop' && !hasCodexTranscriptSubagents(state, paneKey, agentType)) {
    // Clear the existing roster so missing child Stops cannot reseed stale children from the previous row (CLI0.144).
    getOrCreateCodexSubagentRoster(state, paneKey, agentType).clear()
  }
  // Classify with reviewer evidence just read from this turn's rollout, never a prior event.
  const ownedState = resolveCodexApprovalOwnedState(
    state,
    eventName,
    paneKey,
    transcriptPath,
    stateName,
    agentType
  )
  const previousLead = state.codexLeadStateByPaneKey.get(stateKey)
  const transcript = state.codexSubagentTranscriptByPaneKey.get(stateKey)
  const turnId = readString(hookPayload, 'turn_id')
  // Why: Codex fires no Stop for a failed turn, so a Stop for one is the rollout's end replayed.
  const failedTurn =
    eventName === 'Stop' &&
    previousLead?.state !== 'done' &&
    turnId !== undefined &&
    codexTranscriptTurnEnd(transcript, turnId) === 'failed'
  // Why: a compaction inside a running turn keeps that turn; one queued before the next turn follows an ended one.
  const startsTurn =
    eventName === 'UserPromptSubmit' ||
    (eventName === 'SessionStart' &&
      (readString(hookPayload, 'source') !== 'compact' ||
        previousLead?.state === 'done' ||
        !previousLead?.turnId ||
        codexTranscriptTurnEnd(transcript, previousLead.turnId) !== undefined))
  const record = setCodexMainAgentTurnState(state, stateKey, {
    state: ownedState,
    ...(failedTurn
      ? { outcome: 'failure' as const }
      : codexLeadOutcomeForEvent(eventName, previousLead, ownedState)),
    model:
      normalizeOptionalField(hookPayload['model'], AGENT_MODEL_MAX_LENGTH) ??
      (eventName === 'SessionStart' ? undefined : previousLead?.model),
    sessionId: readString(hookPayload, 'session_id'),
    turnId: turnId ?? (startsTurn ? null : undefined)
  })
  return buildCodexStatusPayload(
    state,
    eventName,
    promptText,
    paneKey,
    hookPayload,
    { ...resolveCodexPaneStatus(state, paneKey, record, agentType), updateLead: true },
    agentType
  )
}

/** Replay rollout-confirmed root ends as missing Stops, including /review; drop delayed hooks once the lead moved to another turn. */
export function codexHookEventForEndedTurn(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
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
  if (!codexTranscriptTurnEnd(state.codexSubagentTranscriptByPaneKey.get(paneKey), turnId)) {
    return eventName
  }
  const leadTurnId = state.codexLeadStateByPaneKey.get(paneKey)?.turnId
  return leadTurnId && leadTurnId !== turnId ? undefined : 'Stop'
}
