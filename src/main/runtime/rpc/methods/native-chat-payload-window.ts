import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat-agent-support'
import type { RpcContext } from '../core'
import { sanitizeNativeChatRpcBlock } from './native-chat-rpc-block-sanitize'
import { boundNativeChatRpcPageByBytes } from './native-chat-rpc-page-bounds'

export const MOBILE_NATIVE_CHAT_DEFAULT_WINDOW = 40
export const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000

function sanitizeMessage(
  message: NativeChatMessage,
  clientKind: RpcContext['clientKind']
): NativeChatMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) => sanitizeNativeChatRpcBlock(block, clientKind))
  }
}

export function sanitizeNativeChatAppend(
  messages: readonly NativeChatMessage[],
  clientKind: RpcContext['clientKind']
): NativeChatMessage[] {
  return messages.map((message) => sanitizeMessage(message, clientKind))
}

export function windowNativeChatMessages(
  messages: readonly NativeChatMessage[],
  clientKind: RpcContext['clientKind'],
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW
): NativeChatMessage[] {
  const window = Math.min(Math.max(limit, 1), MOBILE_NATIVE_CHAT_MAX_WINDOW)
  const windowed = messages.length > window ? messages.slice(-window) : messages.slice()
  return windowed.map((message) => sanitizeMessage(message, clientKind))
}

export function pageNativeChatMessages(
  messages: readonly NativeChatMessage[],
  hasMore: boolean,
  beforeOffset: number,
  clientKind: RpcContext['clientKind'],
  limit = MOBILE_NATIVE_CHAT_DEFAULT_WINDOW,
  agent?: string
): { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number } {
  const isOpenCode = resolveNativeChatTranscriptAgent(agent) === 'opencode'
  const sanitized = isOpenCode
    ? sanitizeNativeChatAppend(messages, clientKind)
    : windowNativeChatMessages(messages, clientKind, limit)
  return isOpenCode
    ? boundNativeChatRpcPageByBytes(sanitized, hasMore, beforeOffset)
    : { messages: sanitized, hasMore, beforeOffset }
}
