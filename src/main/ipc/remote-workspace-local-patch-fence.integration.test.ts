import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot,
  RemoteWorkspaceTerminalTab
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'

const { getActiveMultiplexerMock } = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn()
}))

vi.mock('./ssh', () => ({ getActiveMultiplexer: getActiveMultiplexerMock }))

import {
  clearPendingLocalRemoteWorkspacePatches,
  getPendingLocalRemoteWorkspacePatchCount
} from './remote-workspace-local-patch-fence'
import { patchRemoteWorkspaceSession } from './remote-workspace-relay-sync'
import {
  clearRemoteWorkspaceSnapshotCache,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import {
  _resetRemoteWorkspaceStaleResyncForTests,
  resyncStaleRemoteWorkspace
} from './remote-workspace-stale-resync'

const target: SshTarget = {
  id: 'target-1',
  label: 'Target 1',
  host: 'one.example.com',
  port: 22,
  username: 'alice'
}

function remoteTab(id: string, worktreePath: string): RemoteWorkspaceTerminalTab {
  return {
    id,
    ptyId: null,
    worktreePath,
    title: 'Shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(activeWorktreePath: string, activeTabId: string): RemoteWorkspaceSession {
  return {
    activeWorktreePath,
    activeTabId,
    tabsByWorktreePath: {
      [activeWorktreePath]: [remoteTab(activeTabId, activeWorktreePath)]
    },
    terminalLayoutsByTabId: {}
  }
}

function snapshot(value: RemoteWorkspaceSession, revision: number): RemoteWorkspaceSnapshot {
  return {
    namespace: getRemoteWorkspaceNamespace(target),
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session: value
  }
}

describe('remote workspace local patch fence', () => {
  beforeEach(() => {
    clearPendingLocalRemoteWorkspacePatches()
    clearRemoteWorkspaceSnapshotCache()
    _resetRemoteWorkspaceStaleResyncForTests()
    getActiveMultiplexerMock.mockReset()
  })

  function observeBaseline(): void {
    rememberRemoteWorkspaceSnapshot(target.id, snapshot(session('/previous', 'previous-tab'), 7))
  }

  it('absorbs an oversized local patch marker before the patch response updates the cache', async () => {
    const delivered: RemoteWorkspaceSnapshot[] = []
    const localSession = session('/remote/workspace', 'local-tab')
    const patchedSnapshot = snapshot(localSession, 8)
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.get') {
        return patchedSnapshot
      }
      if (method !== 'workspace.patch') {
        throw new Error(`Unexpected method ${method}`)
      }
      await resyncStaleRemoteWorkspace(target, (value) => delivered.push(value))
      return { ok: true, snapshot: patchedSnapshot }
    })
    getActiveMultiplexerMock.mockReturnValue({ request })
    observeBaseline()

    await expect(patchRemoteWorkspaceSession(target, localSession)).resolves.toMatchObject({
      ok: true,
      snapshot: { revision: 8 }
    })
    expect(request.mock.calls.filter(([method]) => method === 'workspace.get')).toHaveLength(1)
    expect(getPendingLocalRemoteWorkspacePatchCount()).toBe(0)
    expect(delivered).toEqual([])
  })

  it('publishes a stale resync that differs from the pending local patch', async () => {
    const delivered: RemoteWorkspaceSnapshot[] = []
    const localSession = session('/remote/workspace', 'local-tab')
    const externalSnapshot = snapshot(session('/other-device', 'external-tab'), 8)
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.get') {
        return externalSnapshot
      }
      if (method !== 'workspace.patch') {
        throw new Error(`Unexpected method ${method}`)
      }
      await resyncStaleRemoteWorkspace(target, (value) => delivered.push(value))
      return { ok: false, reason: 'stale-revision', snapshot: externalSnapshot }
    })
    getActiveMultiplexerMock.mockReturnValue({ request })
    observeBaseline()

    await expect(patchRemoteWorkspaceSession(target, localSession)).resolves.toMatchObject({
      ok: false,
      reason: 'stale-revision'
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ session: { activeTabId: 'external-tab' } })
    expect(getPendingLocalRemoteWorkspacePatchCount()).toBe(0)
  })

  it('retires the local patch fence after a relay request failure', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.patch') {
        throw new Error('relay disconnected')
      }
      throw new Error(`Unexpected method ${method}`)
    })
    getActiveMultiplexerMock.mockReturnValue({ request })
    observeBaseline()

    await expect(
      patchRemoteWorkspaceSession(target, session('/remote/workspace', 'local-tab'))
    ).resolves.toMatchObject({ ok: false, reason: 'unavailable' })
    expect(getPendingLocalRemoteWorkspacePatchCount()).toBe(0)
  })
})
