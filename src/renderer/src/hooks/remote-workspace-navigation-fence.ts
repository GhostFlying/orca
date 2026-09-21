import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { AppState } from '../store/types'

type WorktreeNavigationSelection = {
  activeBrowserTabId: string | null
  activeFileId: string | null
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: string | null
  groupActiveTabIds: readonly (readonly [string, string | null])[]
}

export type RemoteWorkspaceNavigationSnapshot = {
  activeRepoId: string | null
  activeTabId: string | null
  activeWorkspaceExecutionHostId: string | null
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  worktreeIds: readonly string[]
  worktrees: Readonly<Record<string, WorktreeNavigationSelection>>
}

function captureWorktreeSelection(
  state: AppState,
  worktreeId: string
): WorktreeNavigationSelection {
  return {
    activeBrowserTabId: state.activeBrowserTabIdByWorktree[worktreeId] ?? null,
    activeFileId: state.activeFileIdByWorktree[worktreeId] ?? null,
    activeGroupId: state.activeGroupIdByWorktree[worktreeId] ?? null,
    activeTabId: state.activeTabIdByWorktree[worktreeId] ?? null,
    activeTabType: state.activeTabTypeByWorktree[worktreeId] ?? null,
    groupActiveTabIds: (state.groupsByWorktree[worktreeId] ?? [])
      .map((group) => [group.id, group.activeTabId] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  }
}

export function captureRemoteWorkspaceNavigation(
  state: AppState,
  worktreeIds: ReadonlySet<string>
): RemoteWorkspaceNavigationSnapshot {
  const sortedWorktreeIds = [...worktreeIds].sort()
  return {
    activeRepoId: state.activeRepoId,
    activeTabId: state.activeTabId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId ?? null,
    activeWorkspaceKey: state.activeWorkspaceKey ?? null,
    activeWorktreeId: state.activeWorktreeId,
    worktreeIds: sortedWorktreeIds,
    worktrees: Object.fromEntries(
      sortedWorktreeIds.map((worktreeId) => [
        worktreeId,
        captureWorktreeSelection(state, worktreeId)
      ])
    )
  }
}

function worktreeSelectionsEqual(
  left: WorktreeNavigationSelection | undefined,
  right: WorktreeNavigationSelection
): boolean {
  if (!left) {
    return (
      right.activeBrowserTabId === null &&
      right.activeFileId === null &&
      right.activeGroupId === null &&
      right.activeTabId === null &&
      right.activeTabType === null &&
      right.groupActiveTabIds.length === 0
    )
  }
  return (
    left.activeBrowserTabId === right.activeBrowserTabId &&
    left.activeFileId === right.activeFileId &&
    left.activeGroupId === right.activeGroupId &&
    left.activeTabId === right.activeTabId &&
    left.activeTabType === right.activeTabType &&
    left.groupActiveTabIds.length === right.groupActiveTabIds.length &&
    left.groupActiveTabIds.every(
      ([groupId, tabId], index) =>
        right.groupActiveTabIds[index]?.[0] === groupId &&
        right.groupActiveTabIds[index]?.[1] === tabId
    )
  )
}

function terminalTabExists(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string
): boolean {
  return (session.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

export function preserveRemoteWorkspaceNavigationIfChanged(
  merged: WorkspaceSessionState,
  current: AppState,
  initial: RemoteWorkspaceNavigationSnapshot,
  replaceWorktreeIds: ReadonlySet<string>
): WorkspaceSessionState {
  const comparedWorktreeIds = new Set([...initial.worktreeIds, ...replaceWorktreeIds])
  const changedWorktreeIds = new Set(
    [...comparedWorktreeIds].filter(
      (worktreeId) =>
        !worktreeSelectionsEqual(
          initial.worktrees[worktreeId],
          captureWorktreeSelection(current, worktreeId)
        )
    )
  )
  const globalChanged =
    initial.activeRepoId !== current.activeRepoId ||
    initial.activeTabId !== current.activeTabId ||
    initial.activeWorkspaceExecutionHostId !== (current.activeWorkspaceExecutionHostId ?? null) ||
    initial.activeWorkspaceKey !== (current.activeWorkspaceKey ?? null) ||
    initial.activeWorktreeId !== current.activeWorktreeId
  const preserveGlobalSelection =
    globalChanged ||
    (current.activeWorktreeId !== null && changedWorktreeIds.has(current.activeWorktreeId))
  if (!preserveGlobalSelection && changedWorktreeIds.size === 0) {
    return merged
  }

  const activeWorktreeId = current.activeWorktreeId
  const activeWorktreeSurvives =
    activeWorktreeId === null ||
    !replaceWorktreeIds.has(activeWorktreeId) ||
    Object.hasOwn(merged.tabsByWorktree, activeWorktreeId)
  const currentActiveTabSurvives =
    current.activeTabId === null ||
    (activeWorktreeId !== null && terminalTabExists(merged, activeWorktreeId, current.activeTabId))
  const activeTabIdByWorktree = { ...merged.activeTabIdByWorktree }
  for (const worktreeId of changedWorktreeIds) {
    const currentTabId = current.activeTabIdByWorktree[worktreeId] ?? null
    if (currentTabId === null || terminalTabExists(merged, worktreeId, currentTabId)) {
      activeTabIdByWorktree[worktreeId] = currentTabId
    }
  }

  return {
    ...merged,
    ...(preserveGlobalSelection && activeWorktreeSurvives
      ? {
          activeRepoId: current.activeRepoId,
          activeWorkspaceExecutionHostId: current.activeWorkspaceExecutionHostId ?? null,
          activeWorkspaceKey: current.activeWorkspaceKey,
          activeWorktreeId: current.activeWorktreeId,
          ...(currentActiveTabSurvives ? { activeTabId: current.activeTabId } : {})
        }
      : {}),
    activeTabIdByWorktree
  }
}
