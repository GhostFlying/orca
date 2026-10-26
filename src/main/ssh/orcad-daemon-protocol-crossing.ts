/** Daemons outlive orcad swaps; incoming builds can attach only current/previous daemon protocols, matching config/scripts/daemon-protocol-facts.mjs canAttach. */
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'

export type OrcadDaemonProtocolFacts = {
  protocolVersion: number
  previousProtocolVersions: readonly number[]
}

export const CURRENT_ORCAD_DAEMON_PROTOCOL: OrcadDaemonProtocolFacts = {
  protocolVersion: PROTOCOL_VERSION,
  previousProtocolVersions: PREVIOUS_DAEMON_PROTOCOL_VERSIONS
}

export function orcadBuildCanAttachDaemon(
  reader: OrcadDaemonProtocolFacts,
  ownerProtocolVersion: number
): boolean {
  return (
    reader.protocolVersion === ownerProtocolVersion ||
    reader.previousProtocolVersions.includes(ownerProtocolVersion)
  )
}

export type OrcadLiveDaemonCrossing =
  | 'no-live-terminals'
  | 'attachable'
  | 'strands-live-terminals'
  | 'unverifiable'

/** An unknown session count or daemon protocol is planned for as live and unattachable. */
export function assessOrcadLiveDaemonCrossing(
  census: OrcadTerminalCensus,
  incoming: OrcadDaemonProtocolFacts
): OrcadLiveDaemonCrossing {
  if (census.liveSessions === 0) {
    return 'no-live-terminals'
  }
  const versions = census.daemonProtocolVersions
  if (versions !== undefined) {
    if (
      versions.length === 0 ||
      versions.some((version) => !Number.isSafeInteger(version) || version <= 0) ||
      (census.daemonProtocolVersion !== null &&
        (versions.length !== 1 || versions[0] !== census.daemonProtocolVersion))
    ) {
      return 'unverifiable'
    }
    return versions.every((version) => orcadBuildCanAttachDaemon(incoming, version))
      ? 'attachable'
      : 'strands-live-terminals'
  }
  if (census.daemonProtocolVersion === null) {
    return 'unverifiable'
  }
  return orcadBuildCanAttachDaemon(incoming, census.daemonProtocolVersion)
    ? 'attachable'
    : 'strands-live-terminals'
}
