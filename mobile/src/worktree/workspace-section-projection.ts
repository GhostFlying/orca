import type {
  WorktreeOccurrencePlan,
  WorktreeOccurrenceSection
} from '../../../src/shared/worktree-occurrence-plan'
import {
  isTendWorkspaceGroupKey,
  TEND_WORKSPACE_GROUP_KEY
} from '../../../src/shared/tend-workspace-comment'
import { getMobileOccurrenceRows } from './mobile-workspace-lineage'
import type { PlannedSection } from './workspace-list-sections'
import type { Section, Worktree } from './workspace-list-types'
import {
  NO_WORKTREE_HOST_CONTEXT,
  type WorktreeHostContextOf
} from './worktree-host-context-labels'

export function renderMobileWorkspaceSections(
  plan: WorktreeOccurrencePlan<Worktree> & {
    sections: readonly (PlannedSection & WorktreeOccurrenceSection<Worktree>)[]
  },
  collapsed: ReadonlySet<string>,
  hostContextOf: WorktreeHostContextOf = NO_WORKTREE_HOST_CONTEXT
): Section[] {
  return plan.sections
    .filter(
      (section) =>
        section.key === TEND_WORKSPACE_GROUP_KEY ||
        !isTendWorkspaceGroupKey(section.key) ||
        !collapsed.has(TEND_WORKSPACE_GROUP_KEY)
    )
    .map(({ items: _items, placement: _placement, ...section }) => ({
      ...section,
      data: getMobileOccurrenceRows(plan, section.key, collapsed, hostContextOf).map((item) =>
        section.projectGroupDepth
          ? {
              ...item,
              view: { ...item.view, projectGroupDepth: section.projectGroupDepth }
            }
          : item
      )
    }))
}
