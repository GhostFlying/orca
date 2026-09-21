import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type { RemoteWorkspaceSnapshotPlacementStore } from './remote-workspace-snapshot-placement'

export function createRemoteWorkspaceSnapshotConflictMarker(
  store: RemoteWorkspaceSnapshotPlacementStore,
  isArrivalCurrent: (targetId: string, arrival: number) => boolean
): (
  authority: DirectSshAuthority,
  snapshot: RemoteWorkspaceObservedSnapshot,
  arrival: number
) => void {
  return (authority, snapshot, arrival) => {
    if (!isArrivalCurrent(authority.targetId, arrival)) {
      return
    }
    const state = store.getState()
    state.clearRemoteWorkspaceHydrated(authority.targetId)
    state.setRemoteWorkspaceSyncStatus(authority.targetId, {
      phase: 'conflict',
      direction: 'pull',
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      hostObservationToken: snapshot.hostObservationToken
    })
  }
}
