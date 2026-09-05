import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  agentStatusByPaneKey: {},
  settings: { agentStatusHooksEnabled: true }
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/pane-agent-evidence', () => ({ resolveCommittedTitleAgentType: () => null }))
vi.mock('./agent-hook-completion-notifications', () => ({
  hookLaneCanAnnouncePaneTurnEnd: () => true
}))
vi.mock('./agent-hook-turn-end-capability', () => ({
  hookTurnEndEvidence: () => 'identified'
}))

describe('hook turn-end ownership', () => {
  beforeEach(() => {
    state.agentStatusByPaneKey = {}
    state.settings = { agentStatusHooksEnabled: true }
  })

  it('uses Trae hook settings for an observed TraeX foreground process', async () => {
    state.agentStatusByPaneKey = {
      pane: { agentType: 'traex', state: 'done' }
    }
    const { hookLaneTitleTurnEndEvidence } = await import('./agent-hook-turn-end-ownership')

    expect(hookLaneTitleTurnEndEvidence('pane', 'pty', null, 'traex')).toBe('identified')
  })
})
