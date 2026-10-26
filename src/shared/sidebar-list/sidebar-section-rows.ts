import type { ExecutionHostId } from '../execution-host/execution-host'
import type { ProjectGroup } from '../project/groups/project-group-types'
import type { ProjectGroupingIndex } from './sections/project-section-grouping'
import { withRepoSectionDisplayLabels } from './sections/project-section-order'
import type { ProjectOrderBy } from '../ui-chrome/ui-chrome-types'
import type { Repo } from '../repository/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { WorktreeOccurrencePlan } from './lineage/worktree-occurrence-plan'
import type { RenderableFolderWorkspace } from './folders/folder-workspace-lanes'
import { ALL_GROUP_KEY } from './sections/group-keys'
import { appendOrderedGroups, type SectionAppendContext } from './sections/group-sections'
import type { NoticeHostContext } from './hosts/host-labels'
import { getLaneHostWorktreeCounts, getLaneHostWorktreeIds } from './hosts/host-labels'
import { appendImportedWorktreeLines } from './sections/imported-worktree-lines'
import { appendProjectGroupSections } from './sections/project-group-sections'
import { appendWorktreeRows } from './sections/row-builders'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  RepoOfWorktree,
  Row,
  WorktreeGroupBy
} from './row-types'
import { appendTendWorkspaceGroups } from './tend-workspace-groups'
import type { OrderedGroupEntry } from './sections/worktree-group-entry'

export type SidebarSectionRowsArgs = {
  result: Row[]
  groupBy: WorktreeGroupBy
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  repoMap: Map<string, Repo>
  repoOf: RepoOfWorktree
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string> | undefined
  projectIndex: ProjectGroupingIndex | null
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  mixedWorktreeHostContextLabels: Map<string, string> | undefined
  noticeHostContextLabelByRepoId: Map<string, NoticeHostContext> | undefined
  occurrencePlan: WorktreeOccurrencePlan<Worktree>
  folderPairByIdentity: ReadonlyMap<string, RenderableFolderWorkspace>
  orderedGroups: OrderedGroupEntry[]
  tendGroups: OrderedGroupEntry[]
  naturalWorktrees: readonly Worktree[]
  regularFolderWorkspaces: readonly RenderableFolderWorkspace[]
  regularProjectGroups: readonly ProjectGroup[]
  projectGroups: readonly ProjectGroup[]
  projectOrderBy: ProjectOrderBy
  repoOrder?: Map<string, number>
}

/** Emit the grouping sections below the pinned rows; flat mode still shows one All header (#15362). */
export function appendSidebarSectionRows(args: SidebarSectionRowsArgs): void {
  const {
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
    naturalWorktrees,
    regularFolderWorkspaces,
    regularProjectGroups,
    projectGroups,
    projectOrderBy,
    repoOrder
  } = args
  const sectionContext: SectionAppendContext = {
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
    folderPairByIdentity
  }
  const appendImportedLines = (): void => {
    appendImportedWorktreeLines(result, { importedWorktreesByRepo, defaultHostId, hostLabelById })
  }

  appendTendWorkspaceGroups(sectionContext, args.tendGroups)
  if (groupBy === 'none') {
    // Folder-only accounts must still render flat rows (#15362).
    if (naturalWorktrees.length > 0 || regularFolderWorkspaces.length > 0) {
      result.push({
        type: 'header',
        key: ALL_GROUP_KEY,
        count: naturalWorktrees.length + regularFolderWorkspaces.length,
        icon: { kind: 'all' },
        hostWorktreeCounts: getLaneHostWorktreeCounts(
          naturalWorktrees,
          regularFolderWorkspaces,
          repoOf,
          defaultHostId
        ),
        hostWorktreeIds: getLaneHostWorktreeIds(
          naturalWorktrees,
          regularFolderWorkspaces,
          repoOf,
          defaultHostId
        ),
        worktreeIds: naturalWorktrees.map((worktree) => worktree.id)
      })
      if (!collapsedGroups.has(ALL_GROUP_KEY)) {
        appendWorktreeRows(result, repoOf, occurrencePlan, {
          collapsedGroups,
          groupDepth: 0,
          sectionKey: ALL_GROUP_KEY,
          hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels,
          folderPairByIdentity
        })
      }
    }
    appendImportedLines()
    return
  }

  if (groupBy !== 'repo' || projectGroups.length === 0) {
    appendOrderedGroups(
      sectionContext,
      groupBy === 'repo' ? withRepoSectionDisplayLabels(orderedGroups) : orderedGroups
    )
    if (groupBy !== 'repo') {
      appendImportedLines()
    }
    return
  }

  appendProjectGroupSections(sectionContext, {
    orderedGroups,
    projectGroups: regularProjectGroups,
    folderWorkspaces: regularFolderWorkspaces,
    projectOrderBy,
    repoOrder
  })
}
