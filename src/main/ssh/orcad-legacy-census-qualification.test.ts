import { describe, expect, it } from 'vitest'
import { qualifyLegacyOrcadDaemonProtocols } from './orcad-legacy-census-qualification'
import { assessOrcadLiveDaemonCrossing } from './orcad-daemon-protocol-crossing'

function evidence() {
  const census = {
    liveSessions: 2,
    startedSinceActivation: null,
    daemonProtocolVersion: null,
    inProcessSessions: 0,
    admissionClosedUntil: 60000
  }
  return {
    before: {
      runtimeIdentity: 'runtime-1',
      daemonIdentities: ['daemon-50', 'daemon-51'],
      census: { ...census }
    },
    after: {
      runtimeIdentity: 'runtime-1',
      daemonIdentities: ['daemon-50', 'daemon-51'],
      census: { ...census }
    },
    inventories: [
      {
        daemonIdentity: 'daemon-50',
        protocolVersion: 50,
        sessionIdentities: ['session-a:incarnation-a']
      },
      {
        daemonIdentity: 'daemon-51',
        protocolVersion: 51,
        sessionIdentities: ['session-b:incarnation-b']
      }
    ],
    now: 1000
  }
}

const reader = { protocolVersion: 51, previousProtocolVersions: [50] }

describe('legacy mixed daemon qualification', () => {
  it('preserves the legacy null and qualifies the complete authenticated set for normal planning', () => {
    const qualified = qualifyLegacyOrcadDaemonProtocols(evidence())
    expect(qualified).toMatchObject({
      daemonProtocolVersion: null,
      daemonProtocolVersions: [50, 51]
    })
    expect(qualified && assessOrcadLiveDaemonCrossing(qualified, reader)).toBe('attachable')
  })

  it.each([
    [
      'runtime replacement',
      (input: ReturnType<typeof evidence>) => {
        input.after.runtimeIdentity = 'runtime-2'
      }
    ],
    [
      'expired fence',
      (input: ReturnType<typeof evidence>) => {
        input.now = 60000
      }
    ],
    [
      'new generation',
      (input: ReturnType<typeof evidence>) => {
        input.after.daemonIdentities.push('daemon-52')
      }
    ],
    [
      'count mismatch',
      (input: ReturnType<typeof evidence>) => {
        input.after.census.liveSessions = 3
      }
    ],
    [
      'in-process session',
      (input: ReturnType<typeof evidence>) => {
        input.after.census.inProcessSessions = 1
      }
    ],
    [
      'duplicate generation',
      (input: ReturnType<typeof evidence>) => {
        input.inventories[1] = input.inventories[0]!
      }
    ],
    [
      'duplicate session',
      (input: ReturnType<typeof evidence>) => {
        input.inventories[1]!.sessionIdentities = input.inventories[0]!.sessionIdentities
      }
    ],
    [
      'missing inventory',
      (input: ReturnType<typeof evidence>) => {
        input.inventories.pop()
      }
    ]
  ])('refuses %s', (_name, change) => {
    const input = evidence()
    change(input)
    expect(qualifyLegacyOrcadDaemonProtocols(input)).toBeNull()
  })

  it('keeps unsupported protocols refused by the normal planner', () => {
    const input = evidence()
    input.inventories[1]!.protocolVersion = 52
    const qualified = qualifyLegacyOrcadDaemonProtocols(input)
    expect(qualified && assessOrcadLiveDaemonCrossing(qualified, reader)).toBe(
      'strands-live-terminals'
    )
  })

  it('rejects a failed authenticated daemon query', () => {
    expect(
      qualifyLegacyOrcadDaemonProtocols({ ...evidence(), inventories: [null, null] })
    ).toBeNull()
  })
})

describe('protocol set crossing', () => {
  it('does not turn legacy unknown or an empty set into attachability', () => {
    const { census } = evidence().after
    expect(assessOrcadLiveDaemonCrossing(census, reader)).toBe('unverifiable')
    expect(assessOrcadLiveDaemonCrossing({ ...census, daemonProtocolVersions: [] }, reader)).toBe(
      'unverifiable'
    )
    expect(
      assessOrcadLiveDaemonCrossing(
        { ...census, daemonProtocolVersion: 50, daemonProtocolVersions: [50, 51] },
        reader
      )
    ).toBe('unverifiable')
  })
})
