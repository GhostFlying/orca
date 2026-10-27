import { record } from '../../codex-rollout-jsonl-cursor'
import {
  codexTranscriptTurnEnd,
  reconcileCodexSubagentTranscript
} from '../../codex-subagent-transcript'
import { normalizeHookPayload } from '../../agent-hook-listener'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { buildCodexChildDrivenStatusPayload } from './codex-events'
import {
  codexCompatibleStateKey,
  getOrCreateCodexSubagentRoster,
  markCodexLeadTurnInterrupted,
  type CodexCompatibleAgentType
} from './codex-state'

/** Poll new host rollout records without replaying starting hooks; replay ended root turns as Stops skipped for internal subagents. */
export function pollCodexTranscriptStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  body: unknown,
  env: string,
  source: CodexCompatibleAgentType = 'codex'
): AgentHookEventPayload | undefined {
  const key = codexCompatibleStateKey(original.paneKey, source)
  const transcript = state.codexSubagentTranscriptByPaneKey.get(key)
  if (!transcript?.parent.filePath) {
    return undefined
  }
  const changed = reconcileCodexSubagentTranscript(
    transcript,
    getOrCreateCodexSubagentRoster(state, original.paneKey, source),
    transcript.parent.filePath
  )
  const lead = state.codexLeadStateByPaneKey.get(key)
  const interrupted = transcript.rootTurn.interrupted && lead?.state !== 'done'
  const envelope = record(body)
  if (
    !interrupted &&
    envelope &&
    lead?.turnId &&
    lead.state !== 'done' &&
    codexTranscriptTurnEnd(transcript, lead.turnId)
  ) {
    const stop = {
      ...envelope,
      hook_event_name: undefined,
      hookEventName: undefined,
      payload: {
        hook_event_name: 'Stop',
        ...(lead.sessionId ? { session_id: lead.sessionId } : {}),
        turn_id: lead.turnId,
        transcript_path: transcript.parent.filePath
      }
    }
    return normalizeHookPayload(state, source, stop, env) ?? undefined
  }
  if (!changed && !interrupted) {
    return original
  }
  if (interrupted) {
    markCodexLeadTurnInterrupted(state, original.paneKey, source)
  }
  const payload = buildCodexChildDrivenStatusPayload(state, undefined, original.paneKey, {}, source)
  // Why: only a replayed Stop may carry an event name; this row restates the last hook's.
  return payload ? { ...original, hookEventName: undefined, payload } : undefined
}
