import type { MutableRefObject } from 'react'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTranscriptPage } from '../../../../src/shared/native-chat/transcript/streaming/native-chat-transcript-frames'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { nativeChatSessionPageRead } from './agent-session/mobile-native-chat-page-read-operations'
import { MAX_MESSAGES, nativeChatTarget, nextPageWindow } from './mobile-native-chat-read-request'

type ReadSessionResult =
  | (Pick<NativeChatTranscriptPage, 'messages'> &
      Partial<Pick<NativeChatTranscriptPage, 'hasMore' | 'beforeOffset'>>)
  | { error: string }

export async function readEarlierNativeChatPage(args: {
  client: RpcClient
  agent: string
  sessionId: string
  transcriptPath: string | null
  terminal: string | null
  worktree: string | null
  getList: () => readonly NativeChatMessage[]
  limitRef: MutableRefObject<number>
  beforeOffset: number | null
  beforeOffsetRef: MutableRefObject<number | null>
  sessionIdRef: MutableRefObject<string | null>
  requestSessionId: string
  isCurrent: () => boolean
  timeoutMs: number
  setList: (next: readonly NativeChatMessage[]) => void
  setHasMore: (value: boolean) => void
}): Promise<'end' | 'failed' | 'drew'> {
  const page = nextPageWindow(args.limitRef.current, args.getList().length)
  if (!page) {
    args.setHasMore(false)
    return 'end'
  }
  const { nextLimit, pageLimit } = page
  const response = await nativeChatSessionPageRead.request(
    args.client,
    {
      ...nativeChatTarget({
        agent: args.agent,
        sessionId: args.sessionId,
        terminal: args.terminal,
        worktree: args.worktree
      }),
      limit: args.beforeOffset === null ? nextLimit : pageLimit,
      capabilities: { transcriptSourceOrder: 1 },
      ...(args.beforeOffset === null ? {} : { beforeOffset: args.beforeOffset }),
      ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {})
    },
    { timeoutMs: args.timeoutMs, budgetSpansConnect: true }
  )
  const accepted = nativeChatSessionPageRead.interpret(response)
  if (!accepted.accepted) {
    return 'failed'
  }
  // Accepted legacy-union replies may be absent/null; validate before using the in operator.
  const payload = accepted.value
  if (payload === null || typeof payload !== 'object') {
    return 'failed'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main cast this payload unread; the reader hands back the same result.
  const result = payload as ReadSessionResult
  if ('error' in result) {
    return 'failed'
  }
  // Apply pages only to their captured window/cursor; otherwise retry from the new window.
  if (
    !args.isCurrent() ||
    args.sessionIdRef.current !== args.requestSessionId ||
    args.beforeOffsetRef.current !== args.beforeOffset
  ) {
    return 'end'
  }
  args.limitRef.current = nextLimit
  let more: boolean
  if (args.beforeOffset !== null && result.beforeOffset != null) {
    args.beforeOffsetRef.current = result.beforeOffset
    args.setList([...result.messages, ...args.getList()])
    more = nextLimit < MAX_MESSAGES && (result.hasMore ?? result.messages.length >= pageLimit)
  } else {
    // Legacy hosts return a growing tail instead of cursor pages; preserve rows streamed during the read.
    const live = args.getList()
    const after = live.findIndex((message) => message.id === result.messages.at(-1)?.id)
    args.setList(after === -1 ? result.messages : [...result.messages, ...live.slice(after + 1)])
    more = result.messages.length >= nextLimit
  }
  args.setHasMore(more)
  return more ? 'drew' : 'end'
}
