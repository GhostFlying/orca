import type { z } from 'zod'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from '../../../native-chat/transcript-watch'
import { defineMethod, defineStreamingMethod, InvalidArgumentError, type RpcContext } from '../core'
import {
  MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  sanitizeNativeChatAppend,
  windowNativeChatMessages
} from './native-chat-payload-window'
import {
  NativeChatSession,
  NativeChatUnsubscribe
} from '../../../../shared/rpc-contract/native-chat-params'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import {
  readRemoteNativeChatTranscriptTail,
  subscribeRemoteNativeChatTranscript
} from '../../../native-chat/remote-transcript-access'

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

export const NATIVE_CHAT_METHODS = [
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
