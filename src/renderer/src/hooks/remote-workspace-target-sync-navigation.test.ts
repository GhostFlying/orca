import { describe, expect, it, vi } from 'vitest'
import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspaceTerminalTab
} from '../../../shared/remote-workspace-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { DirectSshPreparationInput } from './direct-ssh-reconnect-coordinator'
import {
  appState,
  createHarness,
  deferred,
  flush,
  owner,
  snapshot,
  token
} from './__tests__/remote-workspace-target-sync-test-harness'

const TARGET_WORKTREE_ID = 'repo-a::/remote/work'

function remoteTab(id: string): RemoteWorkspaceTerminalTab {
  return {
    id,
    ptyId: null,
    worktreePath: '/remote/work',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: id === 'tab-1' ? 0 : 1,
    createdAt: id === 'tab-1' ? 1 : 2
  }
}

function incomingSnapshot(revision: number): RemoteWorkspaceObservedSnapshot {
  const incoming = snapshot(revision, {
    '/remote/work': [remoteTab('tab-1'), remoteTab('tab-2')]
  })
  incoming.session.activeWorktreePath = '/remote/work'
  incoming.session.activeTabId = 'tab-1'
  incoming.session.activeTabIdByWorktreePath = { '/remote/work': 'tab-1' }
  return incoming
}

describe('remote workspace target sync navigation fence', () => {
  it('preserves a tab selected while reconnect snapshot fetch is pending', async () => {
    const state = appState({
      activeRepoId: 'repo-a',
      activeWorkspaceKey: worktreeWorkspaceKey(TARGET_WORKTREE_ID),
      activeWorktreeId: TARGET_WORKTREE_ID,
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { [TARGET_WORKTREE_ID]: 'tab-1' },
      tabsByWorktree: {
        [TARGET_WORKTREE_ID]: [
          { id: 'tab-1', worktreeId: TARGET_WORKTREE_ID, ptyId: null },
          { id: 'tab-2', worktreeId: TARGET_WORKTREE_ID, ptyId: null }
        ]
      }
    })
    const pendingGet = deferred<RemoteWorkspaceObservedSnapshot | null>()
    const harness = createHarness(state, () => pendingGet.promise)

    const pending = harness.sync.syncAfterConnect(token())
    await flush()
    state.activeTabId = 'tab-2'
    state.activeTabIdByWorktree = { [TARGET_WORKTREE_ID]: 'tab-2' }
    pendingGet.resolve(incomingSnapshot(16))
    await pending

    const hydrated = vi.mocked(state.hydrateWorkspaceSession).mock.calls[0]?.[0]
    expect(hydrated?.activeTabId).toBe('tab-2')
    expect(hydrated?.activeTabIdByWorktree?.[TARGET_WORKTREE_ID]).toBe('tab-2')
  })

  it('preserves a tab selected while an unsolicited snapshot is preparing', async () => {
    const groupId = 'group-a'
    const terminalTab = (id: string) => ({
      id,
      title: id,
      type: 'terminal',
      worktreeId: TARGET_WORKTREE_ID,
      ptyId: null
    })
    const state = appState({
      activeRepoId: 'repo-a',
      activeWorkspaceKey: worktreeWorkspaceKey(TARGET_WORKTREE_ID),
      activeWorktreeId: TARGET_WORKTREE_ID,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [TARGET_WORKTREE_ID]: [terminalTab('tab-1'), terminalTab('tab-2')]
      },
      activeTabIdByWorktree: { [TARGET_WORKTREE_ID]: 'tab-1' },
      unifiedTabsByWorktree: {
        [TARGET_WORKTREE_ID]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId,
            worktreeId: TARGET_WORKTREE_ID,
            contentType: 'terminal',
            label: 'tab-1',
            sortOrder: 0,
            createdAt: 1,
            isPreview: false,
            isPinned: false
          },
          {
            id: 'tab-2',
            entityId: 'tab-2',
            groupId,
            worktreeId: TARGET_WORKTREE_ID,
            contentType: 'terminal',
            label: 'tab-2',
            sortOrder: 1,
            createdAt: 2,
            isPreview: false,
            isPinned: false
          }
        ]
      },
      groupsByWorktree: {
        [TARGET_WORKTREE_ID]: [
          {
            id: groupId,
            worktreeId: TARGET_WORKTREE_ID,
            activeTabId: 'tab-1',
            tabOrder: ['tab-1', 'tab-2']
          }
        ]
      },
      activeGroupIdByWorktree: { [TARGET_WORKTREE_ID]: groupId }
    })
    const harness = createHarness(state, async () => null)
    const pendingPreparation = deferred<DirectSshPreparationInput>()
    harness.capturePreparationInput.mockImplementationOnce(() => pendingPreparation.promise)

    const pending = harness.sync.applyUnsolicitedSnapshot('target-a', incomingSnapshot(14))
    await flush()
    state.activeTabId = 'tab-2'
    state.activeTabIdByWorktree = { [TARGET_WORKTREE_ID]: 'tab-2' }
    state.groupsByWorktree = {
      [TARGET_WORKTREE_ID]: [
        {
          id: groupId,
          worktreeId: TARGET_WORKTREE_ID,
          activeTabId: 'tab-2',
          tabOrder: ['tab-1', 'tab-2']
        }
      ]
    }
    pendingPreparation.resolve({
      ...owner,
      catalogRevision: 1,
      repoRefs: [{ repoId: 'repo-a', executionHostId: 'ssh:target-a' }],
      authorityRequirement: 'required',
      reason: 'workspace-snapshot',
      snapshotRevision: 14
    })
    await pending

    const hydrated = vi.mocked(state.hydrateWorkspaceSession).mock.calls[0]?.[0]
    expect(hydrated?.activeTabId).toBe('tab-2')
    expect(hydrated?.activeTabIdByWorktree?.[TARGET_WORKTREE_ID]).toBe('tab-2')
    expect(
      vi.mocked(state.hydrateTabsSession).mock.calls[0]?.[0].tabGroups?.[TARGET_WORKTREE_ID]?.[0]
    ).toMatchObject({ activeTabId: 'tab-2' })
  })

  it('accepts remote tab selection when no navigation occurs during preparation', async () => {
    const state = appState({
      activeRepoId: 'repo-a',
      activeWorkspaceKey: worktreeWorkspaceKey(TARGET_WORKTREE_ID),
      activeWorktreeId: TARGET_WORKTREE_ID,
      activeTabId: 'tab-2',
      activeTabIdByWorktree: { [TARGET_WORKTREE_ID]: 'tab-2' },
      tabsByWorktree: {
        [TARGET_WORKTREE_ID]: [
          { id: 'tab-1', title: 'tab-1', type: 'terminal', worktreeId: TARGET_WORKTREE_ID },
          { id: 'tab-2', title: 'tab-2', type: 'terminal', worktreeId: TARGET_WORKTREE_ID }
        ]
      }
    })
    const harness = createHarness(state, async () => null)

    await harness.sync.applyUnsolicitedSnapshot('target-a', incomingSnapshot(15))

    const hydrated = vi.mocked(state.hydrateWorkspaceSession).mock.calls[0]?.[0]
    expect(hydrated?.activeTabId).toBe('tab-1')
    expect(hydrated?.activeTabIdByWorktree?.[TARGET_WORKTREE_ID]).toBe('tab-1')
  })
})
