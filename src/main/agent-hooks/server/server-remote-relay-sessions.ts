import { RelaySessionGenerations } from './server-relay-sessions'
import { AgentHookServerIngestStructuredChildren } from './server-ingest-structured-children'

export abstract class AgentHookServerRemoteRelaySessions extends AgentHookServerIngestStructuredChildren {
  protected readonly relaySessions = new RelaySessionGenerations()

  /** Call as each relay link starts, before its first envelope. */
  beginRemoteRelaySession(connectionId: string): void {
    this.relaySessions.begin(connectionId)
  }
}
