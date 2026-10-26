import {
  isTendWorkspaceComment,
  TEND_WORKSPACE_GROUP_KEY,
  TEND_DIRECTORY_GROUP_KEY
} from '../tend-workspace-comment'
import type { ProjectGroup } from '../project-group-types'
import type { OrderedGroupEntry } from './worktree-group-entry'
import { buildOrderedGroups } from './worktree-grouping'
import { appendOrderedGroups, type SectionAppendContext } from './group-sections'
import {
  compareFolderWorkspacesForDisplay,
  type RenderableFolderWorkspace
} from './folder-workspace-lanes'
import { getLaneHostWorktreeCounts, getLaneHostWorktreeIds } from './host-labels'

export function prepareTendWorkspaceGroups(
  args: Parameters<typeof buildOrderedGroups>[0],
  projectGroups: readonly ProjectGroup[]
) {
  const worktrees = args.naturalWorktrees.filter((row) => isTendWorkspaceComment(row.comment))
  const directories =
    args.folderWorkspaces?.filter((pair) => isTendWorkspaceComment(pair.folderWorkspace.comment)) ??
    []
  if (worktrees.length === 0 && directories.length === 0) {
    return {
      tendGroups: [],
      regularFolderWorkspaces: args.folderWorkspaces ?? [],
      regularProjectGroups: projectGroups
    }
  }
  const groups = buildOrderedGroups({
    ...args,
    groupBy: 'repo',
    naturalWorktrees: worktrees,
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingByRepo: new Map(),
    folderWorkspaces: []
  }).map(([key, group]): OrderedGroupEntry => [`${TEND_WORKSPACE_GROUP_KEY}:${key}`, group])
  if (directories.length > 0) {
    groups.push([
      TEND_DIRECTORY_GROUP_KEY,
      {
        label: 'Directories',
        items: [],
        repoIds: new Set(),
        folderWorkspaces: directories.sort((left, right) =>
          compareFolderWorkspacesForDisplay(left.folderWorkspace, right.folderWorkspace)
        )
      }
    ])
  }
  const regularFolderWorkspaces =
    args.folderWorkspaces?.filter(
      (pair) => !isTendWorkspaceComment(pair.folderWorkspace.comment)
    ) ?? []
  const tendFolderGroupIds = new Set(directories.map((pair) => pair.projectGroup.id))
  const regularGroupIds = new Set([
    ...regularFolderWorkspaces.map((pair) => pair.projectGroup.id),
    ...[...args.repoMap.values()].map((repo) => repo.projectGroupId),
    ...projectGroups.map((group) => group.parentGroupId)
  ])
  const regularProjectGroups = projectGroups.filter(
    (group) => !tendFolderGroupIds.has(group.id) || regularGroupIds.has(group.id)
  )
  return { tendGroups: groups, regularFolderWorkspaces, regularProjectGroups }
}

export function appendTendWorkspaceGroups(
  ctx: SectionAppendContext,
  groups: OrderedGroupEntry[]
): void {
  if (groups.length === 0) {
    return
  }
  const worktrees = groups.flatMap(([, group]) => group.items)
  const folders: RenderableFolderWorkspace[] = groups.flatMap(
    ([, group]) => group.folderWorkspaces ?? []
  )
  ctx.result.push({
    type: 'header',
    key: TEND_WORKSPACE_GROUP_KEY,
    label: 'tend',
    count: worktrees.length + folders.length,
    icon: { kind: 'project' },
    presentationOnly: true,
    projectGroupDepth: 0,
    worktreeIds: worktrees.map((row) => row.id),
    hostWorktreeCounts: getLaneHostWorktreeCounts(
      worktrees,
      folders,
      ctx.repoOf,
      ctx.defaultHostId
    ),
    hostWorktreeIds: getLaneHostWorktreeIds(worktrees, folders, ctx.repoOf, ctx.defaultHostId)
  })
  if (ctx.collapsedGroups.has(TEND_WORKSPACE_GROUP_KEY)) {
    return
  }
  const start = ctx.result.length
  appendOrderedGroups(
    {
      ...ctx,
      groupBy: 'repo',
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      pendingByRepo: new Map()
    },
    groups,
    1
  )
  const byKey = new Map(groups)
  for (let index = start; index < ctx.result.length; index++) {
    const row = ctx.result[index]
    if (row.type !== 'header') {
      continue
    }
    const group = byKey.get(row.key)
    if (!group) {
      continue
    }
    const folderPairs = group.folderWorkspaces ?? []
    ctx.result[index] = {
      ...row,
      repo: undefined,
      hostRepos: undefined,
      presentationOnly: true,
      count: group.items.length + folderPairs.length,
      worktreeIds: group.items.map((worktree) => worktree.id),
      hostWorktreeCounts: getLaneHostWorktreeCounts(
        group.items,
        folderPairs,
        ctx.repoOf,
        ctx.defaultHostId
      ),
      hostWorktreeIds: getLaneHostWorktreeIds(
        group.items,
        folderPairs,
        ctx.repoOf,
        ctx.defaultHostId
      )
    }
  }
}
