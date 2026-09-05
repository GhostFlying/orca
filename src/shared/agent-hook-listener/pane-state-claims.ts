import type { HookListenerState } from './listener-state'

/** Keep claim-bearing caches aligned with clearPaneCacheState: stored rows and latches can assert state; prompt/tool/transcript caches only render it. */
export function paneHasStateClaims(state: HookListenerState, paneKey: string): boolean {
  const hasCodexCompatibleClaim = (map: Map<string, unknown>): boolean =>
    map.has(paneKey) || Array.from(map.keys()).some((key) => key.startsWith(`${paneKey}\0`))
  return (
    state.lastStatusByPaneKey.has(paneKey) ||
    state.claudeSubagentRosterByPaneKey.has(paneKey) ||
    state.claudeLeadStateByPaneKey.has(paneKey) ||
    state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
    state.claudeActiveSessionCronPaneKeys.has(paneKey) ||
    state.claudeLaunchedBackgroundTasksByPaneKey.has(paneKey) ||
    state.claudeSessionOwnerByPaneKey.has(paneKey) ||
    hasCodexCompatibleClaim(state.codexSubagentRosterByPaneKey) ||
    hasCodexCompatibleClaim(state.codexLeadStateByPaneKey)
  )
}
