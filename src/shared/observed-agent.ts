import type { TerminalAgent } from './agent-status/identity/terminal-agent'

/** Agent identities Orca can observe even when it cannot launch them. */
export type ObservedAgent = TerminalAgent | 'traex'
