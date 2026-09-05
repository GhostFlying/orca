import type { z } from 'zod'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from '../../../native-chat/transcript-watch'
import {
  nativeChatTranscriptPathOnExecutionHost,
  toSshTranscriptPath
} from '../../../native-chat/ssh-transcript-path'
import { resolveRemoteTraexTranscriptPath } from '../../../native-chat/remote-traex-transcript-path'
import { defineMethod, defineStreamingMethod, InvalidArgumentError, type RpcContext } from '../core'
import {
  MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  pageNativeChatMessages,
  sanitizeNativeChatAppend
} from './native-chat-payload-window'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat-agent-support'
import { nativeChatRpcAppendBatches } from './native-chat-rpc-page-bounds'
import {
  NativeChatSession,
  NativeChatUnsubscribe
} from '../../../../shared/rpc-contract/native-chat-params'
import { requireSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'

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

async function resolveNativeChatTranscriptPath(
  params: z.infer<typeof NativeChatSession>,
  runtime: RpcContext['runtime'],
  signal?: AbortSignal
): Promise<{ transcriptPath?: string; unavailable?: true }> {
  const traexAccess = resolveTraexSessionAccess(params, runtime)
  if (!traexAccess) {
    return {
      transcriptPath: nativeChatTranscriptPathOnExecutionHost(
        runtime.getAgentProviderSessionRows(),
        params.sessionId,
        params.transcriptPath
      )
    }
  }
  if (!traexAccess.connectionId) {
    return { transcriptPath: traexAccess.transcriptPath }
  }
  const remotePath =
    traexAccess.transcriptPath ??
    (await resolveRemoteTraexTranscriptPath(
      requireSshFilesystemProvider(traexAccess.connectionId),
      params.sessionId,
      signal
    ))
  return remotePath
    ? { transcriptPath: toSshTranscriptPath(traexAccess.connectionId, remotePath) }
    : { unavailable: true }
}

export const NATIVE_CHAT_METHODS = [
  defineMethod({
    name: 'nativeChat.readSession',
    permission: 'workspace',
    params: NativeChatSession,
    handler: async (params, { runtime, clientKind, signal }) => {
      const limit = params.limit ?? MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
      const transcript = await resolveNativeChatTranscriptPath(params, runtime, signal)
      if (transcript.unavailable) {
        return { error: 'Transcript unavailable', notFound: true }
      }
      const result = await readNativeChatTranscriptTail(
        {
          agent: params.agent,
          sessionId: params.sessionId,
          transcriptPath: transcript.transcriptPath,
          limit,
          beforeOffset: params.beforeOffset
        },
        signal
      )
      return 'messages' in result
        ? {
            ...pageNativeChatMessages(
              result.messages,
              result.hasMore,
              result.beforeOffset,
              clientKind,
              limit,
              params.agent
            ),
            ...(result.lifecycle ? { lifecycle: result.lifecycle } : {})
          }
        : result
    }
  }),
  defineStreamingMethod({
    name: 'nativeChat.subscribe',
    permission: 'workspace',
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
      const transcript = await resolveNativeChatTranscriptPath(params, runtime, signal)
      if (transcript.unavailable) {
        emit({ type: 'snapshot', messages: [], hasMore: false, error: 'Transcript unavailable' })
        return
      }
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
        transcriptPath: transcript.transcriptPath,
        initialLimit: limit,
        onInitialSnapshot: (messages, hasMore, beforeOffset, error, lifecycle) => {
          if (closed) {
            return
          }
          // Forward an initial-drain error so a watching client's first frame carries it
          // instead of stranding the view at 'loading' when the read keeps throwing.
          emit({
            type: 'snapshot',
            ...pageNativeChatMessages(
              messages,
              hasMore,
              beforeOffset,
              clientKind,
              limit,
              params.agent
            ),
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
            ...pageNativeChatMessages(
              messages,
              hasMore,
              beforeOffset,
              clientKind,
              limit,
              params.agent
            ),
            ...(lifecycle ? { lifecycle } : {})
          })
        },
        onAppend: (messages, lifecycle) => {
          if (closed) {
            return
          }
          const sanitized = sanitizeNativeChatAppend(messages, clientKind)
          const batches =
            sanitized.length > 0 && resolveNativeChatTranscriptAgent(params.agent) === 'opencode'
              ? nativeChatRpcAppendBatches(sanitized)
              : [sanitized]
          for (const batch of batches) {
            emit({
              type: 'appended',
              messages: batch,
              ...(lifecycle && batch === batches.at(-1) ? { lifecycle } : {})
            })
          }
        }
      }
      let subscription: NativeChatTranscriptSubscription
      try {
        subscription = await subscribeNativeChatTranscript(subscribeArgs, setupController.signal)
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
    permission: 'workspace',
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
