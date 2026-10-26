import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../project/groups/project-group-types'
import type { Repo } from '../repository/repo-types'
import type { ProjectOrderBy } from '../ui-chrome/ui-chrome-types'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { SidebarLineageParentIdentities } from './lineage/worktree-lineage-projection'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host/execution-host'
import type { HiddenProjects } from '../project/catalog/hidden-projects'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from './sections/group-keys'

import { getMixedWorktreeHostContextLabels, getNoticeHostContextLabels } from './hosts/host-labels'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo,
  type ProjectSectionModel
} from './sections/project-section-grouping'
import { buildWorktreeOccurrencePlan } from './lineage/worktree-occurrence-plan'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { OrderedGroupEntry, SidebarOccurrenceSection } from './sections/worktree-group-entry'

import { getProjectGroupOccurrencePaths } from './sections/project-group-sections'
import { getSidebarLineageChildren } from './lineage/pinned-section-worktrees'
import { emitPinnedGroup } from './sections/pinned-group-rows'
import { buildPendingCreationRow } from './sections/row-builders'
import { getRenderableFolderWorkspaces } from './folders/folder-workspace-lanes'
import {
  getFolderLaneSections,
  getSidebarFolderOccurrences,
  isFolderLaneSectionKey
} from './folders/folder-workspace-occurrences'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  PinnedWorktreeDisplayPolicy,
  RepoOfWorktree,
  Row,
  SidebarPRGroupReader,
  WorktreeGroupBy
} from './row-types'
import { orderMainWorktreeFirst } from './sections/section-order'
import { buildOrderedGroups } from './sections/worktree-grouping'
import type { WorkspaceSortBy } from '../workspace-view/workspace-row-sort'
import * as tend from '../tend-workspace-comment'
import { prepareTendWorkspaceGroups } from './tend-workspace-groups'
import { appendSidebarSectionRows } from './sidebar-section-rows'

/** Everything the row builder reads. Pure data: no store, clock or client-specific state. */
export type SidebarRowPlanInputs = {
  groupBy: WorktreeGroupBy
  sortBy: WorkspaceSortBy
  /** Visible worktrees in the frozen sort order. */
  worktrees: Worktree[]
  repoMap: Map<string, Repo>
  /** Defaults to repoMap's registration for the row's repo id. */
  repoOfWorktree?: RepoOfWorktree
  prGroupOf: SidebarPRGroupReader
  repoOrder?: Map<string, number>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectOrderBy: ProjectOrderBy
  lineageById: Record<string, WorktreeLineage>
  /** Parents resolved once over every visible store's complete rows; nesting reuses them. */
  lineageParentIdentities?: SidebarLineageParentIdentities
  worktreeMap: Map<string, Worktree>
  nestLineage: boolean
  projectGroups: readonly ProjectGroup[]
  placeholderRepoIds: ReadonlySet<string>
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingCreations: readonly PendingCreationRef[]
  projectGrouping?: ProjectSectionModel
  folderWorkspaces: readonly FolderWorkspace[]
  hostLabelById?: ReadonlyMap<string, string>
  defaultHostId: ExecutionHostId
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  filterRepoIds: readonly string[]
  /** A hidden project's rows reach the plan only under a folder workspace; they never make its section. */
  hiddenProjects?: HiddenProjects
}

