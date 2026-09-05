import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import {
  codexRosterEffectiveState,
  codexRosterToSnapshots,
  finishCodexSubagent,
  seedCodexSubagentRoster,
  type CodexSubagentRoster
} from '../../codex-subagent-roster'
import {
  createCodexSubagentTranscriptState,
  hasTrackedCodexTranscriptSubagents,
  type CodexSubagentTranscriptState
} from '../../codex-subagent-transcript'
import type { CodexLeadTurnState, HookListenerState } from '../listener-state'

export type CodexCompatibleAgentType = 'codex' | 'trae' | 'traex'

export function isCodexCompatibleAgentType(value: unknown): value is CodexCompatibleAgentType {
  return value === 'codex' || value === 'trae' || value === 'traex'
}

export function codexCompatibleStateKey(
  paneKey: string,
  agentType: CodexCompatibleAgentType = 'codex'
): string {
  return agentType === 'codex' ? paneKey : `${paneKey}\0${agentType}`
}

export function getOrCreateCodexSubagentRoster(
  state: HookListenerState,
  paneKey: string,
  agentType: CodexCompatibleAgentType = 'codex'
): CodexSubagentRoster {
  const key = codexCompatibleStateKey(paneKey, agentType)
  let roster = state.codexSubagentRosterByPaneKey.get(key)
  if (!roster) {
    roster = new Map()
    state.codexSubagentRosterByPaneKey.set(key, roster)
  }
  return roster
}

export function getOrCreateCodexSubagentTranscriptState(
  state: HookListenerState,
  paneKey: string,
  agentType: CodexCompatibleAgentType = 'codex'
): CodexSubagentTranscriptState {
  const key = codexCompatibleStateKey(paneKey, agentType)
  let transcriptState = state.codexSubagentTranscriptByPaneKey.get(key)
  if (!transcriptState) {
    transcriptState = createCodexSubagentTranscriptState()
    state.codexSubagentTranscriptByPaneKey.set(key, transcriptState)
  }
  return transcriptState
}

export function hasCodexTranscriptSubagents(
  state: HookListenerState,
  paneKey: string,
  agentType: CodexCompatibleAgentType = 'codex'
): boolean {
  return hasTrackedCodexTranscriptSubagents(
    state.codexSubagentTranscriptByPaneKey.get(codexCompatibleStateKey(paneKey, agentType))
  )
}

export function seedCodexStateFromSnapshot(
  state: HookListenerState,
  paneKey: string,
  payload: Pick<ParsedAgentStatusPayload, 'model' | 'state' | 'subagents'>,
  agentType: CodexCompatibleAgentType = 'codex'
): void {
  const key = codexCompatibleStateKey(paneKey, agentType)
  const snapshots = payload.subagents ?? []
  if (snapshots.length > 0 && !state.codexSubagentRosterByPaneKey.has(key)) {
    seedCodexSubagentRoster(getOrCreateCodexSubagentRoster(state, paneKey, agentType), snapshots)
  }
  if (!state.codexLeadStateByPaneKey.has(key)) {
    // Why: child hooks after restart omit the root model; seed it from durable status before they can overwrite the cache.
    state.codexLeadStateByPaneKey.set(key, {
      // Why: a child wait drives the aggregate waiting state, so it is not evidence that the root itself was waiting.
      state:
        payload.state === 'done'
          ? 'done'
          : payload.state === 'waiting' &&
              !snapshots.some((snapshot) => snapshot.state === 'waiting')
            ? 'waiting'
            : 'working',
      model: payload.model
    })
  }
}

/** Sync the Codex lead record when the server infers an interrupt, so delayed child events cannot restore stale working state. */
export function markCodexLeadTurnInterrupted(
  state: HookListenerState,
  paneKey: string,
  agentType: CodexCompatibleAgentType = 'codex'
): void {
  const key = codexCompatibleStateKey(paneKey, agentType)
  const lead = state.codexLeadStateByPaneKey.get(key)
  state.codexLeadStateByPaneKey.set(key, { state: 'done', model: lead?.model })
}

export function clearCodexCompatibleState(
  state: HookListenerState,
  paneKey: string,
  agentType: CodexCompatibleAgentType
): void {
  const key = codexCompatibleStateKey(paneKey, agentType)
  state.codexSubagentRosterByPaneKey.delete(key)
  state.codexSubagentTranscriptByPaneKey.delete(key)
  state.codexLeadStateByPaneKey.delete(key)
}

export function codexLeadStateForHookEvent(
  eventName: string | undefined
): CodexLeadTurnState['state'] | undefined {
  if (eventName === 'Stop') {
    return 'done'
  }
  if (eventName === 'PermissionRequest') {
    return 'waiting'
  }
  if (
    eventName === 'SessionStart' ||
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    return 'working'
  }
  return undefined
}

/** Why: relay restarts lose lead/roster state; merge child events into main's longer-lived cache. */
export function reconcileRemoteCodexState(
  state: HookListenerState,
  paneKey: string,
  eventName: string | undefined,
  agentId: string | undefined,
  payload: ParsedAgentStatusPayload,
  previous: ParsedAgentStatusPayload | undefined,
  agentType: CodexCompatibleAgentType = 'codex'
): ParsedAgentStatusPayload {
  const key = codexCompatibleStateKey(paneKey, agentType)
  if (previous?.agentType === agentType) {
    seedCodexStateFromSnapshot(state, paneKey, previous, agentType)
  } else {
    seedCodexStateFromSnapshot(state, paneKey, payload, agentType)
  }

  // Why: older relays send child identity without roster snapshots; keep their already-normalized aggregate authoritative.
  if (agentId && !payload.subagents && !state.codexSubagentRosterByPaneKey.has(key)) {
    return payload
  }
  const roster = getOrCreateCodexSubagentRoster(state, paneKey, agentType)
  if (payload.subagents) {
    seedCodexSubagentRoster(roster, payload.subagents)
  }
  if (agentId) {
    if (eventName === 'SubagentStop') {
      finishCodexSubagent(roster, agentId)
    }
  } else {
    const leadState = codexLeadStateForHookEvent(eventName)
    if (eventName === 'SessionStart' || (eventName === 'Stop' && !payload.subagents)) {
      roster.clear()
    }
    if (leadState) {
      const previousLead = state.codexLeadStateByPaneKey.get(key)
      state.codexLeadStateByPaneKey.set(key, {
        state: leadState,
        model: payload.model ?? previousLead?.model
      })
    }
  }

  const lead = state.codexLeadStateByPaneKey.get(key)
  if (!lead) {
    return payload
  }
  // Child lifecycle hooks commonly omit the root prompt. Preserve the last known
  // turn label while merging their roster/state so relay restarts do not blank it.
  const prompt =
    agentId && payload.prompt.length === 0 && previous?.agentType === agentType
      ? previous.prompt
      : payload.prompt
  return {
    ...payload,
    prompt,
    state: codexRosterEffectiveState(roster, lead.state),
    model: lead.model ?? payload.model,
    subagents: codexRosterToSnapshots(roster)
  }
}
