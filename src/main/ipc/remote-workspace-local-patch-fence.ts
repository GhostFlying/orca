import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import { remoteWorkspaceSessionMatchesSnapshot } from './remote-workspace-snapshot-normalization'

export type PendingLocalRemoteWorkspacePatch = {
  targetId: string
  namespace: string
  baseRevision: number
  session: RemoteWorkspaceSession
}

const pendingLocalPatchByTargetId = new Map<string, PendingLocalRemoteWorkspacePatch>()

export function beginPendingLocalRemoteWorkspacePatch(
  patch: PendingLocalRemoteWorkspacePatch
): PendingLocalRemoteWorkspacePatch {
  pendingLocalPatchByTargetId.set(patch.targetId, patch)
  return patch
}

export function endPendingLocalRemoteWorkspacePatch(patch: PendingLocalRemoteWorkspacePatch): void {
  if (pendingLocalPatchByTargetId.get(patch.targetId) === patch) {
    pendingLocalPatchByTargetId.delete(patch.targetId)
  }
}

export function snapshotMatchesPendingLocalRemoteWorkspacePatch(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): boolean {
  const pending = pendingLocalPatchByTargetId.get(targetId)
  return (
    pending !== undefined &&
    snapshot.namespace === pending.namespace &&
    snapshot.revision === pending.baseRevision + 1 &&
    remoteWorkspaceSessionMatchesSnapshot(snapshot, pending.session)
  )
}

export function clearPendingLocalRemoteWorkspacePatches(): void {
  pendingLocalPatchByTargetId.clear()
}

export function getPendingLocalRemoteWorkspacePatchCount(): number {
  return pendingLocalPatchByTargetId.size
}
