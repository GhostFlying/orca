import { describe, expect, it } from 'vitest'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../../folder-workspace-composer-submit-fixtures'
import {
  planSidebarRows,
  type SidebarRowPlanInputs
} from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import {
  isTendWorkspaceComment,
  TEND_WORKSPACE_GROUP_KEY,
  TEND_DIRECTORY_GROUP_KEY
} from '../../../../../../shared/tend-workspace-comment'
import { getWorktreeRevealCollapsedGroupKeys } from '../navigation/worktree-reveal-group-keys'
import { getFolderWorkspaceRevealGroupKeys } from '../navigation/folder-reveal'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import {
  normalizePairedServerRow,
  PairedServerRowsSnapshotSchema
} from '../../../../../../shared/sidebar-list/paired-server-rows'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { readFeedPairedServerRow } from '../../../../../../shared/sidebar-list/sidebar-feed-worktrees'

const otherRepo = { ...repo, id: 'other-repo', displayName: 'Other repository' }
const task = {
  ...worktree,
  id: 'task',
  instanceId: 'task-instance',
  comment: 'tend workspace ws_task',
  isPinned: true,
  hostId: 'local' as const
}
const otherTask = {
  ...task,
  id: 'other-task',
  repoId: otherRepo.id,
  comment: 'tend task task_old\nworkspace ws_old\nkind git\nrole implement'
}
const manual = { ...worktree, id: 'manual', hostId: 'local' as const }
const group = makeProjectGroup()
const directory = makeFolderWorkspace({ comment: 'tend workspace ws_directory' })

function inputs(overrides: Partial<SidebarRowPlanInputs> = {}): SidebarRowPlanInputs {
  const rows = [task, otherTask, manual]
  return {
    groupBy: 'repo',
    worktrees: rows,
    repoMap: new Map([
      [repo.id, repo],
      [otherRepo.id, otherRepo]
    ]),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(rows.map((row) => [row.id, row])),
    nestLineage: true,
    projectGroups: [group],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [directory],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: [],
    ...overrides
  }
}

