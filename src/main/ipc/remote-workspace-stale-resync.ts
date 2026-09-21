import type { RemoteWorkspaceObservedSnapshot } from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import { fetchRemoteSnapshot } from './remote-workspace-relay-sync'
import {
  getCachedRemoteWorkspaceSnapshot,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { remoteWorkspaceSessionMatchesSnapshot } from './remote-workspace-snapshot-normalization'
import { snapshotMatchesPendingLocalRemoteWorkspacePatch } from './remote-workspace-local-patch-fence'

type PendingResync = { promise: Promise<void>; requeued: boolean }

const pendingByTargetId = new Map<string, PendingResync>()

export function _resetRemoteWorkspaceStaleResyncForTests(): void {
  pendingByTargetId.clear()
}

export function isRemoteWorkspaceResyncInFlight(targetId: string): boolean {
  return pendingByTargetId.has(targetId)
}

/**
 * The relay told us it could not deliver a snapshot, so pull it. `workspace.get` is a response, and
 * responses are admitted against the megabyte-scale control/legacy-response budget rather than the
 * single ~12KB producer frame that refused the broadcast — the payload was never too big for the
 * link, only for that one lane.
 */
export function resyncStaleRemoteWorkspace(
  target: SshTarget,
  deliver: (snapshot: RemoteWorkspaceObservedSnapshot) => void,
  onError: (error: unknown) => void = () => {}
): Promise<void> {
  const existing = pendingByTargetId.get(target.id)
  if (existing) {
    // Why: a burst of markers must collapse to one extra read, but never to zero — a marker that
    // arrived while a read was already in flight may describe a revision that read did not see.
    existing.requeued = true
    return existing.promise
  }
  const pending: PendingResync = { requeued: false, promise: Promise.resolve() }
  pending.promise = (async () => {
    try {
      do {
        pending.requeued = false
        const rawSnapshot = await fetchRemoteSnapshot(target)
        if (!rawSnapshot) {
          return
        }
        const current = getCachedRemoteWorkspaceSnapshot(target.id)
        if (snapshotMatchesPendingLocalRemoteWorkspacePatch(target.id, rawSnapshot)) {
          rememberLocallyPatchedRemoteWorkspaceSnapshot(target.id, rawSnapshot)
          continue
        }
        const snapshot = rememberRemoteWorkspaceSnapshot(target.id, rawSnapshot)
        // Suppress the echo: our own patch response already cached this session, and re-publishing it
        // makes the renderer rehydrate a state it authored.
        if (remoteWorkspaceSessionMatchesSnapshot(current, snapshot.session)) {
          continue
        }
        deliver(snapshot)
      } while (pending.requeued)
    } catch (error) {
      onError(error)
    } finally {
      pendingByTargetId.delete(target.id)
    }
  })()
  pendingByTargetId.set(target.id, pending)
  return pending.promise
}
