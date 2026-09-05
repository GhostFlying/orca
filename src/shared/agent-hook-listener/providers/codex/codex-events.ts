import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import type { ParsedAgentStatusPayload } from '../../../agent-status/contracts/agent-status-types'
import {
  enrichCodexSubagentIdentity,
  finishCodexSubagent,
  upsertCodexSubagent
} from './codex-subagent-roster'
import {
  codexTranscriptTurnEnd,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import {
  codexTurnApprovalsAreAutoReviewed,
  reconcileCodexSubagentReviewer
} from './codex-subagent-reviewer'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'
import {
  buildCodexChildDrivenStatusPayload,
  buildCodexStatusPayload
} from '../codex-status-payload'
export {
  buildCodexChildDrivenStatusPayload,
  buildCodexStatusPayload
} from '../codex-status-payload'
import { applyCodexSessionStart } from './codex-session-start'
import {
  codexHookEventState,
  codexLeadOutcomeForEvent,
  codexCompatibleStateKey,
  type CodexCompatibleAgentType,
  getOrCreateCodexSubagentRoster,
  getOrCreateCodexSubagentTranscriptState,
  hasCodexTranscriptSubagents,
  resolveCodexPaneStatus,
  setCodexMainAgentTurnState
} from './codex-state'
import { trackCodexAsyncQuestions } from './codex-async-questions'
import { reviewerEvidenceDeferred } from './codex-rollout-prefetch-scope'

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
  // Unread rollout bytes may hold a newer reviewer; show the prompt rather than risk hiding a human's approval.
  if (stateName !== 'waiting' || eventName !== 'PermissionRequest' || reviewerEvidenceDeferred()) {
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
  agentType: CodexCompatibleAgentType = 'codex',
  originalEventName: unknown = eventName
): ParsedAgentStatusPayload | null {
  const stateKey = codexCompatibleStateKey(paneKey, agentType)
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return normalizeCodexSubagentLifecycleEvent(state, eventName, paneKey, hookPayload, agentType)
  }

  if (eventName === 'SessionStart' && originalEventName !== 'UserPromptSubmit') {
    const start = applyCodexSessionStart(
      state,
      paneKey,
      {
        sessionId: readString(hookPayload, 'session_id'),
        source: readString(hookPayload, 'source'),
        agentId: readString(hookPayload, 'agent_id'),
        model: normalizeOptionalField(hookPayload.model, AGENT_MODEL_MAX_LENGTH)
      },
      agentType
    )
    return (
      start && buildCodexStatusPayload(state, eventName, '', paneKey, hookPayload, start, agentType)
    )
  }

  const activityEventName =
    eventName === 'SessionStart' && originalEventName === 'UserPromptSubmit'
      ? originalEventName
      : eventName
  const stateName = codexHookEventState(
    activityEventName,
    readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
  )
  if (!stateName) {
    return null
  }

  const agentId = readString(hookPayload, 'agent_id')
  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  if (eventName === 'SessionStart' && !agentId) {
    // New processes must not retain children whose Stop hooks were lost.
    state.codexSubagentRosterByPaneKey.delete(stateKey)
    state.codexSubagentTranscriptByPaneKey.delete(stateKey)
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
  // An open async question needs the user even while Codex keeps working.
  const leadState =
    trackCodexAsyncQuestions(state, stateKey, eventName, hookPayload) && ownedState === 'working'
      ? 'waiting'
      : ownedState
  const previousLead = state.codexLeadStateByPaneKey.get(stateKey)
  const transcript = state.codexSubagentTranscriptByPaneKey.get(stateKey)
  const turnId = readString(hookPayload, 'turn_id')
  const sessionId = readString(hookPayload, 'session_id')
  // Why: Codex fires no Stop for a failed turn, so a Stop for one is the rollout's end replayed.
  const failedTurn =
    eventName === 'Stop' &&
    previousLead?.state !== 'done' &&
    turnId !== undefined &&
    codexTranscriptTurnEnd(transcript, turnId) === 'failed'
  const startsTurn = activityEventName === 'UserPromptSubmit'
  const record = setCodexMainAgentTurnState(state, stateKey, {
    state: leadState,
    ...(startsTurn &&
    ((turnId && turnId !== previousLead?.turnId) ||
      (sessionId && sessionId !== previousLead?.sessionId))
      ? { stateStartedAt: Date.now() }
      : {}),
    ...(failedTurn
      ? { outcome: 'failure' as const }
      : codexLeadOutcomeForEvent(eventName, previousLead, leadState)),
    model:
      normalizeOptionalField(hookPayload['model'], AGENT_MODEL_MAX_LENGTH) ??
      (eventName === 'SessionStart' ? undefined : previousLead?.model),
    sessionId,
    turnId: turnId ?? (startsTurn ? null : undefined)
  })
  return buildCodexStatusPayload(
    state,
    eventName,
    promptText,
    paneKey,
    hookPayload,
    {
      ...resolveCodexPaneStatus(state, paneKey, record, agentType),
      updateLead: true,
      reviewerOwnsApproval: stateName === 'waiting' && ownedState === 'working'
    },
    agentType
  )
}
