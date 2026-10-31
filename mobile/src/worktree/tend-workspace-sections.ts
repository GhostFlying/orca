import {
  isTendWorkspaceComment,
  TEND_DIRECTORY_GROUP_KEY,
  TEND_WORKSPACE_GROUP_KEY
} from '../../../src/shared/tend-workspace-comment'
import {
  buildProjectSections,
  type ProjectGroupingIndex
} from '../../../src/shared/project-section-grouping'
import { withRepoSectionDisplayLabels } from '../../../src/shared/project-section-order'
import type { ProjectSectionCatalog } from './workspace-list-sections'
import type { Section, SectionRepo, Worktree } from './workspace-list-types'
import { translate } from '../i18n/mobile-i18n'

export function mobileTendSectionTitle(): string {
  return translate('worktree.workspaceListSections.tendTasks', 'Tend tasks')
}

export function isMobileTendWorkspace(worktree: Worktree): boolean {
  return isTendWorkspaceComment(worktree.comment ?? '')
}

export function buildMobileTendSections(
  worktrees: readonly Worktree[],
  catalog: ProjectSectionCatalog,
  repoMap: ReadonlyMap<string, SectionRepo>,
  projectIndex: ProjectGroupingIndex | null
): Section[] {
  if (worktrees.length === 0) {
    return []
  }
  const directories = worktrees.filter((row) => row.workspaceKind === 'folder-workspace')
  const groups = withRepoSectionDisplayLabels(
    buildProjectSections({
      items: worktrees.filter((row) => row.workspaceKind !== 'folder-workspace'),
      repoIdOf: (row) => row.repoId,
      repoMap,
      projectIndex,
      placeholderRepoIds: [],
      repoOrder: catalog.repoOrder,
      projectOrderBy: catalog.projectOrderBy
    })
  )
  return [
    {
      key: TEND_WORKSPACE_GROUP_KEY,
      title: mobileTendSectionTitle(),
      isProjectGroup: true,
      count: worktrees.length,
      data: []
    },
    ...groups.map(([key, group]): Section => ({
      key: `${TEND_WORKSPACE_GROUP_KEY}:${key}`,
      title: group.label,
      repo: group.repo,
      projectGroupDepth: 1,
      count: group.items.length,
      data: group.items
    })),
    ...(directories.length > 0
      ? [
          {
            key: TEND_DIRECTORY_GROUP_KEY,
            title: translate('worktree.workspaceListSections.directories', 'Directories'),
            isProjectGroup: true,
            projectGroupDepth: 1,
            count: directories.length,
            data: directories
          }
        ]
      : [])
  ]
}
