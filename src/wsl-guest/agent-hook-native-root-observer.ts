import { TraexRootObserver, type TraexRootOwner } from '../main/trae/traex-root-observer'
import { mergeRootTurnObservation, type RootTurnObservation } from '../shared/root-turn-observation'
import {
  codexCompatibleStateKey,
  setCodexMainAgentTurnState
} from '../shared/agent-hook-listener/providers/codex-state'
import { buildCodexChildDrivenStatusPayload } from '../shared/agent-hook-listener/providers/codex-events'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookResultRetryHost } from './agent-hook-result-retry-scheduler'

export class RelayTraexRootObserver {
  private nativeRoots: TraexRootObserver
  private readonly nativeTurnStarts = new Map<string, { turnId: string; startedAt: number }>()
  constructor(
    private readonly host: AgentHookResultRetryHost,
    private readonly scheduleTranscriptPoll: (
      source: 'traex',
      body: unknown,
      next: AgentHookEventPayload,
      env: string
    ) => void
  ) {
    this.nativeRoots = this.createNativeRoots()
  }
  schedule(original: AgentHookEventPayload): void {
    if (original.payload.agentType === 'traex' && original.hookEventName === 'UserPromptSubmit') {
      const lead = this.host.state.codexLeadStateByPaneKey.get(
        codexCompatibleStateKey(original.paneKey, 'traex')
      )
      if (lead?.turnId && this.nativeTurnStarts.get(original.paneKey)?.turnId !== lead.turnId) {
        this.nativeTurnStarts.set(original.paneKey, { turnId: lead.turnId, startedAt: Date.now() })
      }
    }
    this.nativeRoots.schedule(original.paneKey)
  }
  clear(): void {
    this.nativeRoots.stop()
    this.nativeRoots = this.createNativeRoots()
    this.nativeTurnStarts.clear()
  }
  private createNativeRoots(): TraexRootObserver {
    return new TraexRootObserver(
      (paneKey) => this.nativeOwner(paneKey),
      (owner, fact) => this.publishNativeRoot(owner, fact)
    )
  }

  private nativeOwner(paneKey: string): TraexRootOwner | undefined {
    const row = this.host.state.lastStatusByPaneKey.get(paneKey)
    if (
      !this.host.isListening() ||
      !row ||
      row.connectionId !== null ||
      row.structuredHost ||
      row.restoredUnconfirmed ||
      !row.launchToken ||
      row.payload.agentType !== 'traex' ||
      !row.providerSession?.id ||
      !row.providerSession.transcriptPath
    ) {
      return undefined
    }
    const lead = this.host.state.codexLeadStateByPaneKey.get(
      codexCompatibleStateKey(paneKey, 'traex')
    )
    if (
      !lead?.turnId ||
      lead.sessionId !== row.providerSession.id ||
      (lead.outcome === 'cancellation' && row.rootTurn?.state !== 'cancelled')
    ) {
      return undefined
    }
    if (
      row.rootTurn?.turnId === lead.turnId &&
      row.rootTurn.state !== 'unknown' &&
      row.rootTurn.state !== 'running' &&
      row.rootTurn.operations === 'settled'
    ) {
      return undefined
    }
    return {
      paneKey,
      launchToken: row.launchToken,
      sessionId: row.providerSession.id,
      turnId: lead.turnId,
      transcriptPath: row.providerSession.transcriptPath
    }
  }

  private publishNativeRoot(owner: TraexRootOwner, rootTurn: RootTurnObservation): void {
    const row = this.host.state.lastStatusByPaneKey.get(owner.paneKey)
    const key = codexCompatibleStateKey(owner.paneKey, 'traex')
    const lead = this.host.state.codexLeadStateByPaneKey.get(key)
    if (!row || !lead || (lead.state === 'done' && rootTurn.state === 'running')) {
      return
    }
    rootTurn = mergeRootTurnObservation(row.rootTurn, rootTurn)
    const start = this.nativeTurnStarts.get(owner.paneKey)
    const hostStartedAt =
      start?.turnId === owner.turnId ? start.startedAt : row.rootTurn?.hostStartedAt
    const ended =
      rootTurn.state === 'failed' ||
      rootTurn.state === 'completed' ||
      rootTurn.state === 'cancelled'
    if (ended) {
      setCodexMainAgentTurnState(
        this.host.state,
        key,
        {
          state: 'done',
          model: lead.model,
          sessionId: lead.sessionId,
          turnId: lead.turnId,
          outcome:
            rootTurn.state === 'failed'
              ? 'failure'
              : rootTurn.state === 'cancelled'
                ? 'cancellation'
                : 'success'
        },
        rootTurn.completedAt ?? rootTurn.observedAt
      )
    }
    const payload = ended
      ? buildCodexChildDrivenStatusPayload(this.host.state, undefined, owner.paneKey, {}, 'traex')
      : row.payload
    if (!payload) {
      return
    }
    const next = this.host.applyEvent(
      {
        ...row,
        toolAgentId: undefined,
        teammateName: undefined,
        toolAgentType: undefined,
        toolUseId: undefined,
        payload,
        rootTurn: { ...rootTurn, hostStartedAt },
        hostEvidenceObservedAt:
          lead.state !== 'done' && ended ? Date.now() : row.hostEvidenceObservedAt,
        hookEventName: undefined,
        hasExplicitPrompt: undefined
      },
      'traex',
      this.host.env
    )
    if (next) {
      this.scheduleTranscriptPoll(
        'traex',
        {
          paneKey: next.paneKey,
          launchToken: next.launchToken,
          tabId: next.tabId,
          worktreeId: next.worktreeId,
          observedAgent: 'traex',
          payload: {
            session_id: owner.sessionId,
            turn_id: owner.turnId,
            transcript_path: owner.transcriptPath
          }
        },
        next,
        this.host.env
      )
    }
  }
}
