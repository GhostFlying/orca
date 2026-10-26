import { describe, expect, it } from 'vitest'
import {
  makeFolderWorkspace,
  makeWorktree
} from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import { readWindowPairedServerRows } from './paired-server-rows-shadow'

describe('paired server tend markers', () => {
  it('keeps git and folder markers on their owning host projections', () => {
    const rows = readWindowPairedServerRows(
      {
        worktreesByRepo: {
          'repo-1': [
            makeWorktree('same', 'Server task', {
              hostId: 'runtime:box',
              comment: 'tend workspace git-resource'
            }),
            makeWorktree('same', 'Local task', { hostId: 'local' })
          ]
        },
        folderWorkspaces: [
          makeFolderWorkspace({
            executionHostId: 'runtime:box',
            comment: 'tend workspace folder-resource'
          })
        ],
        repos: [],
        worktreeLineageById: {},
        workspaceLineageByChildKey: {},
        crossStoreLineageByStoreKey: {}
      },
      new Set(['runtime:box'])
    )
    expect([...rows].map(([key, row]) => [key, row.comment])).toEqual([
      ['runtime:box|same', 'tend workspace git-resource'],
      ['runtime:box|folder:folder-1', 'tend workspace folder-resource']
    ])
  })
})
