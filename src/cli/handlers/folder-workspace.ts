import type { CommandHandler } from '../dispatch'
import {
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from '../flags'
import { printResult } from '../format'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime-client'

type FolderRecord = { id: string; name: string; folderPath?: string | null }
type FolderList = { folderWorkspaces: FolderRecord[] }

const formatRecords = (value: unknown): string => JSON.stringify(value, null, 2)

export const FOLDER_WORKSPACE_HANDLERS: Record<string, CommandHandler> = {
  'folder-workspace list': async ({ client, json }) => {
    printResult(await client.call<FolderList>('folderWorkspace.list'), json, formatRecords)
  },
  'folder-workspace show': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'workspace')
    const result = await client.call<FolderList>('folderWorkspace.list')
    const folderWorkspace = result.result.folderWorkspaces.find((folder) => folder.id === id)
    if (!folderWorkspace) {
      throw new RuntimeClientError('not_found', `Folder workspace not found: ${id}`)
    }
    printResult({ ...result, result: { folderWorkspace } }, json, formatRecords)
  },
  'folder-workspace create': async ({ flags, client, cwd, json }) => {
    const inputPath = getRequiredStringFlag(flags, 'path')
    const projectGroupId = getRequiredStringFlag(flags, 'group')
    const connectionId = getOptionalStringFlag(flags, 'connection')
    let remoteFilesystem = client.isRemote || connectionId !== undefined
    if (!remoteFilesystem) {
      const groups = await client.call<{ groups: { id: string; connectionId?: string | null }[] }>(
        'projectGroup.list'
      )
      const group = groups.result.groups.find((entry) => entry.id === projectGroupId)
      if (!group) {
        throw new RuntimeClientError('not_found', `Project group not found: ${projectGroupId}`)
      }
      remoteFilesystem = !!group.connectionId
    }
    const folderPath = resolveRepoPathArgument(
      inputPath,
      cwd,
      remoteFilesystem,
      'Remote folder workspace create'
    )
    printResult(
      await client.call('folderWorkspace.create', {
        projectGroupId,
        name: getRequiredStringFlag(flags, 'name'),
        folderPath,
        connectionId
      }),
      json,
      formatRecords
    )
  },
  'folder-workspace update': async ({ flags, client, json }) => {
    const folderWorkspaceId = getRequiredStringFlag(flags, 'workspace')
    const name = getOptionalStringFlag(flags, 'name')
    const comment = flags.has('comment')
      ? getRequiredStringFlagAllowingEmpty(flags, 'comment')
      : undefined
    if (name === undefined && comment === undefined) {
      throw new RuntimeClientError('invalid_argument', 'Provide --name or --comment')
    }
    const result = await client.call<{ folderWorkspace: FolderRecord | null }>(
      'folderWorkspace.update',
      {
        folderWorkspaceId,
        updates: { name, comment }
      }
    )
    if (!result.result.folderWorkspace) {
      throw new RuntimeClientError('not_found', `Folder workspace not found: ${folderWorkspaceId}`)
    }
    printResult(result, json, formatRecords)
  },
  'folder-workspace rm': async ({ flags, client, json }) => {
    printResult(
      await client.call('folderWorkspace.delete', {
        folderWorkspaceId: getRequiredStringFlag(flags, 'workspace')
      }),
      json,
      formatRecords
    )
  },
  'project-group rm': async ({ flags, client, json }) => {
    printResult(
      await client.call('projectGroup.delete', { groupId: getRequiredStringFlag(flags, 'group') }),
      json,
      formatRecords
    )
  },
  'project-group list': async ({ client, json }) => {
    printResult(await client.call('projectGroup.list'), json, formatRecords)
  },
  'project-group create': async ({ flags, client, cwd, json }) => {
    const path = getOptionalStringFlag(flags, 'path')
    const connectionId = getOptionalStringFlag(flags, 'connection')
    printResult(
      await client.call('projectGroup.create', {
        name: getRequiredStringFlag(flags, 'name'),
        parentPath:
          path === undefined
            ? undefined
            : resolveRepoPathArgument(
                path,
                cwd,
                client.isRemote || connectionId !== undefined,
                'Remote project group create'
              ),
        connectionId
      }),
      json,
      formatRecords
    )
  }
}
