import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID = '77777777-7777-4777-8777-777777777777'

function makeTab(): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    launchAgent: 'trae'
  }
}

function makeLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null
  }
}

describe('TraeX title-derived agent rows', () => {
  it('keeps TraeX distinct from Trae before hook status arrives', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab()],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: { 'tab-1': { 1: '⠋ traex' } },
      ptyIdsByTabId: { 'tab-1': ['pty-trae'] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout() },
      now: 2000
    })

    expect(rows.map((row) => [row.agentType, row.state, row.entry.prompt])).toEqual([
      ['traex', 'working', 'TraeX']
    ])
  })
})
