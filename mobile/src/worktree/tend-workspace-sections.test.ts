import { describe, expect, it } from 'vitest'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import {
  TEND_DIRECTORY_GROUP_KEY,
  TEND_WORKSPACE_GROUP_KEY
} from '../../../src/shared/tend-workspace-comment'
import {
  buildMobileWorkspacePlan,
  buildSections,
  NO_PROJECT_SECTION_CATALOG,
  type Worktree
} from './workspace-list-sections'

const filters = { ...NO_WORKSPACE_ROW_FILTERS }
const catalog = {
  ...NO_PROJECT_SECTION_CATALOG,
  repos: [{ id: 'tend-repo', displayName: 'tend', path: '/repos/tend' }]
}

function row(worktreeId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId,
    repoId: 'tend-repo',
    repo: 'tend',
    displayName: worktreeId,
    path: `/workspaces/${worktreeId}`,
    branch: `feature/${worktreeId}`,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

const skimmer = row('skimmer', { comment: '' })
const task = row('task', { comment: 'tend workspace wsp_task\n' })
const directory = row('directory', {
  workspaceKind: 'folder-workspace',
  repoId: 'folder-group',
  comment: 'tend workspace wsp_directory\n',
  branch: ''
})
const taskSectionKey = `${TEND_WORKSPACE_GROUP_KEY}:repo:tend-repo`

function sections(
  rows: Worktree[],
  groupBy: Parameters<typeof buildSections>[4] = 'repo',
  collapsed: ReadonlySet<string> = new Set(),
  search = ''
) {
  return buildSections(
    rows,
    'name',
    filters,
    search,
    groupBy,
    new Set(),
    catalog,
    undefined,
    collapsed
  )
}

function placements(result: ReturnType<typeof sections>) {
  return result.map((section) => ({
    key: section.key,
    rows: section.data.map((worktree) => worktree.worktreeId)
  }))
}

describe('Tend workspaces on the shipped phone list', () => {
  it('separates a personal session from managed tasks in the same tend repository', () => {
    const result = sections([skimmer, task])

    expect(placements(result)).toEqual([
      { key: 'repo:tend-repo', rows: ['skimmer'] },
      { key: TEND_WORKSPACE_GROUP_KEY, rows: [] },
      { key: taskSectionKey, rows: ['task'] }
    ])
    expect(result[0]?.title).toBe('tend')
    expect(result[1]).toMatchObject({ title: 'Tend tasks', count: 1, isProjectGroup: true })
    expect(result[2]).toMatchObject({ projectGroupDepth: 1, count: 1 })
  })

  it.each(['none', 'repo', 'workspace-status', 'pr-status'] as const)(
    'keeps tasks across repositories and directories together under %s grouping',
    (groupBy) => {
      const other = row('other-task', {
        repoId: 'other-repo',
        repo: 'other',
        comment: 'tend task task_old\nworkspace wsp_old\nkind git\nrole accept\n'
      })
      const result = sections([skimmer, task, other, directory], groupBy)
      const managed = result.filter((section) =>
        [
          taskSectionKey,
          `${TEND_WORKSPACE_GROUP_KEY}:repo:other-repo`,
          TEND_DIRECTORY_GROUP_KEY
        ].includes(section.key)
      )

      expect(managed.map((section) => section.data[0]?.worktreeId)).toEqual([
        'other-task',
        'task',
        'directory'
      ])
      expect(result.find((section) => section.key === TEND_WORKSPACE_GROUP_KEY)?.count).toBe(3)
      expect(result.flatMap((section) => section.data)).toHaveLength(4)
    }
  )

  it('collapses the parent with its shared key without hiding personal sessions or losing counts', () => {
    const plan = buildMobileWorkspacePlan(
      [skimmer, task, directory],
      'name',
      filters,
      '',
      'repo',
      new Set(),
      catalog
    )

    expect(placements(plan.render(new Set([TEND_WORKSPACE_GROUP_KEY])))).toEqual([
      { key: 'repo:tend-repo', rows: ['skimmer'] },
      { key: TEND_WORKSPACE_GROUP_KEY, rows: [] }
    ])
    expect(plan.render(new Set([TEND_WORKSPACE_GROUP_KEY]))[1]?.count).toBe(2)
    expect(plan.render(new Set()).flatMap((section) => section.data)).toHaveLength(3)
  })

  it('keeps normal text mentioning tend and old hosts without comments in ordinary groups', () => {
    const mentioned = row('mention', { comment: 'tend workspace ideas, not a resource marker' })
    expect(placements(sections([skimmer, mentioned, row('old-host')]))).toEqual([
      { key: 'repo:tend-repo', rows: ['mention', 'old-host', 'skimmer'] }
    ])
  })

  it('applies search and repo filters while preserving the existing directory exemption', () => {
    expect(placements(sections([skimmer, task, directory], 'repo', new Set(), 'skimmer'))).toEqual([
      { key: 'repo:tend-repo', rows: ['skimmer'] }
    ])
    const result = buildSections(
      [skimmer, task, directory, row('excluded', { repoId: 'other-repo', comment: task.comment })],
      'name',
      { ...filters, filterRepoIds: ['tend-repo'] },
      '',
      'repo',
      new Set(),
      catalog
    )
    expect(result.find((section) => section.key === TEND_WORKSPACE_GROUP_KEY)?.count).toBe(2)
    expect(result.find((section) => section.key === TEND_DIRECTORY_GROUP_KEY)?.data).toHaveLength(1)
    expect(result.flatMap((section) => section.data).some((w) => w.worktreeId === 'excluded')).toBe(
      false
    )
  })

  it.each([false, true])('preserves personal pins with duplicate-in-groups %s', (duplicate) => {
    const result = buildSections(
      [skimmer, { ...task, isPinned: true }],
      'name',
      filters,
      '',
      'repo',
      new Set(['skimmer', 'task']),
      catalog,
      undefined,
      undefined,
      duplicate
    )
    expect(
      result.find((section) => section.key === 'pinned')?.data.map((w) => w.worktreeId)
    ).toEqual(['skimmer'])
    expect(
      result.flatMap((section) => section.data).filter((w) => w.worktreeId === 'task')
    ).toHaveLength(1)
    expect(result.find((section) => section.key === taskSectionKey)?.data[0]?.worktreeId).toBe(
      'task'
    )
  })

  it('blocks cross-source and managed cross-repo lineage from pulling rows into Pinned', () => {
    const result = sections([
      { ...skimmer, isPinned: true },
      { ...task, parentWorktreeId: 'skimmer' },
      row('personal-child', { parentWorktreeId: 'task' }),
      row('other-task', {
        repoId: 'other-repo',
        repo: 'other',
        parentWorktreeId: 'task',
        comment: task.comment
      })
    ])
    expect(
      result.find((section) => section.key === 'pinned')?.data.map((w) => w.worktreeId)
    ).toEqual(['skimmer'])
    expect(result.find((section) => section.key === 'repo:tend-repo')?.data[0]?.worktreeId).toBe(
      'personal-child'
    )
    expect(result.flatMap((section) => section.data).map((w) => w.lineageDepth)).toEqual([
      0, 0, 0, 0
    ])
  })

  it('keeps valid managed lineage and same-id rows on different hosts', () => {
    const result = sections([
      { ...task, hostId: 'local' },
      { ...task, hostId: 'ssh:builder' },
      row('child', { hostId: 'local', parentWorktreeId: 'task', comment: task.comment })
    ])
    expect(
      result
        .find((section) => section.key === taskSectionKey)
        ?.data.map((w) => [w.worktreeId, w.hostId, w.lineageDepth])
    ).toEqual([
      ['task', 'local', 0],
      ['child', 'local', 1],
      ['task', 'ssh:builder', 0]
    ])
  })
})
