import { describe, expect, it } from 'vitest'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'

describe('buildRelayHookEnvelope', () => {
  it('projects TraeX through old Trae wire fields and preserves the optional identity', () => {
    const envelope = buildRelayHookEnvelope(
      {
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        connectionId: null,
        providerSession: {
          key: 'session_id',
          id: 'traex-session',
          transcriptPath: '/remote/trae/rollout.jsonl'
        },
        payload: { state: 'working', prompt: 'hello', agentType: 'traex' }
      },
      'traex'
    )

    expect(envelope).toMatchObject({
      source: 'trae',
      observedAgent: 'traex',
      providerSession: { id: 'traex-session' },
      payload: { state: 'working', prompt: 'hello', agentType: 'trae' }
    })
  })
})
