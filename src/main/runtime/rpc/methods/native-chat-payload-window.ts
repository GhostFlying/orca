import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { RpcContext } from '../core'
import { sanitizeNativeChatRpcBlock } from './native-chat-rpc-block-sanitize'

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
