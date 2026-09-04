import { z } from 'zod'
import type { AgentType } from '../../../../shared/native-chat-types'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from '../../../native-chat/transcript-watch'
import {
  defineMethod,
  defineStreamingMethod,
  InvalidArgumentError,
  type RpcAnyMethod,
  type RpcContext
} from '../core'
import {
  MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  MOBILE_NATIVE_CHAT_MAX_WINDOW,
  sanitizeNativeChatAppend,
  windowNativeChatMessages
} from './native-chat-payload-window'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import {
  readRemoteNativeChatTranscriptTail,
  subscribeRemoteNativeChatTranscript
} from '../../../native-chat/remote-transcript-access'

// Why: native chat renders an agent's own transcript (Claude/Codex JSONL). The
// desktop reaches the readers via Electron IPC; mobile/web clients reach the
// same pure readers through these runtime RPC methods so the native chat view
// works over the paired connection, not just in the desktop renderer.

const NativeChatSession = z.object({
  agent: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing agent'))
    .transform((v) => v as AgentType),
  sessionId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing session id')),
  // How many of the most-recent messages to return. Clients start small for a
  // fast first paint and raise it to page older history in as the user scrolls.
  // Clamp (don't reject) a limit past the max window so a client paging beyond it
  // gets the capped tail and pagination stops cleanly — a hard `.max` rejection
  // would fail the read and stall "load earlier" at the boundary.
  limit: z
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, MOBILE_NATIVE_CHAT_MAX_WINDOW))
    .optional(),
  // Optional client-supplied cleanup token. When present, the subscribe handler
  // keys the fs-watcher cleanup under it so registration and unsubscribe derive
  // from the SAME token (back-compat: falls back to `agent:sessionId` when absent,
  // which is exactly what existing mobile clients rely on).
  subscriptionId: z.string().min(1).optional(),
  // Authoritative transcript path from the agent hook (providerSession), used to
  // locate the file directly when the session id no longer names it (recent
  // Claude Code). Optional for back-compat with older clients.
  transcriptPath: z.string().min(1).optional(),
  terminal: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  // A pending snapshot is not authoritative transcript history. Only clients
  // that advertise this semantic may receive one; legacy clients treat it as a
  // settled empty read and can overwrite retention / unblock launch drafts.
  capabilities: z.object({ transcriptPending: z.literal(1).optional() }).optional(),
  beforeOffset: z.number().int().nonnegative().optional()
})

const NativeChatUnsubscribe = z.object({
  subscriptionId: z.string().min(1).optional()
})

function resolveTraexSessionAccess(
  params: z.infer<typeof NativeChatSession>,
  runtime: RpcContext['runtime']
): { transcriptPath?: string; connectionId: string | null } | null {
  if (params.agent !== 'traex') {
    return null
  }
  if (!params.terminal || !params.worktree) {
    throw new InvalidArgumentError('TraeX chat requires terminal context')
  }
  const access = runtime.resolveNativeChatTraexSession(
    params.terminal,
    params.worktree,
    params.sessionId
  )
  if (!access) {
    throw new InvalidArgumentError('TraeX session is not confirmed for this terminal')
  }
  return access
}

function resolveTraexFilesystemProvider(connectionId: string | null) {
  if (!connectionId) {
    return null
  }
  const provider = getSshFilesystemProvider(connectionId)
  if (!provider) {
    throw new Error('TraeX transcript is unverifiable while the SSH target is disconnected')
  }
  return provider
}

