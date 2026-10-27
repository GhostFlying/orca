export type RootTurnObservation = {
  /** Host-owned terminal launch fingerprint; never the hook credential. */
  launchId?: string
  paneKey?: string
  version: 1
  sessionId: string
  turnId: string
  observedAt: number
  /** Host turn boundary preserves subsecond send ordering; native time is seconds. */
  hostStartedAt?: number
  startedAt: number
  completedAt?: number
  source: 'native-api'
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  operations: 'settled' | 'pending' | 'unknown'
  errorCode?: string
  retryable: boolean
}
