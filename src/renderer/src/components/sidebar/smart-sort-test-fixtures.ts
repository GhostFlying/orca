import type {
  AgentStateHistoryEntry,
  AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildAttentionByWorktree } from './smart-attention'
import { buildWorktreeComparator } from './smart-sort'

export const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()
const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

export function paneKey(tabId: string, leaf: '1' | '2' = '1'): string {
  return makePaneKey(tabId, leaf === '1' ? LEAF_ID_1 : LEAF_ID_2)
}

export const repoMap = new Map<string, Repo>([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/tmp/repo-1',
      displayName: 'repo-1',
      badgeColor: '#000000',
      addedAt: 0
    }
  ]
])

export function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? `/tmp/${overrides.id ?? 'wt-1'}`,
    branch: overrides.branch ?? `refs/heads/${overrides.id ?? 'wt-1'}`,
    head: overrides.head ?? 'abc123',
    isBare: overrides.isBare ?? false,
    isMainWorktree: overrides.isMainWorktree ?? false,
    linkedIssue: overrides.linkedIssue ?? null,
    linkedPR: overrides.linkedPR ?? null,
    linkedLinearIssue: null,
    isArchived: overrides.isArchived ?? false,
    comment: overrides.comment ?? '',
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    displayName: overrides.displayName ?? overrides.id ?? 'wt-1',
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0,
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {})
  }
}

export function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? 'pty-1',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    title: overrides.title ?? 'bash',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0
  }
}

export function makeEntry(
  overrides: Partial<AgentStatusEntry> & { paneKey: string }
): AgentStatusEntry {
  return {
    state: overrides.state ?? 'working',
    prompt: overrides.prompt ?? '',
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    stateStartedAt: overrides.stateStartedAt ?? overrides.updatedAt ?? NOW - 30_000,
    agentType: overrides.agentType ?? 'codex',
    paneKey: overrides.paneKey,
    worktreeId: overrides.worktreeId,
    tabId: overrides.tabId,
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? [],
    interrupted: overrides.interrupted,
    mainAgent: overrides.mainAgent
  }
}

export function makeHistory(
  state: AgentStateHistoryEntry['state'],
  startedAt: number,
  interrupted = false
): AgentStateHistoryEntry {
  return { state, prompt: '', startedAt, interrupted: interrupted || undefined }
}

export function ptyMapForTabs(
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      out[tab.id] = ['pty-1']
    }
  }
  return out
}

export function sortSmartAt(
  now: number,
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): Worktree[] {
  const attention = buildAttentionByWorktree(
    worktrees,
    tabsByWorktree,
    agentStatusByPaneKey,
    {},
    ptyMapForTabs(tabsByWorktree),
    now
  )
  return [...worktrees].sort(buildWorktreeComparator('smart', repoMap, now, attention))
}

export function sortSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): Worktree[] {
  return sortSmartAt(NOW, worktrees, tabsByWorktree, agentStatusByPaneKey)
}
