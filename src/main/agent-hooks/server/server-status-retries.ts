import { TraexRootObserver, type TraexRootOwner } from '../../trae/traex-root-observer'
import type { RootTurnObservation } from '../../../shared/root-turn-observation'
import {
  isCodexCompatibleAgentType,
  codexCompatibleStateKey,
  setCodexMainAgentTurnState
} from '../../../shared/agent-hook-listener/providers/codex-state'
import { buildCodexChildDrivenStatusPayload } from '../../../shared/agent-hook-listener/providers/codex-events'
import { pollCodexTranscriptStatus } from '../../../shared/agent-hook-listener/providers/codex-transcript-poll'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { pickHostTurnEnd } from '../../../shared/agent-status-types'
import {
  shouldPollHookTranscript,
  hookTranscriptWatchPath,
  transcriptPollUpdate
} from '../../../shared/agent-hook-listener/transcript-poll-policy'
import { AgentTranscriptPollScheduler } from '../../../shared/agent-transcript-poll-scheduler'
import type { EnrichedAgentHookEventPayload } from './server-types'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  CODEX_SUBAGENT_POLL_MS
} from './server-constants'
import { AgentHookServerStatusUpdate } from './server-status-update'

type TranscriptPoll = {
  source: AgentHookSource
  body: unknown
  original: EnrichedAgentHookEventPayload
}

function transcriptPollKey(paneKey: string, source: AgentHookSource): string {
  return source === 'codex' ? paneKey : `${paneKey}\0${source}`
}

export abstract class AgentHookServerStatusRetries extends AgentHookServerStatusUpdate {
  private readonly transcriptPollScheduler = new AgentTranscriptPollScheduler<TranscriptPoll>(
    CODEX_SUBAGENT_POLL_MS,
    (paneKey, poll) => this.runTranscriptPoll(paneKey, poll)
  )

  private nativeRoots = this.createNativeRoots()

  private createNativeRoots(): TraexRootObserver {
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
      lead.outcome === 'cancellation'
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
    const next = this.applyNormalizedStatus({
      ...row,
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
    })
    if (next) {
      this.scheduleTranscriptPoll(
        'traex',
        {
          paneKey: next.paneKey,
          launchToken: next.launchToken,
          tabId: next.tabId,
          worktreeId: next.worktreeId,
          observedAgent: 'traex',
          env: this.env,
          payload: {
            session_id: owner.sessionId,
            turn_id: owner.turnId,
            transcript_path: owner.transcriptPath
          }
        },
        next
      )
    }
  }

  protected clearAllTranscriptPolls(): void {
    this.nativeRoots.stop()
    this.nativeRoots = this.createNativeRoots()
    this.transcriptPollScheduler.clearAll()
  }

  protected clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  protected clearTranscriptPoll(paneKey: string): void {
    this.transcriptPollScheduler.clear(paneKey)
    this.transcriptPollScheduler.clear(`${paneKey}\0trae`)
    this.transcriptPollScheduler.clear(`${paneKey}\0traex`)
    this.transcriptPollScheduler.clear(`${paneKey}\0muse`)
  }

  protected scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    this.nativeRoots.schedule(original.paneKey)
    // Nested CLIs inherit pane keys; another provider must not clear this transcript poll.
    if (source !== 'codex' && source !== 'trae' && source !== 'traex' && source !== 'muse') {
      return
    }
    const pollKey = transcriptPollKey(original.paneKey, source)
    this.transcriptPollScheduler.clear(pollKey)
    if (!shouldPollHookTranscript(this.state, source, original)) {
      this.transcriptPollScheduler.clear(pollKey)
      return
    }
    this.transcriptPollScheduler.schedule(
      pollKey,
      { source, body, original },
      hookTranscriptWatchPath(this.state, source, original.paneKey)
    )
  }

  private runTranscriptPoll(paneKey: string, poll: TranscriptPoll): void {
    const { source, body, original } = poll
    // Recheck ownership at callback time; newer events supersede this payload even if children remain.
    if (
      paneKey !== transcriptPollKey(original.paneKey, source) ||
      !this.server ||
      this.state.lastStatusByPaneKey.get(original.paneKey) !== original
    ) {
      return
    }
    const normalized = isCodexCompatibleAgentType(source)
      ? pollCodexTranscriptStatus(this.state, original, body, this.env, source)
      : normalizeHookPayload(this.state, source, body, this.env)
    if (!normalized) {
      return
    }
    const update = transcriptPollUpdate(source, original, normalized)
    const next = update ? this.applyNormalizedStatus(update) : original
    if (next) {
      this.scheduleTranscriptPoll(source, body, next)
    }
  }

  protected scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt = 1,
    discoveryReady = false
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    if (!discoveryReady) {
      const discovery = preparePendingGrokResultDiscovery(source, body)
      if (discovery) {
        // Discovery may outlast flush timers; retry as soon as it completes.
        void discovery
          .then(() => {
            if (this.server) {
              this.applyAssistantMessageRetry(source, body, original, 1, true)
            }
          })
          .catch((err) => {
            console.error('[agent-hooks] Grok result discovery failed:', err)
          })
        return
      }
    }
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        this.applyAssistantMessageRetry(source, body, original, attempt + 1, discoveryReady)
      } catch (err) {
        console.error('[agent-hooks] assistant message retry failed:', err)
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  protected applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this.state.lastStatusByPaneKey.get(original.paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      !current ||
      (requireExactOriginal && current !== original) ||
      current.payload.agentType !== original.payload.agentType ||
      current.payload.prompt !== original.payload.prompt ||
      current.payload.lastAssistantMessage
    ) {
      return
    }
    const normalized = this.normalizeLocalHookPayload(source, body)
    if (!normalized.event?.payload.lastAssistantMessage) {
      this.scheduleAssistantMessageRetry(source, body, original, nextAttempt, requireExactOriginal)
      return
    }
    // Stop can precede transcript flush; retries add text while preserving the same turn end.
    this.applyNormalizedStatus(
      { ...normalized.event, ...pickHostTurnEnd(current) },
      normalized.onAccepted
    )
  }
}
