import type {
  DirectSshAuthority,
  SshConnectOptions,
  SshConnectionState
} from '../../shared/ssh-types'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { createCancelledConnectAttemptError } from '../ssh/ssh-connect-attempt-cancellation'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../ssh/ssh-provider-authority'

// Why: keep this outside registerSshHandlers so a BrowserWindow recreation mid-connect doesn't split credential tracking.
export const credentialRequestedForTarget = new Set<string>()

// Why: tabs must share one connect, while a disconnect must invalidate that
// attempt so its late continuation cannot clobber a replacement.
export type ConnectAttempt = {
  authority: DirectSshAuthority
  nonInteractive: boolean
  promise: Promise<SshConnectionState>
}

export const connectInFlight = new Map<string, ConnectAttempt>()
export const pendingTransportReconnects = new Set<string>()

export function runSharedSshConnectAttempt(
  targetId: string,
  options: SshConnectOptions,
  admissionAuthority: DirectSshAuthority,
  start: (replacePendingTransport: boolean) => Promise<SshConnectionState>
): Promise<SshConnectionState> {
  const existing = connectInFlight.get(targetId)
  if (existing && isCurrentConnectAttempt(targetId, existing.authority)) {
    if (existing.nonInteractive === (options.nonInteractive === true)) {
      return existing.promise
    }
    if (options.nonInteractive === true) {
      throw new Error('An interactive SSH connection attempt is already in progress.')
    }
    return existing.promise.catch(() =>
      runSharedSshConnectAttempt(targetId, options, getSshProviderAuthority(targetId), start)
    )
  }
  if (!isCurrentConnectAttempt(targetId, admissionAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  let replacePendingTransport = false
  if (existing && connectInFlight.get(targetId) === existing) {
    connectInFlight.delete(targetId)
    replacePendingTransport = true
  }
  if (!isCurrentSshProviderAuthority(admissionAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  const promise = start(replacePendingTransport)
  const attempt = {
    authority: getSshProviderAuthority(targetId),
    nonInteractive: options.nonInteractive === true,
    promise
  }
  connectInFlight.set(targetId, attempt)
  return promise.finally(() => {
    if (connectInFlight.get(targetId) === attempt) {
      connectInFlight.delete(targetId)
    }
  })
}

// Why the quit gate rather than a local latch: "the committed quit has begun" already has an owner,
// and a private copy could be set by something that is not actually quitting — leaving SSH connects
// refused for the rest of the process lifetime.
export function assertSshConnectsNotFenced(): void {
  if (quitTeardownStartGate.hasStarted()) {
    throw new Error('SSH connects are closed for app shutdown')
  }
}

export function invalidateConnectAttempt(targetId: string): void {
  rotateSshProviderAuthority(targetId)
  pendingTransportReconnects.delete(targetId)
  connectInFlight.delete(targetId)
  credentialRequestedForTarget.delete(targetId)
}

export function isCurrentConnectAttempt(targetId: string, authority: DirectSshAuthority): boolean {
  return authority.targetId === targetId && isCurrentSshProviderAuthority(authority)
}

// Why: publish reset's teardown/force-stop/disconnect lifecycle so new connects and duplicate resets can't race it.
export const resetRelayInFlight = new Map<string, Promise<void>>()

// Why: ssh:testConnection connects then disconnects; suppressing broadcasts during the test avoids worktree cards flashing connected → disconnected.
export const testingTargets = new Set<string>()
export const testConnectionProbes = new Set<Promise<unknown>>()
const testConnectionProbesByTarget = new Map<string, Set<Promise<unknown>>>()

export function hasSshTestConnectionProbes(targetId: string): boolean {
  return (testConnectionProbesByTarget.get(targetId)?.size ?? 0) > 0
}

export function runSshTestConnectionProbe<T>(
  targetId: string,
  operation: () => Promise<T>
): Promise<T> {
  const probes = testConnectionProbesByTarget.get(targetId) ?? new Set<Promise<unknown>>()
  let probe!: Promise<T>
  // Publish before connection callbacks can start a reset or shutdown drain.
  probe = Promise.resolve()
    .then(operation)
    .finally(() => {
      testConnectionProbes.delete(probe)
      probes.delete(probe)
      if (probes.size === 0 && testConnectionProbesByTarget.get(targetId) === probes) {
        testConnectionProbesByTarget.delete(targetId)
        testingTargets.delete(targetId)
        credentialRequestedForTarget.delete(targetId)
      }
    })
  probes.add(probe)
  testConnectionProbesByTarget.set(targetId, probes)
  testConnectionProbes.add(probe)
  testingTargets.add(targetId)
  return probe
}

/** Reserve target admission before joining; failed probes still own cleanup until settled. */
export async function awaitSshTestConnectionProbes(targetId: string): Promise<void> {
  while (true) {
    const probes = testConnectionProbesByTarget.get(targetId)
    if (!probes?.size) {
      return
    }
    await Promise.allSettled(probes)
  }
}
