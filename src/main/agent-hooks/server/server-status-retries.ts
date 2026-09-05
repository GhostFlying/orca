import { hasCodexTranscriptSubagents } from '../../../shared/agent-hook-listener/providers/codex-state'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { CodexSubagentPollScheduler } from '../../../shared/codex-subagent-poll-scheduler'
import type { EnrichedAgentHookEventPayload } from './server-types'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  CODEX_SUBAGENT_POLL_MS
} from './server-constants'
import { AgentHookServerStatusUpdate } from './server-status-update'

type CodexSubagentPoll = {
  source: Extract<AgentHookSource, 'codex' | 'trae' | 'traex'>
  body: unknown
  original: EnrichedAgentHookEventPayload
}

function codexSubagentPollKey(paneKey: string, source: 'codex' | 'trae' | 'traex'): string {
  return source === 'codex' ? paneKey : `${paneKey}\0${source}`
}

export abstract class AgentHookServerStatusRetries extends AgentHookServerStatusUpdate {
  private readonly codexSubagentPollScheduler = new CodexSubagentPollScheduler<CodexSubagentPoll>(
    CODEX_SUBAGENT_POLL_MS,
    (paneKey, poll) => this.runCodexSubagentPoll(paneKey, poll)
  )

  protected clearAllCodexSubagentPolls(): void {
    this.codexSubagentPollScheduler.clearAll()
  }

  protected clearAssistantMessageRetry(paneKey: string): void {
    const timer = this.assistantMessageRetryTimers.get(paneKey)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  protected clearCodexSubagentPoll(paneKey: string): void {
    this.codexSubagentPollScheduler.clear(paneKey)
    this.codexSubagentPollScheduler.clear(`${paneKey}\0trae`)
    this.codexSubagentPollScheduler.clear(`${paneKey}\0traex`)
  }

  protected scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void {
    // Why: an unrelated nested CLI inherits ORCA_PANE_KEY, so it must not end a live Codex-compatible poll.
    const compatibleSource =
      source === 'codex' || source === 'trae' || source === 'traex' ? source : null
    if (!compatibleSource) {
      return
    }
    const pollKey = codexSubagentPollKey(original.paneKey, compatibleSource)
    this.codexSubagentPollScheduler.clear(pollKey)
    if (!hasCodexTranscriptSubagents(this.state, original.paneKey, compatibleSource)) {
      return
    }
    this.codexSubagentPollScheduler.schedule(pollKey, {
      source: compatibleSource,
      body,
      original
    })
  }

  private runCodexSubagentPoll(pollKey: string, poll: CodexSubagentPoll): void {
    const { source, body, original } = poll
    // Keep the identity check at callback time: a newer event supersedes this
    // payload even when its pane still has transcript children.
    if (
      pollKey !== codexSubagentPollKey(original.paneKey, source) ||
      !this.server ||
      this.state.lastStatusByPaneKey.get(original.paneKey) !== original
    ) {
      return
    }
    const normalized = normalizeHookPayload(this.state, source, body, this.env)
    if (!normalized) {
      return
    }
    const subagentsChanged =
      JSON.stringify(normalized.payload.subagents) !== JSON.stringify(original.payload.subagents)
    const next = subagentsChanged ? this.applyNormalizedStatus(normalized) : original
    this.scheduleCodexSubagentPoll(source, body, next)
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
        // Why: slug-group discovery can outlive the bounded flush timers; its completion must drive the first retry deterministically.
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
    // Why: some agents POST Stop before their transcript line is flushed; discovery is event-driven, later content retries stay timed.
    this.applyNormalizedStatus(normalized.event, normalized.onAccepted)
  }
}
