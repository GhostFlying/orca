import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import {
  feedDomains,
  feedKey,
  feedRow,
  phoneView,
  SERVED_SECTIONS
} from './host-sidebar-feed.test-fixture'
import {
  useHostListSections,
  type HostListSections,
  type HostListSectionsInputs
} from './use-host-list-sections'

vi.mock('../../../src/shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))
vi.mock('../worktree/use-last-visited-worktree-on-host', () => ({
  useLastVisitedWorktreeOnHost: () => null
}))
vi.mock('./use-host-repo-icon-data-urls', () => ({
  useHostRepoIconDataUrls: () => new Map()
}))

let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  await activateMobileUiLocale('en')
})

it('refreshes the feed-built Tend title when the language changes with stable feed inputs', async () => {
  await activateMobileUiLocale('en')
  const domains = feedDomains({
    workspaces: new Map([
      [feedKey('|task'), feedRow({ id: 'task', comment: 'tend workspace wsp_task' })]
    ])
  })
  const state = {
    view: phoneView(),
    servedProjectSections: SERVED_SECTIONS,
    desktopRepos: [],
    repoHostIdByRepoId: new Map(),
    hostProjectGroups: [],
    search: ''
  }
  const inputs: HostListSectionsInputs = {
    client: null,
    hostId: 'desktop',
    feed: { kind: 'ready', domains },
    displayWorktrees: [],
    hostPlatform: 'linux',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section hook reads only the populated catalog, view and search state.
    state: state as HostListSectionsInputs['state']
  }
  let result: HostListSections | undefined
  function Probe() {
    result = useHostListSections(inputs)
    return null
  }
  const title = () => result?.sections.find((section) => section.key === 'tend:workspaces')?.title
  await act(async () => {
    tree = create(createElement(Probe))
  })
  expect(title()).toBe('Tend tasks')

  await act(async () => {
    await activateMobileUiLocale('zh')
  })
  expect(title()).toBe('Tend 任务')
})
