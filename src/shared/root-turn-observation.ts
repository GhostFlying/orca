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

/** Validate additive relay metadata without exposing arbitrary provider data. */
export function normalizeRootTurnObservation(value: unknown): RootTurnObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const r = Object.fromEntries(Object.entries(value))
  if (
    r.version !== 1 ||
    r.source !== 'native-api' ||
    typeof r.retryable !== 'boolean' ||
    typeof r.sessionId !== 'string' ||
    !r.sessionId ||
    r.sessionId.length > 256 ||
    typeof r.turnId !== 'string' ||
    !r.turnId ||
    r.turnId.length > 256 ||
    typeof r.paneKey !== 'string' ||
    r.paneKey.length > 1024 ||
    typeof r.launchId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.launchId) ||
    typeof r.startedAt !== 'number' ||
    !Number.isFinite(r.startedAt) ||
    r.startedAt < 0 ||
    typeof r.observedAt !== 'number' ||
    !Number.isFinite(r.observedAt) ||
    r.observedAt < 0
  ) {
    return undefined
  }
  const state =
    r.state === 'running' ||
    r.state === 'completed' ||
    r.state === 'failed' ||
    r.state === 'cancelled' ||
    r.state === 'unknown'
      ? r.state
      : undefined
  const operations =
    r.operations === 'settled' || r.operations === 'pending' || r.operations === 'unknown'
      ? r.operations
      : undefined
  if (!state || !operations) {
    return undefined
  }
  return {
    version: 1,
    source: 'native-api',
    sessionId: r.sessionId,
    turnId: r.turnId,
    paneKey: r.paneKey,
    launchId: r.launchId,
    startedAt: r.startedAt,
    observedAt: r.observedAt,
    state,
    operations,
    retryable: r.retryable,
    ...(typeof r.completedAt === 'number' && Number.isFinite(r.completedAt) && r.completedAt > 0
      ? { completedAt: r.completedAt }
      : {}),
    ...(typeof r.hostStartedAt === 'number' &&
    Number.isFinite(r.hostStartedAt) &&
    r.hostStartedAt > 0
      ? { hostStartedAt: r.hostStartedAt }
      : {}),
    ...(typeof r.errorCode === 'string' && /^[a-z_]{1,64}$/.test(r.errorCode)
      ? { errorCode: r.errorCode }
      : {})
  }
}

/** A read failure cannot erase an already observed immutable root ending. */
export function mergeRootTurnObservation(
  previous: RootTurnObservation | undefined,
  incoming: RootTurnObservation
): RootTurnObservation {
  if (
    incoming.state !== 'unknown' ||
    !previous ||
    previous.sessionId !== incoming.sessionId ||
    previous.turnId !== incoming.turnId ||
    previous.launchId !== incoming.launchId ||
    previous.paneKey !== incoming.paneKey ||
    previous.state === 'running' ||
    previous.state === 'unknown'
  ) {
    return incoming
  }
  return {
    ...previous,
    observedAt: incoming.observedAt,
    operations: 'unknown',
    errorCode: incoming.errorCode ?? 'observation_unavailable',
    retryable: false
  }
}
