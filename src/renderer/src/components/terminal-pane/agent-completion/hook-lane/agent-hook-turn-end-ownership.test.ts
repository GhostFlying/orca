import { beforeEach, describe, expect, it, vi } from 'vitest'

const state: {
  agentStatusByPaneKey: Map<string, { agentType: string; state: string }>
  settings: { agentStatusHooksEnabled: boolean }
} = {
  agentStatusByPaneKey: new Map(),
  settings: { agentStatusHooksEnabled: true }
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('./agent-hook-completion-notifications', () => ({
  hookLaneCanAnnouncePaneTurnEnd: () => true
}))
vi.mock('./agent-hook-turn-end-capability', () => ({
  hookTurnEndEvidence: () => 'identified'
}))

describe('hook turn-end ownership', () => {
  beforeEach(() => {
    state.agentStatusByPaneKey = new Map()
    state.settings = { agentStatusHooksEnabled: true }
  })

  it('uses Trae hook settings for an observed TraeX foreground process', async () => {
    state.agentStatusByPaneKey = new Map([['pane', { agentType: 'traex', state: 'done' }]])
    const { hookLaneTitleTurnEndEvidence } = await import('./agent-hook-turn-end-ownership')

    expect(hookLaneTitleTurnEndEvidence('pane', 'pty', null, 'traex')).toBe('identified')
  })
})
