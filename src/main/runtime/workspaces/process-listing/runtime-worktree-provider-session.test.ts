import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import type { RuntimeWorktreePsSummary } from '../../../../shared/runtime-types'
import { describe, expect, it } from 'vitest'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

const paneKey = 'worktree:tab:0'
const now = 1_800_000_000_000
const hookRow: AgentStatusIpcPayload = {
  paneKey,
  tabId: 'tab',
  terminalHandle: 'term_row',
  worktreeId: 'worktree',
  connectionId: null,
  state: 'working',
  prompt: 'implement',
  agentType: 'codex',
  stateStartedAt: now,
  receivedAt: now
}
const base = {
  hookSnapshots: [hookRow],
  mirroredWorktreeIdByTabId: new Map<string, string>(),
  connectedPtyEvidence: {
    tabIds: new Set<string>(),
    paneKeys: new Set<string>(),
    ptyIdByTerminalHandle: new Map<string, string>()
  }
}
const connected = {
  ...base,
  connectedPtyEvidence: {
    tabIds: new Set(['tab']),
    paneKeys: new Set([paneKey]),
    ptyIdByTerminalHandle: new Map([['term_row', 'pty']])
  }
}

describe('provider session references in runtime rows', () => {
  const providerSession = {
    key: 'session_id' as const,
    id: 'root-provider-session',
    transcriptPath: '/provider/sessions/reported-rollout.jsonl'
  }

  it('carries hook metadata through the source and row without reconstructing it', () => {
    for (const metadata of [
      providerSession,
      { key: 'session_id' as const, id: 'id-only' },
      undefined
    ]) {
      const rowSources = collectRuntimeWorktreeAgentSources({
        ...connected,
        hookSnapshots: [{ ...hookRow, providerSession: metadata }]
      })
      expect(rowSources.get(paneKey)?.providerSession).toEqual(metadata)
      const summary: RuntimeWorktreePsSummary = {
        workspaceKind: 'folder-workspace',
        worktreeId: 'worktree',
        repoId: '',
        repo: '',
        path: '/workspace',
        branch: '',
        isArchived: false,
        isMainWorktree: false,
        hasHostSidebarActivity: false,
        parentWorktreeId: null,
        childWorktreeIds: [],
        displayName: 'workspace',
        workspaceStatus: 'active',
        sortOrder: 0,
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        linkedGitLabMR: null,
        linkedGitLabIssue: null,
        comment: '',
        isPinned: false,
        isActive: false,
        unread: false,
        liveTerminalCount: 1,
        hasAttachedPty: true,
        lastOutputAt: null,
        preview: '',
        status: 'inactive',
        agents: []
      }
      attachRuntimeWorktreeAgentRows({
        summaries: new Map([['worktree', summary]]),
        rowSources,
        terminalTitleEvidenceByRow: new Map(),
        orchestrationByPaneKey: null,
        getSummary: (id) => (id === 'worktree' ? summary : null)
      })
      expect(summary.agents).toHaveLength(1)
      expect(summary.agents[0].providerSession).toEqual(metadata)
      if (metadata === undefined) {
        expect(summary.agents[0]).not.toHaveProperty('providerSession')
      }
    }
  })

  it('does not admit disconnected, unconfirmed or provider-only rows for their metadata', () => {
    expect(
      collectRuntimeWorktreeAgentSources({
        ...base,
        hookSnapshots: [{ ...hookRow, providerSession }]
      }).size
    ).toBe(0)
    for (const excluded of [
      { restoredUnconfirmed: true as const },
      { providerSessionOnly: true }
    ]) {
      expect(
        collectRuntimeWorktreeAgentSources({
          ...connected,
          hookSnapshots: [{ ...hookRow, providerSession, ...excluded }]
        }).size
      ).toBe(0)
    }
    const remote = collectRuntimeWorktreeAgentSources({
      ...base,
      hookSnapshots: [{ ...hookRow, connectionId: 'remote', providerSession }]
    })
    expect(remote.get(paneKey)?.providerSession).toEqual(providerSession)
  })
})
