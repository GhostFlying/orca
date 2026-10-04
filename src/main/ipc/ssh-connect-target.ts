import { appendFileSync } from 'node:fs'
import type { SshConnectOptions, SshConnectionState } from '../../shared/ssh-types'
import { createCancelledConnectAttemptError } from '../ssh/ssh-connect-attempt-cancellation'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from '../ssh/ssh-provider-authority'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  isCurrentConnectAttempt,
  pendingTransportReconnects,
  resetRelayInFlight
} from './ssh-connect-attempt-registry'
import { doConnect } from './ssh-connect-flow'
import { awaitTargetLifecycle } from './ssh-target-lifecycle-queue'

/** Background callers can require a connect attempt that never prompts. */
export async function connectTarget(
  targetId: string,
  options: SshConnectOptions = {}
): Promise<SshConnectionState> {
  const e2eProbePath = process.env.ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE
  if (e2eProbePath) {
    appendFileSync(e2eProbePath, `${JSON.stringify(targetId)}\n`)
    throw new Error('e2e_forbidden_local_ssh_connect')
  }
  // Why: fence callers that entered before a same-turn disconnect/reset but resume after its cleanup.
  let admissionAuthority = getSshProviderAuthority(targetId)
  await awaitTargetLifecycle(targetId)
  const reset = resetRelayInFlight.get(targetId)
  if (reset) {
    await reset
  }

  // Why: serialize concurrent ssh:connect for the same target; interleaved connects otherwise leak the first session.
  const existing = connectInFlight.get(targetId)
  let replacePendingTransport = false
  if (existing && isCurrentConnectAttempt(targetId, existing.authority)) {
    if (existing.nonInteractive === (options.nonInteractive === true)) {
      return existing.promise
    }
    if (options.nonInteractive === true) {
      throw new Error('An interactive SSH connection attempt is already in progress.')
    }
    try {
      // Why: an interactive caller may accept a successful background attempt, but after failure
      // it must retry with prompts enabled instead of inheriting the background policy.
      return await existing.promise
    } catch {
      admissionAuthority = getSshProviderAuthority(targetId)
    }
  }
  if (!isCurrentConnectAttempt(targetId, admissionAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  const observedAuthority = admissionAuthority
  if (existing && connectInFlight.get(targetId) === existing) {
    connectInFlight.delete(targetId)
    replacePendingTransport = true
  }
  if (!isCurrentSshProviderAuthority(observedAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  // Why: the shutdown drain fences and snapshots synchronously, so a connect either registers in
  // connectInFlight below (and gets joined) or fails here — it can never slip between the two.
  assertSshConnectsNotFenced()

  pendingTransportReconnects.delete(targetId)
  const promise = doConnect(targetId, replacePendingTransport, options)
  const attempt = {
    authority: getSshProviderAuthority(targetId),
    nonInteractive: options.nonInteractive === true,
    promise
  }
  connectInFlight.set(targetId, attempt)
  try {
    return await promise
  } finally {
    if (connectInFlight.get(targetId) === attempt) {
      connectInFlight.delete(targetId)
    }
  }
}
