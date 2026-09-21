import { describe, expect, it } from 'vitest'
import { appState } from './__tests__/remote-workspace-target-sync-test-harness'
import {
  captureRemoteWorkspaceNavigation,
  preserveRemoteWorkspaceNavigationIfChanged
} from './remote-workspace-navigation-fence'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'

const WORKTREE = 'repo-a::/remote/work'

describe('remote workspace navigation fence', () => {
  it('does not preserve a newly selected tab after the merged topology deletes it', () => {
    const state = appState({
      activeRepoId: 'repo-a',
      activeWorktreeId: WORKTREE,
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { [WORKTREE]: 'tab-1' },
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'tab-1',
            ptyId: null,
            title: 'One',
            worktreeId: WORKTREE,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'tab-2',
            ptyId: null,
            title: 'Two',
            worktreeId: WORKTREE,
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      }
    })
    const initial = captureRemoteWorkspaceNavigation(state, new Set([WORKTREE]))
    state.activeTabId = 'tab-2'
    state.activeTabIdByWorktree = { [WORKTREE]: 'tab-2' }
    const merged = buildWorkspaceSessionPayload({
      ...state,
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { [WORKTREE]: 'tab-1' },
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'tab-1',
            ptyId: null,
            title: 'One',
            worktreeId: WORKTREE,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })

    const result = preserveRemoteWorkspaceNavigationIfChanged(
      merged,
      state,
      initial,
      new Set([WORKTREE])
    )

    expect(result.activeTabId).toBe('tab-1')
    expect(result.activeTabIdByWorktree?.[WORKTREE]).toBe('tab-1')
  })
})
