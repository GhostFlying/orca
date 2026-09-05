import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import {
  clearCodexCompatibleState,
  isCodexCompatibleAgentType
} from '../../../shared/agent-hook-listener/providers/codex-state'
import type { EnrichedAgentHookEventPayload } from './server-types'

export function clearDisconnectedAgentState(
  state: HookListenerState,
  paneKey: string,
  agentType: EnrichedAgentHookEventPayload['payload']['agentType']
): void {
  if (isCodexCompatibleAgentType(agentType)) {
    clearCodexCompatibleState(state, paneKey, agentType)
    return
  }
  if (agentType !== 'claude') {
    return
  }
  state.claudeSubagentRosterByPaneKey.delete(paneKey)
  state.claudeLeadStateByPaneKey.delete(paneKey)
  state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  state.claudeLaunchedBackgroundTasksByPaneKey.delete(paneKey)
  state.claudeSessionOwnerByPaneKey.delete(paneKey)
}
