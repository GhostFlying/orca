import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { FOLDER_WORKSPACE_HANDLERS } from './folder-workspace'

const context = (
  call: ReturnType<typeof vi.fn<RuntimeClient['call']>>,
  values: Record<string, string>
) => {
  const client = new RuntimeClient()
  vi.spyOn(client, 'call').mockImplementation(call)
  return {
    client,
    cwd: path.resolve('workspace'),
    json: true,
    flags: new Map(Object.entries(values))
  }
}

afterEach(() => vi.restoreAllMocks())

describe('folder workspace CLI', () => {
  it('requires an explicit directory and group before creation', async () => {
    const call = vi.fn<RuntimeClient['call']>()
    await expect(
      FOLDER_WORKSPACE_HANDLERS['folder-workspace create']!(context(call, { name: 'Task' }))
    ).rejects.toThrow('--path')
    expect(call).not.toHaveBeenCalled()
  })
  it('passes a resolved path and stable group ID without changing runtime wire methods', async () => {
    const call = vi
      .fn<RuntimeClient['call']>()
      .mockResolvedValueOnce({
        id: 'group-read',
        ok: true,
        result: { groups: [{ id: 'group-1', connectionId: null }] },
        _meta: { runtimeId: 'runtime' }
      })
      .mockResolvedValue({
        id: 'rpc',
        ok: true,
        result: { folderWorkspace: { id: 'folder-1' } },
        _meta: { runtimeId: 'runtime' }
      })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await FOLDER_WORKSPACE_HANDLERS['folder-workspace create']!(
      context(call, { path: 'scratch', group: 'group-1', name: 'Task · 12345678' })
    )
    expect(call).toHaveBeenCalledWith('folderWorkspace.create', {
      projectGroupId: 'group-1',
      name: 'Task · 12345678',
      folderPath: path.resolve('workspace', 'scratch'),
      connectionId: undefined
    })
  })
  it('fails a missing ID instead of resolving by name', async () => {
    const call = vi.fn<RuntimeClient['call']>().mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: { folderWorkspaces: [{ id: 'other', name: 'Task' }] },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      FOLDER_WORKSPACE_HANDLERS['folder-workspace show']!(context(call, { workspace: 'missing' }))
    ).rejects.toThrow('not found')
  })
  it('selects the stable ID when names collide and preserves the success envelope', async () => {
    const wanted = { id: 'folder-wanted', name: 'Same title', folderPath: '/wanted' }
    const call = vi.fn<RuntimeClient['call']>().mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { folderWorkspaces: [{ id: 'folder-other', name: 'Same title' }, wanted] },
      _meta: { runtimeId: 'runtime' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await FOLDER_WORKSPACE_HANDLERS['folder-workspace show']!(
      context(call, { workspace: wanted.id })
    )
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      id: 'rpc-1',
      ok: true,
      result: { folderWorkspace: wanted }
    })
  })
  it('rejects relative server paths before remote mutation', async () => {
    const call = vi.fn<RuntimeClient['call']>()
    const ctx = context(call, { path: 'scratch', group: 'group-1', name: 'Task' })
    vi.spyOn(ctx.client, 'isRemote', 'get').mockReturnValue(true)
    await expect(FOLDER_WORKSPACE_HANDLERS['folder-workspace create']!(ctx)).rejects.toThrow(
      'absolute path on the remote server'
    )
    expect(call).not.toHaveBeenCalled()
  })
})

