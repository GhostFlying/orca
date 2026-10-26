import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'

type FencedObservation = {
  runtimeIdentity: string
  daemonIdentities: readonly string[]
  census: OrcadTerminalCensus
}

export type AuthenticatedDaemonInventory = {
  daemonIdentity: string
  protocolVersion: number
  sessionIdentities: readonly string[]
}

/** The transport must authenticate every daemon inventory against its live process identity. */
export function qualifyLegacyOrcadDaemonProtocols(input: {
  before: FencedObservation
  after: FencedObservation
  inventories: readonly (AuthenticatedDaemonInventory | null)[]
  now: number
}): OrcadTerminalCensus | null {
  const { before, after, inventories, now } = input
  if (
    !Number.isFinite(now) ||
    !before.runtimeIdentity ||
    before.runtimeIdentity !== after.runtimeIdentity
  ) {
    return null
  }
  for (const observation of [before, after]) {
    const { census } = observation
    if (
      census.liveSessions === null ||
      census.inProcessSessions !== 0 ||
      !Number.isFinite(census.admissionClosedUntil) ||
      (census.admissionClosedUntil ?? 0) <= now
    ) {
      return null
    }
  }
  if (before.census.liveSessions !== after.census.liveSessions) {
    return null
  }
  const identities = new Set(before.daemonIdentities)
  if (
    identities.size === 0 ||
    identities.has('') ||
    identities.size !== before.daemonIdentities.length ||
    identities.size !== after.daemonIdentities.length ||
    identities.size !== new Set(after.daemonIdentities).size ||
    !after.daemonIdentities.every((identity) => identities.has(identity)) ||
    identities.size !== inventories.length
  ) {
    return null
  }
  const sessions = new Set<string>()
  const versions = new Set<number>()
  for (const inventory of inventories) {
    if (
      !inventory ||
      !identities.delete(inventory.daemonIdentity) ||
      !Number.isSafeInteger(inventory.protocolVersion) ||
      inventory.protocolVersion <= 0
    ) {
      return null
    }
    for (const identity of inventory.sessionIdentities) {
      if (!identity || sessions.has(identity)) {
        return null
      }
      sessions.add(identity)
    }
    if (inventory.sessionIdentities.length > 0) {
      versions.add(inventory.protocolVersion)
    }
  }
  if (identities.size !== 0 || sessions.size !== after.census.liveSessions) {
    return null
  }
  const daemonProtocolVersions = [...versions].sort((a, b) => a - b)
  if (
    after.census.daemonProtocolVersion !== null &&
    (daemonProtocolVersions.length !== 1 ||
      daemonProtocolVersions[0] !== after.census.daemonProtocolVersion)
  ) {
    return null
  }
  return { ...after.census, daemonProtocolVersions }
}
