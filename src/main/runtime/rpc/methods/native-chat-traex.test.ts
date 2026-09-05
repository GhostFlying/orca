import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

const localRead = vi.hoisted<{ args: Record<string, unknown> | null }>(() => ({ args: null }))
const sshFilesystemProvider = vi.hoisted<{ value: unknown }>(() => ({ value: null }))
const remoteTraexPath = vi.hoisted<{ value: string | null }>(() => ({ value: null }))

vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: (args: Record<string, unknown>) => {
    localRead.args = args
    return Promise.resolve({ messages: [], hasMore: false, beforeOffset: 0 })
  },
  subscribeNativeChatTranscript: vi.fn(async () => ({ unsubscribe: vi.fn(), watching: true }))
}))
vi.mock('../../../native-chat/remote-traex-transcript-path', () => ({
  resolveRemoteTraexTranscriptPath: vi.fn(async () => remoteTraexPath.value)
}))
vi.mock('../../../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: () => sshFilesystemProvider.value
}))

import { NATIVE_CHAT_METHODS } from './native-chat'

function readSessionHandler(): (params: unknown, context: RpcContext) => Promise<unknown> {
  const method = NATIVE_CHAT_METHODS.find(
    (candidate) => candidate.name === 'nativeChat.readSession'
  )
  if (!method) {
    throw new Error('readSession method not registered')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The registry lookup fixes this union member by its literal method name.
  return method.handler as (params: unknown, context: RpcContext) => Promise<unknown>
}

function contextWith(
  resolveNativeChatTraexSession: () => {
    transcriptPath?: string
    connectionId: string | null
  } | null,
  signal?: AbortSignal
): RpcContext {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This focused handler test exercises only the declared resolver method.
    runtime: { resolveNativeChatTraexSession } as unknown as RpcContext['runtime'],
    clientKind: 'mobile',
    signal
  }
}

const params = {
  agent: 'traex',
  sessionId: 'traex-session',
  terminal: 'terminal-1',
  worktree: 'wt-1'
}

describe('nativeChat TraeX transcript authority', () => {
  beforeEach(() => {
    localRead.args = null
    sshFilesystemProvider.value = null
    remoteTraexPath.value = null
  })

  it('uses runtime-confirmed authority instead of the client transcript path', async () => {
    const resolveNativeChatTraexSession = vi.fn(() => ({
      transcriptPath: '/trusted/rollout.jsonl',
      connectionId: null
    }))

    await readSessionHandler()(
      { ...params, transcriptPath: '/untrusted/client.jsonl' },
      contextWith(resolveNativeChatTraexSession)
    )

    expect(resolveNativeChatTraexSession).toHaveBeenCalledWith(
      'terminal-1',
      'wt-1',
      'traex-session'
    )
    expect(localRead.args).toMatchObject({
      agent: 'traex',
      sessionId: 'traex-session',
      transcriptPath: '/trusted/rollout.jsonl'
    })
  })

  it('does not fall back to a client path when hook authority omits one', async () => {
    await readSessionHandler()(
      { ...params, transcriptPath: '/untrusted/client.jsonl' },
      contextWith(() => ({ connectionId: null }))
    )

    expect(localRead.args).toMatchObject({ transcriptPath: undefined })
  })

  it('routes a trusted remote path through upstream SSH transcript access', async () => {
    const controller = new AbortController()

    await readSessionHandler()(
      params,
      contextWith(
        () => ({ transcriptPath: '/remote/rollout.jsonl', connectionId: 'ssh-1' }),
        controller.signal
      )
    )

    expect(localRead.args).toMatchObject({
      agent: 'traex',
      transcriptPath: 'orca-ssh-transcript:ssh-1:/remote/rollout.jsonl'
    })
  })

  it('resolves a missing trusted remote path before using upstream SSH access', async () => {
    sshFilesystemProvider.value = { marker: 'ssh-filesystem-provider' }
    remoteTraexPath.value = '~/.trae/cli/sessions/2026/rollout-traex-session.jsonl'

    await readSessionHandler()(
      params,
      contextWith(() => ({ connectionId: 'ssh-1' }))
    )

    expect(localRead.args).toMatchObject({
      agent: 'traex',
      transcriptPath:
        'orca-ssh-transcript:ssh-1:~/.trae/cli/sessions/2026/rollout-traex-session.jsonl'
    })
  })

  it('rejects reads without terminal-bound hook authority', async () => {
    await expect(
      readSessionHandler()(
        params,
        contextWith(() => null)
      )
    ).rejects.toThrow('TraeX session is not confirmed for this terminal')
  })
})
