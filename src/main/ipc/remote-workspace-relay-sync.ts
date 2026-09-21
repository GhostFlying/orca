import type {
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getActiveMultiplexer } from './ssh'
import { CLIENT_ID } from './remote-workspace-client-identity'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import {
  getCachedRemoteWorkspaceSnapshot,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import {
  normalizeSnapshot,
  remoteWorkspaceSessionMatchesSnapshot
} from './remote-workspace-snapshot-normalization'
import {
  beginPendingLocalRemoteWorkspacePatch,
  endPendingLocalRemoteWorkspacePatch
} from './remote-workspace-local-patch-fence'

export async function fetchRemoteSnapshot(
  target: SshTarget
): Promise<RemoteWorkspaceSnapshot | null> {
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  try {
    const raw = await mux.request('workspace.get', { namespace })
    return normalizeSnapshot(raw, namespace)
  } catch (err) {
    if ((err as { code?: unknown })?.code === -32601) {
      return null
    }
    throw err
  }
}

export async function getRemoteSnapshot(
  target: SshTarget
): Promise<RemoteWorkspaceObservedSnapshot | null> {
  const snapshot = await fetchRemoteSnapshot(target)
  return snapshot ? rememberRemoteWorkspaceSnapshot(target.id, snapshot) : null
}

function observePatchResult(
  targetId: string,
  result: RemoteWorkspacePatchResult
): RemoteWorkspaceObservedPatchResult {
  if (result.ok) {
    return {
      ok: true,
      snapshot: rememberLocallyPatchedRemoteWorkspaceSnapshot(targetId, result.snapshot)
    }
  }
  const failure = {
    ok: false as const,
    reason: result.reason,
    ...(result.message !== undefined ? { message: result.message } : {})
  }
  return result.snapshot
    ? {
        ...failure,
        snapshot: rememberRemoteWorkspaceSnapshot(targetId, result.snapshot)
      }
    : failure
}

function normalizePatchResult(raw: unknown, namespace: string): RemoteWorkspacePatchResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('ok' in raw)) {
    return { ok: false, reason: 'unavailable', message: 'Invalid remote workspace patch response' }
  }
  if (
    raw.ok === true &&
    'snapshot' in raw &&
    raw.snapshot !== null &&
    typeof raw.snapshot === 'object' &&
    !Array.isArray(raw.snapshot)
  ) {
    return { ok: true, snapshot: normalizeSnapshot(raw.snapshot, namespace) }
  }
  if (raw.ok !== false) {
    return { ok: false, reason: 'unavailable', message: 'Invalid remote workspace patch response' }
  }
  const reason =
    'reason' in raw && raw.reason === 'stale-revision' ? 'stale-revision' : 'unavailable'
  const message = 'message' in raw && typeof raw.message === 'string' ? raw.message : undefined
  const snapshot =
    'snapshot' in raw &&
    raw.snapshot !== null &&
    typeof raw.snapshot === 'object' &&
    !Array.isArray(raw.snapshot)
      ? normalizeSnapshot(raw.snapshot, namespace)
      : undefined
  return {
    ok: false,
    reason,
    ...(message !== undefined ? { message } : {}),
    ...(snapshot !== undefined ? { snapshot } : {})
  }
}

export async function patchRemoteWorkspaceSession(
  target: SshTarget,
  session: RemoteWorkspaceSession
): Promise<RemoteWorkspaceObservedPatchResult | null> {
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const current =
    getCachedRemoteWorkspaceSnapshot(target.id) ?? (await getRemoteSnapshot(target)) ?? undefined
  if (current && remoteWorkspaceSessionMatchesSnapshot(current, session)) {
    // Why: a pulled workspace snapshot rehydrates local state and can trigger
    // session persistence. Identical target sessions must stay a local no-op or
    // two clients will echo revisions indefinitely.
    return { ok: true, snapshot: current }
  }

  const requestPatch = async (
    baseRevision: number | undefined
  ): Promise<RemoteWorkspaceObservedPatchResult> => {
    const resolvedBaseRevision = baseRevision ?? 0
    const pending = beginPendingLocalRemoteWorkspacePatch({
      targetId: target.id,
      namespace,
      baseRevision: resolvedBaseRevision,
      session
    })
    try {
      const rawResult = await mux.request('workspace.patch', {
        namespace,
        baseRevision: resolvedBaseRevision,
        clientId: CLIENT_ID,
        patch: { kind: 'replace-session', session }
      })
      const result = normalizePatchResult(rawResult, namespace)
      return observePatchResult(target.id, result)
    } catch (err) {
      return (err as { code?: unknown })?.code === -32601
        ? {
            ok: false,
            reason: 'unavailable',
            message: 'Remote workspace sync is unavailable on this relay'
          }
        : {
            ok: false,
            reason: 'unavailable',
            message: err instanceof Error ? err.message : 'Remote workspace sync failed'
          }
    } finally {
      endPendingLocalRemoteWorkspacePatch(pending)
    }
  }

  const result = await requestPatch(current?.revision)
  if (result.ok) {
    return result
  }

  if (
    result.reason === 'stale-revision' &&
    current &&
    result.snapshot &&
    result.snapshot.revision < current.revision
  ) {
    if (remoteWorkspaceSessionMatchesSnapshot(result.snapshot, session)) {
      return { ok: true, snapshot: result.snapshot }
    }
    // Why: a relay reset can legitimately move the remote snapshot revision
    // backwards while this process still has the old cached revision. Retrying
    // only for backwards revisions restores the blank-slate target without
    // overwriting a newer snapshot from another device.
    return requestPatch(result.snapshot.revision)
  }

  return result
}
