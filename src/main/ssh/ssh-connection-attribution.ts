/**
 * Which connect attempt opened a pooled SSH transport, and who has since taken it over. A
 * cancelled attempt may close only a transport it opened itself and no newer owner adopted: a
 * replacement connect or a managed tunnel can reuse the same pooled connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SshConnectOptions } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'

type SshConnectionScope = {
  owner: symbol
  connectOptions?: SshConnectOptions
}

const scope = new AsyncLocalStorage<SshConnectionScope>()
const openers = new WeakMap<SshConnection, symbol>()
const adopters = new WeakMap<SshConnection, symbol>()
// A tunnel built outside any connect attempt (a restore, a lifecycle action) owns its transport.
const BACKGROUND_OWNER = Symbol('ssh-connection-background-owner')

/** Runs `work` so any transport the pool opens inside it is attributed to `owner`. */
export function runAttributedToSshOwner<T>(
  owner: symbol,
  work: () => Promise<T>,
  connectOptions?: SshConnectOptions
): Promise<T> {
  return scope.run({ owner, connectOptions }, work)
}

/** The attempt or census whose work is running now, if any. */
export function currentSshOwner(): symbol | undefined {
  return scope.getStore()?.owner
}

/** The connect policy for transports opened within the current attributed operation. */
export function currentSshConnectOptions(): SshConnectOptions | undefined {
  return scope.getStore()?.connectOptions
}

/** Work that reuses a pooled transport relies on it, so it becomes that transport's latest owner. */
export function recordSshConnectionReused(connection: SshConnection): void {
  const owner = currentSshOwner()
  if (owner) {
    adopters.set(connection, owner)
  }
}

export function recordSshConnectionOpened(connection: SshConnection): void {
  const owner = currentSshOwner()
  if (owner) {
    openers.set(connection, owner)
  }
}

/** The latest user of a pooled transport; a tunnel outside any attempt counts as its own owner. */
export function adoptSshConnection(connection: SshConnection, owner?: symbol): void {
  adopters.set(connection, owner ?? currentSshOwner() ?? BACKGROUND_OWNER)
}

/** True only for a transport `owner` opened and nothing newer took over. */
export function isSshConnectionSolelyOwnedBy(connection: SshConnection, owner: symbol): boolean {
  return openers.get(connection) === owner && (adopters.get(connection) ?? owner) === owner
}

// Targets a census outside any connect is dialing; their raw 'connected' is not a session.
const censusing = new Map<string, number>()

export function beginSshHostCensus(targetId: string): () => void {
  censusing.set(targetId, (censusing.get(targetId) ?? 0) + 1)
  return () => censusing.set(targetId, (censusing.get(targetId) ?? 1) - 1)
}

export function isSshHostCensusInFlight(targetId: string): boolean {
  return (censusing.get(targetId) ?? 0) > 0
}