/** Plans the sidebar's sections once; `render` emits rows for a collapse state. */
export function planSidebarRows(inputs: SidebarRowPlanInputs) {
  const {
    groupBy,
    sortBy,
    worktrees,
    repoMap,
    repoOfWorktree,
    prGroupOf,
    repoOrder,
    workspaceStatuses,
    projectOrderBy,
    lineageById,
    lineageParentIdentities,
    worktreeMap,
    nestLineage,
    projectGroups,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingCreations,
    projectGrouping,
    folderWorkspaces,
    hostLabelById,
    defaultHostId,
    pinnedDisplayPolicy,
    filterRepoIds
  } = inputs
  const projectIndex = buildProjectGroupingIndex(projectGrouping)
  const repoOf = repoOfWorktree ?? ((worktree: Worktree) => repoMap.get(worktree.repoId))
  // Resolve folder membership before groupBy; every mode renders the same set (#15362).
  const renderableFolderWorkspaces = getRenderableFolderWorkspaces(folderWorkspaces, projectGroups)
  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of pendingCreations) {
    const list = pendingByRepo.get(creation.repoId) ?? []
    list.push(creation)
    pendingByRepo.set(creation.repoId, list)
  }

  const groupingInputs = {
    groupBy,
    naturalWorktrees: worktrees,
    repoMap,
    prGroupOf,
    workspaceStatuses,
    projectIndex,
    placeholderRepoIds,
    importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo,
    pendingByRepo,
    repoOrder,
    projectOrderBy,
    folderWorkspaces: renderableFolderWorkspaces
  }
  const { tendGroups, regularFolderWorkspaces, regularProjectGroups } = prepareTendWorkspaceGroups(
    groupingInputs,
    projectGroups
  )
  const projectGroupPaths = getProjectGroupOccurrencePaths(projectGroups)
  // Folder rows are occurrences too, so a folder parent nests its children like any other row.
  const folders = getSidebarFolderOccurrences(regularFolderWorkspaces, inputs.hiddenProjects)
  // Tend directories render under their own section, never as a regular folder lane.
  const tendFolders = getSidebarFolderOccurrences(
    renderableFolderWorkspaces.filter((pair) =>
      tend.isTendWorkspaceComment(pair.folderWorkspace.comment)
    ),
    inputs.hiddenProjects
  )
  const folderPairByIdentity = new Map([...folders.pairByIdentity, ...tendFolders.pairByIdentity])
  const lineageChildren = nestLineage
    ? getSidebarLineageChildren(
        worktrees,
        lineageById,
        worktreeMap,
        filterRepoIds,
        lineageParentIdentities,
        folders.rows
      )
    : new Map<string, Worktree[]>()
  const occurrencePlan = buildWorktreeOccurrencePlan({
    rows: folders.withPlacedRows(worktrees, lineageChildren),
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: lineageChildren,
    isPinned: (worktree) =>
      worktree.isPinned === true &&
      !folders.isFolder(worktree) &&
      !tend.isTendWorkspaceComment(worktree.comment),
    duplicatePinned: pinnedDisplayPolicy === 'duplicate-in-groups',
    owningSectionOf: (worktree) =>
      getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex),
    projectIdOf: (worktree) => worktree.repoId,
    sectionsOf: ({ pinned, natural, displayRootByIdentity }) => {
      const folderBound =
        groupBy === 'repo'
          ? folders.boundRowsByGroupId(natural, displayRootByIdentity, lineageChildren)
          : null
      // Rows under a folder still count in their own projects; only their display moves.
      const naturalWorktrees = folders
        .projectRows(natural, groupBy === 'repo')
        .filter((row) => !tend.isTendWorkspaceComment(row.comment))
      const groups: OrderedGroupEntry[] =
        groupBy === 'none'
          ? [[ALL_GROUP_KEY, { label: '', items: naturalWorktrees, repoIds: new Set() }]]
          : buildOrderedGroups({
              groupBy,
              naturalWorktrees,
              repoMap,
              prGroupOf,
              workspaceStatuses,
              projectIndex,
              displayRootByIdentity: folderBound?.groupingRootByIdentity ?? displayRootByIdentity,
              placeholderRepoIds,
              importedWorktreesByRepo,
              newExternalWorktreesInboxByRepo,
              pendingByRepo,
              repoOrder,
              projectOrderBy,
              folderWorkspaces: regularFolderWorkspaces
            })
      for (const [key, group] of tendGroups) {
        groups.push([
          key,
          group.folderWorkspaces?.length
            ? { ...group, items: [...group.items, ...tendFolders.rowsOf(group.folderWorkspaces)] }
            : group
        ])
      }
      if (pinned.length > 0) {
        groups.unshift([PINNED_GROUP_KEY, { label: '', items: pinned, repoIds: new Set() }])
      }
      const sections = groups.map(([key, group]): SidebarOccurrenceSection => {
        const revealPath = tend.isTendWorkspaceGroupKey(key)
          ? { key: tend.TEND_WORKSPACE_GROUP_KEY }
          : groupBy === 'repo' && key !== PINNED_GROUP_KEY && group.repo?.projectGroupId
            ? projectGroupPaths.get(group.repo.projectGroupId)
            : undefined
        const items = (
          groupBy === 'repo' && key !== PINNED_GROUP_KEY
            ? orderMainWorktreeFirst(group.items, sortBy)
            : group.items
        ).filter((row) => key === PINNED_GROUP_KEY || !folderBound?.bound.has(row))
        return {
          key,
          group,
          placement: key === PINNED_GROUP_KEY ? 'pinned' : 'natural',
          // Folder rows follow the lane's worktrees, as their rows always have.
          items:
            key === ALL_GROUP_KEY
              ? [...items, ...folders.rows]
              : [...items, ...folders.rowsOf(group.folderWorkspaces)],
          revealPath: { key, parent: revealPath }
        }
      })
      return [...sections, ...getFolderLaneSections(folderBound, projectGroupPaths)]
    }
  })
  const pinnedSectionWorktrees =
    occurrencePlan.sections.find((section) => section.key === PINNED_GROUP_KEY)?.group.items ?? []
  const orderedGroups: OrderedGroupEntry[] = occurrencePlan.sections
    .filter(
      (section) =>
        section.key !== PINNED_GROUP_KEY &&
        !tend.isTendWorkspaceGroupKey(section.key) &&
        !isFolderLaneSectionKey(section.key)
    )
    .map((section) => [section.key, section.group])
  const naturalWorktrees = orderedGroups.flatMap(([, group]) => group.items)
  const render = (collapsedGroups: Set<string>): Row[] => {
    const result: Row[] = []
    if (groupBy !== 'repo') {
      for (const creation of pendingCreations) {
        result.push(buildPendingCreationRow(creation, repoMap))
      }
    }
    // Include pinned-only rows when testing mixed hosts or pinned remotes lose host labels.
    const mixedWorktreeHostContextLabels = getMixedWorktreeHostContextLabels(
      worktrees,
      renderableFolderWorkspaces,
      repoOf,
      hostLabelById,
      defaultHostId
    )
    // Project ambiguity is independent of section/host filters; repoMap decides it, candidate maps gate notice eligibility.
    const noticeHostContextLabelByRepoId = getNoticeHostContextLabels(
      new Set([...importedWorktreesByRepo.keys(), ...newExternalWorktreesInboxByRepo.keys()]),
      repoMap.keys(),
      repoMap,
      projectIndex,
      hostLabelById
    )
    emitPinnedGroup(
      pinnedSectionWorktrees,
      repoOf,
      defaultHostId,
      collapsedGroups,
      result,
      occurrencePlan,
      mixedWorktreeHostContextLabels
    )
    appendSidebarSectionRows({
      result,
      groupBy,
      collapsedGroups,
      workspaceStatuses,
      repoMap,
      repoOf,
      defaultHostId,
      hostLabelById,
      projectIndex,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo,
      pendingByRepo,
      mixedWorktreeHostContextLabels,
      noticeHostContextLabelByRepoId,
      occurrencePlan,
      folderPairByIdentity,
      orderedGroups,
      tendGroups,
      naturalWorktrees,
      regularFolderWorkspaces,
      regularProjectGroups,
      projectGroups,
      projectOrderBy,
      repoOrder
    })
    return result
  }
  return { occurrencePlan, render }
}
