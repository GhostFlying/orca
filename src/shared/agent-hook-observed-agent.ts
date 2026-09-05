import type { AgentHookSource } from './agent-hook-relay'

export type AgentHookObservedAgent = 'traex'

export function readAgentHookObservedAgent(value: unknown): AgentHookObservedAgent | undefined {
  return value === 'traex' ? value : undefined
}

export function resolveObservedHookSource(source: AgentHookSource, body: unknown): AgentHookSource {
  if (
    source !== 'trae' ||
    typeof body !== 'object' ||
    body === null ||
    !('observedAgent' in body)
  ) {
    return source
  }
  return readAgentHookObservedAgent(body.observedAgent) ?? source
}
