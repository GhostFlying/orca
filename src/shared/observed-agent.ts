import type { TerminalAgent } from './terminal-agent'

/** Agent identities Orca can observe even when it cannot launch them. */
export type ObservedAgent = TerminalAgent | 'traex'