describe('folder create filesystem routing and update outcomes', () => {
  it.each([
    ['folder-workspace create', 'folderWorkspace.create', 'folderPath'],
    ['project-group create', 'projectGroup.create', 'parentPath']
  ] as const)(
    'keeps SSH absolute paths and rejects relative paths for %s',
    async (command, method, property) => {
      const call = vi
        .fn<RuntimeClient['call']>()
        .mockResolvedValue({ id: 'rpc', ok: true, result: {}, _meta: { runtimeId: 'runtime' } })
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      for (const remotePath of ['/srv/report', 'C:\\reports\\folder']) {
        await FOLDER_WORKSPACE_HANDLERS[command]!(
          context(call, { path: remotePath, group: 'group', name: 'Task', connection: 'ssh-host' })
        )
        expect(call).toHaveBeenLastCalledWith(
          method,
          expect.objectContaining({ [property]: remotePath, connectionId: 'ssh-host' })
        )
      }
      call.mockClear()
      await expect(
        FOLDER_WORKSPACE_HANDLERS[command]!(
          context(call, { path: 'relative', group: 'group', name: 'Task', connection: 'ssh-host' })
        )
      ).rejects.toThrow('absolute path on the remote server')
      expect(call).not.toHaveBeenCalled()
    }
  )
  it('fails a null update rather than printing a successful rename', async () => {
    const call = vi.fn<RuntimeClient['call']>().mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: { folderWorkspace: null },
      _meta: { runtimeId: 'runtime' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(
      FOLDER_WORKSPACE_HANDLERS['folder-workspace update']!(
        context(call, { workspace: 'missing', name: 'new title' })
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(log).not.toHaveBeenCalled()
  })
  it('updates metadata by stable identity, including clearing a comment', async () => {
    const record = { id: 'folder-1', name: 'new title', folderPath: '/srv/report', comment: '' }
    const call = vi.fn<RuntimeClient['call']>().mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: { folderWorkspace: record },
      _meta: { runtimeId: 'runtime' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await FOLDER_WORKSPACE_HANDLERS['folder-workspace update']!(
      context(call, { workspace: record.id, name: record.name, comment: '' })
    )
    expect(call).toHaveBeenCalledExactlyOnceWith('folderWorkspace.update', {
      folderWorkspaceId: record.id,
      updates: { name: record.name, comment: '' }
    })
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ result: { folderWorkspace: record } })
  })
})

describe('folder workspace inherited filesystem', () => {
  it.each(['/srv/report', 'D:\\reports\\folder'])(
    'keeps inherited SSH path %s',
    async (remotePath) => {
      const call = vi
        .fn<RuntimeClient['call']>()
        .mockResolvedValueOnce({
          id: 'group-read',
          ok: true,
          result: { groups: [{ id: 'group', connectionId: 'ssh-host' }] },
          _meta: { runtimeId: 'runtime' }
        })
        .mockResolvedValue({
          id: 'create',
          ok: true,
          result: { folderWorkspace: { id: 'folder' } },
          _meta: { runtimeId: 'runtime' }
        })
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      await FOLDER_WORKSPACE_HANDLERS['folder-workspace create']!(
        context(call, { path: remotePath, group: 'group', name: 'Task' })
      )
      expect(call).toHaveBeenNthCalledWith(1, 'projectGroup.list')
      expect(call).toHaveBeenNthCalledWith(2, 'folderWorkspace.create', {
        projectGroupId: 'group',
        name: 'Task',
        folderPath: remotePath,
        connectionId: undefined
      })
    }
  )
  it('rejects an inherited SSH relative path before creating a workspace', async () => {
    const call = vi.fn<RuntimeClient['call']>().mockResolvedValue({
      id: 'group-read',
      ok: true,
      result: { groups: [{ id: 'group', connectionId: 'ssh-host' }] },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      FOLDER_WORKSPACE_HANDLERS['folder-workspace create']!(
        context(call, { path: 'relative', group: 'group', name: 'Task' })
      )
    ).rejects.toThrow('absolute path on the remote server')
    expect(call).toHaveBeenCalledExactlyOnceWith('projectGroup.list')
  })
  it('does not create a workspace when its selected group is missing', async () => {
    const call = vi.fn<RuntimeClient['call']>().mockResolvedValue({
      id: 'group-read',
      ok: true,
      result: { groups: [] },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      FOLDER_WORKSPACE_HANDLERS['folder-workspace create']!(
        context(call, { path: 'relative', group: 'missing', name: 'Task' })
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(call).toHaveBeenCalledExactlyOnceWith('projectGroup.list')
  })
})
