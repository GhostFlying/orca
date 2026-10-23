import type { TuiAgent } from './agent-launch/catalog/tui-agent'
import { isTuiAgent } from './agent-launch/catalog/tui-agent-config'

// Observed product identities remain distinct; readiness uses their shared TUI catalog.
export function resolveAgentReadinessIdentity(agent: unknown): TuiAgent | null {
  if (agent === 'traex') {
    return 'trae'
  }
  return isTuiAgent(agent) ? agent : null
}