describe('tend workspace grouping', () => {
  it.each(['none', 'repo', 'workspace-status', 'pr-status'] as const)(
    'collects every tend workspace by repository under %s grouping',
    (groupBy) => {
      const plan = planSidebarRows(inputs({ groupBy }))
      const rows = plan.render(new Set())
      expect(
        rows
          .filter((row) => row.type === 'item')
          .map((row) => row.worktree.id)
          .sort()
      ).toEqual(['manual', 'other-task', 'task'])
      const taskRow = rows.find((row) => row.type === 'item' && row.worktree.id === task.id)
      expect(taskRow).toMatchObject({
        sectionKey: `${TEND_WORKSPACE_GROUP_KEY}:repo:${repo.id}`,
        repo,
        groupDepth: 1
      })
      expect(
        rows.find((row) => row.type === 'item' && row.worktree.id === otherTask.id)
      ).toMatchObject({ sectionKey: `${TEND_WORKSPACE_GROUP_KEY}:repo:${otherRepo.id}` })
      expect(
        rows.find((row) => row.type === 'header' && row.key === TEND_WORKSPACE_GROUP_KEY)
      ).toMatchObject({ count: 3, presentationOnly: true })
      expect(rows.find((row) => row.type === 'folder-workspace')).toMatchObject({
        folderWorkspace: directory,
        groupDepth: 1
      })
      const collapsed = plan.render(new Set([TEND_WORKSPACE_GROUP_KEY]))
      expect(collapsed.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
        'manual'
      ])
      expect(collapsed.some((row) => row.type === 'folder-workspace')).toBe(false)
    }
  )

  it('reveals both repository and directory paths without opening the ordinary repository section', () => {
    const args = inputs()
    const plan = planSidebarRows(args)
    const taskSection = `${TEND_WORKSPACE_GROUP_KEY}:repo:${repo.id}`
    const collapsed = new Set([TEND_WORKSPACE_GROUP_KEY, taskSection, `repo:${repo.id}`])
    expect(
      getWorktreeRevealCollapsedGroupKeys({
        occurrencePlan: plan.occurrencePlan,
        worktree: task,
        worktrees: args.worktrees,
        worktreeLineageById: {},
        repoMap: args.repoMap,
        defaultHostId: 'local',
        hostScopedGroups: false,
        collapsedGroups: collapsed,
        groupBy: 'repo',
        pinnedDisplayPolicy: 'single-location',
        prCache: null,
        workspaceStatuses: args.workspaceStatuses,
        projectGroups: args.projectGroups
      })
    ).toEqual([taskSection, TEND_WORKSPACE_GROUP_KEY])
    expect(
      getFolderWorkspaceRevealGroupKeys(`folder:${directory.id}`, [directory], [group])
    ).toEqual([TEND_WORKSPACE_GROUP_KEY, TEND_DIRECTORY_GROUP_KEY])
    expect(
      plan
        .render(new Set([taskSection]))
        .filter((row) => row.type === 'item')
        .map((row) => row.worktree.id)
        .sort()
    ).toEqual(['manual', 'other-task'])
  })

  it('keeps ordinary children out of tend and breaks cross-repository display nesting', () => {
    const plan = planSidebarRows(
      inputs({
        lineageById: {
          [manual.id]: {
            worktreeId: manual.id,
            worktreeInstanceId: 'manual-instance',
            parentWorktreeId: task.id,
            parentWorktreeInstanceId: task.instanceId,
            origin: 'cli',
            capture: { source: 'terminal-context', confidence: 'inferred' },
            createdAt: 1
          },
          [otherTask.id]: {
            worktreeId: otherTask.id,
            worktreeInstanceId: otherTask.instanceId,
            parentWorktreeId: task.id,
            parentWorktreeInstanceId: task.instanceId,
            origin: 'cli',
            capture: { source: 'terminal-context', confidence: 'inferred' },
            createdAt: 1
          }
        },
        worktrees: [task, otherTask, { ...manual, instanceId: 'manual-instance' }]
      })
    )
    const rows = plan.render(new Set([TEND_WORKSPACE_GROUP_KEY]))
    expect(rows.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
      'manual'
    ])
    expect(
      plan.render(new Set()).find((row) => row.type === 'item' && row.worktree.id === otherTask.id)
    ).toMatchObject({ depth: 0 })
  })

  it.each([false, true])(
    'preserves host ownership and counts with tend collapsed=%s',
    (collapsed) => {
      const remoteTask = { ...task, hostId: 'ssh:worker' as const }
      const args = inputs({ worktrees: [task, remoteTask], folderWorkspaces: [directory] })
      const rows = planSidebarRows(args).render(
        new Set(collapsed ? [TEND_WORKSPACE_GROUP_KEY] : [])
      )
      const sections = addHostSectionRows({
        rows,
        hostOptions: [
          { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
          { id: 'ssh:worker', kind: 'ssh', label: 'Worker', detail: '', health: 'available' }
        ],
        workspaceHostScope: 'all',
        defaultHostId: 'local',
        localHostLabel: 'Local'
      })
      expect(
        sections.filter((row) => row.type === 'host-header').map((row) => [row.hostId, row.count])
      ).toEqual([
        ['local', 2],
        ['ssh:worker', 1]
      ])
      expect(
        sections
          .filter((row) => row.type === 'header' && row.key === TEND_WORKSPACE_GROUP_KEY)
          .flatMap((row) => (row.type === 'header' ? [row.count] : []))
      ).toEqual([2, 1])
      if (!collapsed) {
        expect(
          sections.filter(
            (row) =>
              row.type === 'header' && row.key === `${TEND_WORKSPACE_GROUP_KEY}:repo:${repo.id}`
          )
        ).toHaveLength(2)
      }
    }
  )

  it.each(['git', 'folder-workspace'] as const)(
    'keeps the server comment through the paired feed for %s',
    (workspaceKind) => {
      const source = workspaceKind === 'git' ? task : folderWorkspaceToWorktree(directory)
      const normalized = normalizePairedServerRow('runtime:worker', {
        worktreeId: source.id,
        repoId: source.repoId,
        workspaceKind,
        comment: source.comment
      })
      const snapshot = PairedServerRowsSnapshotSchema.parse({
        revision: 1,
        servers: [{ hostId: 'runtime:worker', freshness: 'live', host: null, rows: [normalized] }]
      })
      const row = readFeedPairedServerRow(snapshot.servers[0].rows[0])
      expect(row?.worktree.comment).toBe(source.comment)
      const plan = planSidebarRows(
        inputs({
          worktrees: row && !row.folderWorkspace ? [row.worktree] : [],
          folderWorkspaces: row?.folderWorkspace ? [row.folderWorkspace] : []
        })
      )
      expect(
        plan
          .render(new Set())
          .some((row) => row.type === 'header' && row.key === TEND_WORKSPACE_GROUP_KEY)
      ).toBe(true)
      const older = normalizePairedServerRow('runtime:worker', {
        worktreeId: task.id,
        repoId: repo.id
      })
      expect(older && readFeedPairedServerRow(older)?.worktree.comment).toBe('')
    }
  )

  it('requires an anchored structured marker and returns unmarked workspaces to normal grouping', () => {
    expect(isTendWorkspaceComment('Please inspect tend workspace ws_task')).toBe(false)
    expect(isTendWorkspaceComment('tend task task_old\nworkspace ws_old')).toBe(false)
    const rows = planSidebarRows(
      inputs({ worktrees: [{ ...task, comment: '', isPinned: false }], folderWorkspaces: [] })
    ).render(new Set())
    expect(rows.some((row) => row.type === 'header' && row.key === TEND_WORKSPACE_GROUP_KEY)).toBe(
      false
    )
    expect(rows.find((row) => row.type === 'item')).toMatchObject({ sectionKey: `repo:${repo.id}` })
  })
})
