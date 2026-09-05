import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import {
  resolveMobileNativeChat,
  withRememberedNativeChatIdentity
} from './mobile-native-chat-eligibility'
import type { MobileSessionTab } from '../mobile-session-route-types'

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey: 'tab:leaf',
    ...overrides
  } as AgentStatusEntry
}

describe('resolveMobileNativeChat', () => {
  it('admits only capability-gated hook-confirmed TraeX sessions', () => {
    const confirmed = {
      type: 'terminal',
      agentStatus: status({
        agentType: 'traex',
        providerSession: {
          key: 'session_id',
          id: 'traex-session',
          transcriptPath: '/remote/trae/rollout.jsonl'
        }
      })
    }

    expect(resolveMobileNativeChat(confirmed, false, false)).toBeNull()
    expect(resolveMobileNativeChat(confirmed, false, true)).toEqual({
      agent: 'traex',
      sessionId: 'traex-session',
      transcriptPath: '/remote/trae/rollout.jsonl',
      agentConfirmed: true,
      sessionLive: true
    })
    expect(
      resolveMobileNativeChat(
        { type: 'terminal', agentStatus: status({ agentType: 'traex' }) },
        false,
        true
      )
    ).toBeNull()
  })

  it('never treats a Trae or TraeX launch hint as native chat authority', () => {
    expect(
      resolveMobileNativeChat({ type: 'terminal', launchAgent: 'trae' }, false, true)
    ).toBeNull()
    expect(
      resolveMobileNativeChat({ type: 'terminal', launchAgent: 'traex' }, false, true)
    ).toBeNull()
  })
})

describe('withRememberedNativeChatIdentity', () => {
  const terminalTab = (
    terminal: string | null,
    agentStatus?: AgentStatusEntry,
    launchAgent?: 'claude'
  ): MobileSessionTab => ({
    type: 'terminal',
    id: 'tab-1',
    title: 'claude',
    terminal,
    isActive: true,
    ...(agentStatus ? { agentStatus } : {}),
    ...(launchAgent ? { launchAgent } : {})
  })
  const claude = status({
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/t/sess-1.jsonl' }
  })
  const seen = withRememberedNativeChatIdentity([terminalTab('h1', claude)], [])

  it('does not show the previous conversation when the agent relaunches in the pane', () => {
    const [relaunched] = withRememberedNativeChatIdentity(
      [terminalTab('h1', status({ agentType: 'claude' }))],
      seen
    )
    expect(resolveMobileNativeChat(relaunched)?.sessionId).toBeNull()
    const [later] = withRememberedNativeChatIdentity([terminalTab('h1', status())], [relaunched])
    expect(resolveMobileNativeChat(later)?.sessionId).toBeNull()
  })
})
