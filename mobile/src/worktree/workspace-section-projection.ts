import type {
  WorktreeOccurrencePlan,
  WorktreeOccurrenceSection
} from '../../../src/shared/sidebar-list/lineage/worktree-occurrence-plan'
import {
  isTendWorkspaceGroupKey,
  TEND_WORKSPACE_GROUP_KEY
} from '../../../src/shared/tend-workspace-comment'
import { getMobileOccurrenceRows } from './agent-lineage/mobile-workspace-lineage'
import {
  placeInProjectGroupTree,
  type GroupTreePlacement
} from './project-sections/project-group-tree-sections'
import {
  NO_WORKTREE_HOST_CONTEXT,
  type WorktreeHostContextOf
} from './row-presentation/worktree-host-context-labels'
import type { PlannedSection } from './workspace-list/workspace-list-sections'
import type { Section, Worktree } from './workspace-list/workspace-list-types'

export function renderMobileWorkspaceSections(
  plan: WorktreeOccurrencePlan<Worktree>,
  sections: readonly (PlannedSection & WorktreeOccurrenceSection<Worktree>)[],
  placements: ReadonlyMap<string, GroupTreePlacement>,
  collapsed: ReadonlySet<string>,
  hostContextOf: WorktreeHostContextOf = NO_WORKTREE_HOST_CONTEXT
): Section[] {
  return sections.flatMap(({ items: _items, placement: _placement, ...section }) => {
    // Collapsing the Tend group hides its repo and directory children.
    if (
      section.key !== TEND_WORKSPACE_GROUP_KEY &&
      isTendWorkspaceGroupKey(section.key) &&
      collapsed.has(TEND_WORKSPACE_GROUP_KEY)
    ) {
      return []
    }
    const listed = placeInProjectGroupTree(
      {
        ...section,
        data: getMobileOccurrenceRows(plan, section.key, collapsed, hostContextOf).map((item) =>
          section.projectGroupDepth
            ? { ...item, view: { ...item.view, projectGroupDepth: section.projectGroupDepth } }
            : item
        )
      },
      placements.get(section.key),
      collapsed
    )
    return listed ? [listed] : []
  })
}
