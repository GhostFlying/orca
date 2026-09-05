import type { AgentMainAgentStatus, ParsedAgentStatusPayload } from '../../agent-status-types'
import {
  continueMainAgentStatus,
  foldAgentLeadStatus,
  mainAgentTurnInterrupted,
  type AgentLeadStatusResolution
} from '../../agent-lead-status-fold'
import {
  codexRosterChildWorkLiveness,
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

export type CodexCompatibleAgentType = 'codex' | 'trae'

export function isCodexCompatibleAgentType(value: unknown): value is CodexCompatibleAgentType {
  return value === 'codex' || value === 'trae'
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

/** The only writer of the root record; the root's clock keeps continuity across same-state writes. */
export function setCodexMainAgentTurnState(
  state: HookListenerState,
  paneKey: string,
  next: Omit<CodexLeadTurnState, 'stateStartedAt'> & { stateStartedAt?: number },
  now = Date.now()
): CodexLeadTurnState {
  const previous = state.codexLeadStateByPaneKey.get(paneKey)
  const continued = continueMainAgentStatus(previous, next, now)
  const record: CodexLeadTurnState = {
    state: next.state,
    ...(continued.outcome ? { outcome: continued.outcome } : {}),
    stateStartedAt: continued.stateStartedAt,
    model: next.model
  }
  state.codexLeadStateByPaneKey.set(paneKey, record)
  return record
}

/** A root Stop that lands on an already finished turn (late, after an inferred cancel) restates
 *  that turn, so it keeps the recorded verdict; only a new turn clears it. */
export function codexOutcomeRestatedByStop(
  previous: CodexLeadTurnState | undefined,
  nextState: CodexLeadTurnState['state']
): Pick<CodexLeadTurnState, 'outcome'> {
  return nextState === 'done' && previous?.state === 'done' && previous.outcome
    ? { outcome: previous.outcome }
    : {}
}

/** The combined row state for a Codex pane: the root record and its roster through the same
 *  fold every other lane uses. */
export function resolveCodexPaneStatus(
  state: HookListenerState,
  paneKey: string,
  record: Pick<CodexLeadTurnState, 'state'>,
  agentType: CodexCompatibleAgentType = 'codex'
): AgentLeadStatusResolution {
  return foldAgentLeadStatus({
    leadState: record.state,
    childWorkLiveness: codexRosterChildWorkLiveness(
      state.codexSubagentRosterByPaneKey.get(codexCompatibleStateKey(paneKey, agentType))
    )
  })
}

/** The `mainAgent` fact a Codex row publishes, straight from the root record. */
export function codexMainAgentStatusForPayload(
  record: CodexLeadTurnState | undefined
): AgentMainAgentStatus | undefined {
  return record
    ? {
        state: record.state,
        ...(record.state === 'done' && record.outcome ? { outcome: record.outcome } : {}),
        stateStartedAt: record.stateStartedAt
      }
    : undefined
}

export function seedCodexStateFromSnapshot(
  state: HookListenerState,
  paneKey: string,
  payload: Pick<ParsedAgentStatusPayload, 'model' | 'state' | 'subagents' | 'mainAgent'>,
  agentType: CodexCompatibleAgentType = 'codex'
): void {
  const key = codexCompatibleStateKey(paneKey, agentType)
  const snapshots = payload.subagents ?? []
  if (snapshots.length > 0 && !state.codexSubagentRosterByPaneKey.has(key)) {
    seedCodexSubagentRoster(getOrCreateCodexSubagentRoster(state, paneKey, agentType), snapshots)
  }
  if (!state.codexLeadStateByPaneKey.has(key)) {
    const mainAgent = payload.mainAgent
    // Why: child hooks after restart omit the root model; seed it from durable status before they can overwrite the cache.
    // A row that carries the root's own state is the fact; only an older row makes us infer it.
    if (mainAgent && mainAgent.state !== 'blocked') {
      setCodexMainAgentTurnState(state, key, {
        state: mainAgent.state,
        ...(mainAgent.outcome ? { outcome: mainAgent.outcome } : {}),
        stateStartedAt: mainAgent.stateStartedAt,
        model: payload.model
      })
      return
    }
    setCodexMainAgentTurnState(state, key, {
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
  setCodexMainAgentTurnState(state, key, {
    state: 'done',
    outcome: 'cancellation',
    model: lead?.model
  })
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
  eventName: string | undefined,
  normalizedState?: ParsedAgentStatusPayload['state']
): CodexLeadTurnState['state'] | undefined {
  if (eventName === 'Stop') {
    return 'done'
  }
  if (eventName === 'PermissionRequest') {
    // Why: the execution host's normalizer already ruled on whether this approval is human-owned
    // or reviewer-owned, reading the reviewer off that host's rollout (STA-7698). Re-deriving
    // 'waiting' from the event name here would discard that verdict for every relayed pane.
    return normalizedState === 'working' ? 'working' : 'waiting'
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
    const leadState = codexLeadStateForHookEvent(eventName, payload.state)
    if (eventName === 'SessionStart' || (eventName === 'Stop' && !payload.subagents)) {
      roster.clear()
    }
    if (leadState) {
      const previousLead = state.codexLeadStateByPaneKey.get(key)
      setCodexMainAgentTurnState(state, key, {
        state: leadState,
        ...codexOutcomeRestatedByStop(previousLead, leadState),
        model: payload.model ?? previousLead?.model
      })
    }
  }

  const lead = state.codexLeadStateByPaneKey.get(key)
  if (!lead) {
    return payload
  }
  const resolution = resolveCodexPaneStatus(state, paneKey, lead, agentType)
  // Child lifecycle hooks commonly omit the root prompt. Preserve the last known
  // turn label while merging their roster/state so relay restarts do not blank it.
  const prompt =
    agentId && payload.prompt.length === 0 && previous?.agentType === agentType
      ? previous.prompt
      : payload.prompt
  return {
    ...payload,
    prompt,
    state: resolution.stateName,
    workingMode: resolution.workingMode,
    interrupted:
      resolution.stateName === 'done' && mainAgentTurnInterrupted(lead) ? true : undefined,
    model: lead.model ?? payload.model,
    subagents: codexRosterToSnapshots(roster),
    // Why: main's cache outlives a relay restart, so it is the main agent fact for a relayed row too.
    mainAgent: codexMainAgentStatusForPayload(lead)
  }
}
