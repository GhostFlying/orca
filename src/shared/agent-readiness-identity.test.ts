import { describe, expect, it } from 'vitest'
import { resolveAgentReadinessIdentity } from './agent-readiness-identity'

describe('resolveAgentReadinessIdentity', () => {
  it.each(['trae', 'traex'])('uses the Trae readiness catalog for %s', (agent) => {
    expect(resolveAgentReadinessIdentity(agent)).toBe('trae')
  })

  it('preserves other known identities and rejects unknown observations', () => {
    expect(resolveAgentReadinessIdentity('codex')).toBe('codex')
    expect(resolveAgentReadinessIdentity('claude')).toBe('claude')
    for (const value of ['unknown', 'dsb', 'custom-agent', null, undefined]) {
      expect(resolveAgentReadinessIdentity(value)).toBeNull()
    }
  })
})