export const NATIVE_CHAT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'nativeChat.readSession',
    params: NativeChatSession,
    handler: async (params, { runtime, clientKind, signal }) => {
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const traexAccess = resolveTraexSessionAccess(params, runtime)
      const remoteProvider = traexAccess
        ? resolveTraexFilesystemProvider(traexAccess.connectionId)
        : null
      const readArgs = {
        agent: params.agent,
        sessionId: params.sessionId,
        transcriptPath: traexAccess ? traexAccess.transcriptPath : params.transcriptPath,
        limit,
        beforeOffset: params.beforeOffset
      }
      const result = remoteProvider
        ? await readRemoteNativeChatTranscriptTail(remoteProvider, readArgs, signal)
        : await readNativeChatTranscriptTail(readArgs, signal)
      return 'messages' in result
        ? {
            messages: windowNativeChatMessages(result.messages, clientKind, limit),
            hasMore: result.hasMore,
            beforeOffset: result.beforeOffset,
            ...(result.lifecycle ? { lifecycle: result.lifecycle } : {})
          }
        : result
    }
  }),
  defineStreamingMethod({
    name: 'nativeChat.subscribe',
    params: NativeChatSession,
    handler: async (params, { runtime, connectionId, clientKind, signal }, emit) => {
      if (signal?.aborted) {
        return
      }
      let closed = false
      let unsubscribe = (): void => {}
      const setupController = new AbortController()
      // Why: the first drain is a bounded tail snapshot; later drains emit only
      // appended turns. This avoids parsing or shipping full long transcripts.
      // Clients merge by message id, so the initial windowed batch doubles as the
      // snapshot. Keyed by the client-supplied subscriptionId when present so
      // registration and unsubscribe derive from the same token; otherwise by
      // agent:sessionId, which is exactly the token existing mobile clients send to
      // unsubscribe (no wire break).
      const cleanupToken = params.subscriptionId ?? `${params.agent}:${params.sessionId}`
      const subscriptionId = `nativeChat:${connectionId ?? 'local'}:${cleanupToken}`
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const traexAccess = resolveTraexSessionAccess(params, runtime)
      const remoteProvider = traexAccess
        ? resolveTraexFilesystemProvider(traexAccess.connectionId)
        : null
      const cleanup = (): void => {
        if (closed) {
          return
        }
        closed = true
        signal?.removeEventListener('abort', handleAbort)
        setupController.abort()
        unsubscribe()
        emit({ type: 'end' })
      }
      function handleAbort(): void {
        runtime.cleanupSubscription(subscriptionId)
      }
      signal?.addEventListener('abort', handleAbort, { once: true })
      runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
      if (signal?.aborted) {
        runtime.cleanupSubscription(subscriptionId)
        return
      }
      if (closed) {
        return
      }
      const subscribeArgs: SubscribeNativeChatTranscriptArgs = {
        agent: params.agent,
        sessionId: params.sessionId,
        transcriptPath: traexAccess ? traexAccess.transcriptPath : params.transcriptPath,
        initialLimit: limit,
        onInitialSnapshot: (messages, hasMore, beforeOffset, error, lifecycle) => {
          if (closed) {
            return
          }
          // Forward an initial-drain error so a watching client's first frame carries it
          // instead of stranding the view at 'loading' when the read keeps throwing.
          emit({
            type: 'snapshot',
            messages: windowNativeChatMessages(messages, clientKind, limit),
            hasMore,
            beforeOffset,
            ...(error ? { error } : {}),
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        ...(params.capabilities?.transcriptPending === 1
          ? {
              onTranscriptPending: () => {
                if (!closed) {
                  emit({ type: 'snapshot', messages: [], hasMore: false, pending: true })
                }
              }
            }
          : {}),
        onReplace: (messages, hasMore, beforeOffset, lifecycle) => {
          if (closed) {
            return
          }
          emit({
            type: 'replacement',
            messages: windowNativeChatMessages(messages, clientKind, limit),
            hasMore,
            beforeOffset,
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onAppend: (messages, lifecycle) => {
          if (closed) {
            return
          }
          emit({
            type: 'appended',
            messages: sanitizeNativeChatAppend(messages, clientKind),
            ...(lifecycle ? { lifecycle } : {})
          })
        }
      }
      let subscription: NativeChatTranscriptSubscription
      try {
        subscription = remoteProvider
          ? await subscribeRemoteNativeChatTranscript(
              remoteProvider,
              subscribeArgs,
              setupController.signal
            )
          : await subscribeNativeChatTranscript(subscribeArgs, setupController.signal)
      } catch (error) {
        if (closed || setupController.signal.aborted) {
          return
        }
        throw error
      }
      // The connection may have closed while the file was being resolved.
      if (closed) {
        subscription.unsubscribe()
        return
      }
      if (!subscription.watching) {
        emit({
          type: 'snapshot',
          messages: [],
          hasMore: false,
          error: 'Transcript unavailable'
        })
      }
      unsubscribe = subscription.unsubscribe
    }
  }),
  defineMethod({
    name: 'nativeChat.unsubscribe',
    params: NativeChatUnsubscribe,
    handler: async (params, { runtime, connectionId }) => {
      const connection = connectionId ?? 'local'
      if (params.subscriptionId) {
        runtime.cleanupSubscription(`nativeChat:${connection}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      runtime.cleanupSubscriptionsByPrefix(`nativeChat:${connection}:`)
      return { unsubscribed: true }
    }
  })
]
