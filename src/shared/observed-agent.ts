import type { TuiAgent } from './tui-agent'

/** Agent identities Orca can observe even when it cannot launch them. */
export type ObservedAgent = TuiAgent | 'traex'
