import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

// Observed product identities remain distinct; readiness uses their shared TUI catalog.
export function resolveAgentReadinessIdentity(agent: unknown): TuiAgent | null {
  if (agent === 'traex') {
    return 'trae'
  }
  return isTuiAgent(agent) ? agent : null
}
