import type { AgentHookSource } from './agent-hook-relay'

export type AgentHookObservedAgent = 'traex'

export function readAgentHookObservedAgent(value: unknown): AgentHookObservedAgent | undefined {
  return value === 'traex' ? value : undefined
}

export function resolveObservedHookSource(source: AgentHookSource, body: unknown): AgentHookSource {
  if (source !== 'trae' || typeof body !== 'object' || body === null) {
    return source
  }
  return readAgentHookObservedAgent((body as Record<string, unknown>).observedAgent) ?? source
}
