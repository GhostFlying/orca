import type {
  WorktreeOccurrencePlan,
  WorktreeOccurrenceSection
} from '../../../src/shared/worktree-occurrence-plan'
import {
  isTendWorkspaceGroupKey,
  TEND_WORKSPACE_GROUP_KEY
} from '../../../src/shared/tend-workspace-comment'
import { getMobileOccurrenceRows } from './mobile-workspace-lineage'
import type { Section, Worktree } from './workspace-list-types'

export function renderMobileWorkspaceSections(
  plan: WorktreeOccurrencePlan<Worktree> & {
    sections: readonly (Section & WorktreeOccurrenceSection<Worktree>)[]
  },
  collapsed: ReadonlySet<string>
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
      data: getMobileOccurrenceRows(plan, section.key, collapsed).map((row) =>
        section.projectGroupDepth ? { ...row, projectGroupDepth: section.projectGroupDepth } : row
      )
    }))
}
