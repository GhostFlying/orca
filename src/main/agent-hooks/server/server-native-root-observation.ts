import {
  TraexRootObserver,
  traexRootPollHook,
  type TraexRootOwner
} from '../../trae/traex-root-observer'
import {
  mergeRootTurnObservation,
  type RootTurnObservation
} from '../../../shared/root-turn-observation'
import {
  codexCompatibleStateKey,
  setCodexMainAgentTurnState
} from '../../../shared/agent-hook-listener/providers/codex-state'
import { buildCodexChildDrivenStatusPayload } from '../../../shared/agent-hook-listener/providers/codex-events'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerStatusUpdate } from './server-status-update'

export abstract class AgentHookServerNativeRootObservation extends AgentHookServerStatusUpdate {
  protected abstract scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void

  protected nativeRoots = this.createNativeRoots()

  protected createNativeRoots(): TraexRootObserver {
    return new TraexRootObserver(
      (paneKey) => this.nativeRootOwner(paneKey),
      (owner, observation) => this.publishNativeRoot(owner, observation)
    )
  }

  private nativeRootOwner(paneKey: string): TraexRootOwner | undefined {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    if (
      !this.server ||
      !row ||
      row.connectionId !== null ||
      row.restoredUnconfirmed ||
      row.structuredHost ||
      !row.launchToken ||
      row.payload.agentType !== 'traex' ||
      !row.providerSession?.id ||
      !row.providerSession.transcriptPath
    ) {
      return undefined
    }
    const key = codexCompatibleStateKey(paneKey, 'traex')
    const lead = this.state.codexLeadStateByPaneKey.get(key)
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
    const row = this.state.lastStatusByPaneKey.get(owner.paneKey)
    if (!row) {
      return
    }
    const key = codexCompatibleStateKey(owner.paneKey, 'traex')
    const lead = this.state.codexLeadStateByPaneKey.get(key)
    if (!lead) {
      return
    }
    rootTurn = mergeRootTurnObservation(row.rootTurn, rootTurn)
    if (lead.state === 'done' && rootTurn.state === 'running') {
      return
    }
    const ended =
      rootTurn.state === 'failed' ||
      rootTurn.state === 'completed' ||
      rootTurn.state === 'cancelled'
    if (ended) {
      setCodexMainAgentTurnState(
        this.state,
        key,
        {
          model: lead.model,
          sessionId: lead.sessionId,
          turnId: lead.turnId,
          state: 'done',
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
      ? buildCodexChildDrivenStatusPayload(this.state, undefined, owner.paneKey, {}, 'traex')
      : row.payload
    if (!payload) {
      return
    }
    const next = this.applyRestatedStatus(
      {
        ...row,
        toolAgentId: undefined,
        teammateName: undefined,
        toolAgentType: undefined,
        toolUseId: undefined,
        rootTurn: {
          ...rootTurn,
          hostStartedAt:
            'turnStartedAt' in row && typeof row.turnStartedAt === 'number'
              ? row.turnStartedAt
              : undefined
        },
        payload,
        hookEventName: undefined,
        hasExplicitPrompt: undefined
      },
      (!ended || lead.state === 'done') &&
        'evidenceObservedAt' in row &&
        typeof row.evidenceObservedAt === 'number'
        ? row.evidenceObservedAt
        : undefined
    )
    if (next) {
      this.scheduleTranscriptPoll('traex', traexRootPollHook(owner, next, this.env), next)
    }
  }
}
