import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { isCodexCompatibleAgentType } from '../../../shared/agent-hook-listener/providers/codex-state'
import { interruptCodexCompatibleTurn } from './server-codex-status-rules'

export function prepareMainAgentInterrupt(
  state: HookListenerState,
  event: AgentHookEventPayload
): boolean {
  const { payload, paneKey } = event
  const childWorkEvidenced =
    payload.subagents?.some((subagent) => subagent.state !== 'idle') === true ||
    (payload.agentType === 'claude' &&
      (state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
        state.claudeActiveSessionCronPaneKeys.has(paneKey)))
  if (
    payload.mainAgent
      ? payload.mainAgent.state !== 'working' ||
        (isCodexCompatibleAgentType(payload.agentType) && childWorkEvidenced)
      : childWorkEvidenced
  ) {
    return false
  }
  interruptCodexCompatibleTurn(state, event)
  return true
}
