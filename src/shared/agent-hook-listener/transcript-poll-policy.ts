import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import {
  codexCompatibleStateKey,
  hasCodexTranscriptSubagents,
  isCodexCompatibleAgentType
} from './providers/codex-state'
import { hasMuseSessionLog } from './providers/muse-events'

export function shouldPollHookTranscript(
  state: HookListenerState,
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  if (isCodexCompatibleAgentType(source)) {
    const key = codexCompatibleStateKey(event.paneKey, source)
    return (
      hasCodexTranscriptSubagents(state, event.paneKey, source) ||
      (state.codexLeadStateByPaneKey.get(key)?.state !== 'done' &&
        Boolean(state.codexSubagentTranscriptByPaneKey.get(key)?.parent.filePath))
    )
  }
  if (source === 'muse') {
    // Muse question waits/answers exist only in the session log.
    return event.payload.state !== 'done' && hasMuseSessionLog(state, event.paneKey)
  }
  return false
}

/** Child rollout discovery keeps its existing cadence; only a root-only pane can use one file watch. */
export function hookTranscriptWatchPath(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string
): string | undefined {
  return isCodexCompatibleAgentType(source) && !hasCodexTranscriptSubagents(state, paneKey, source)
    ? state.codexSubagentTranscriptByPaneKey.get(codexCompatibleStateKey(paneKey, source))?.parent
        .filePath
    : undefined
}

export function transcriptPollUpdate<T extends AgentHookEventPayload>(
  source: AgentHookSource,
  original: T,
  polled: T
): T | undefined {
  if (original === polled) {
    return undefined
  }
  if (source === 'muse') {
    const changed =
      polled.payload.state !== original.payload.state ||
      polled.payload.interactivePrompt !== original.payload.interactivePrompt
    // Replayed prompt bodies cannot create new prompt or turn boundaries.
    return changed
      ? { ...polled, hasExplicitPrompt: undefined, hookEventName: undefined }
      : undefined
  }
  const subagentsChanged =
    JSON.stringify(polled.payload.subagents) !== JSON.stringify(original.payload.subagents)
  const leadChanged =
    polled.payload.mainAgent?.state !== original.payload.mainAgent?.state ||
    polled.payload.mainAgent?.outcome !== original.payload.mainAgent?.outcome
  if (!subagentsChanged && !leadChanged) {
    return undefined
  }
  // Keep root Stop for remote turn-end derivation, but unlabel failures so clients cannot derive success.
  const replayedStop =
    polled.hookEventName === 'Stop' &&
    original.payload.mainAgent?.state !== 'done' &&
    polled.payload.mainAgent?.outcome !== 'failure'
  return {
    ...polled,
    hasExplicitPrompt: undefined,
    hookEventName: replayedStop ? 'Stop' : undefined
  }
}
