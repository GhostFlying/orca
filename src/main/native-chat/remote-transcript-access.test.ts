import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import {
  readRemoteNativeChatTranscriptTail,
  subscribeRemoteNativeChatTranscript
} from './remote-transcript-access'

function codexLine(id: string, text: string): string {
  return `${JSON.stringify({
    type: 'response_item',
    timestamp: '2026-09-04T00:00:00.000Z',
    payload: {
      type: 'message',
      id,
      role: 'assistant',
      content: [{ type: 'text', text }]
    }
  })}\n`
}

function codexLifecycleLine(type: 'task_started' | 'task_complete', turnId: string): string {
  return `${JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-09-04T00:00:00.000Z',
    payload: { type, turn_id: turnId }
  })}\n`
}

function memoryProvider(
  initial: string,
  rangeSupported = true
): {
  provider: IFilesystemProvider
  setContent: (content: string) => void
  emitChange: () => void
  emitTerminalError: (error: Error) => void
  readFile: ReturnType<typeof vi.fn>
  readFileRange: ReturnType<typeof vi.fn>
  listFiles: ReturnType<typeof vi.fn>
  watch: ReturnType<typeof vi.fn>
  unwatch: ReturnType<typeof vi.fn>
} {
  let bytes = Buffer.from(initial)
  let version = 1
  let onChange = (): void => {}
  let onTerminalError = (_error: Error): void => {}
  const readFile = vi.fn(async () => ({ content: bytes.toString('utf8'), isBinary: false }))
  const readFileRange = vi.fn(async (_path: string, position: number, length: number) => {
    const slice = bytes.subarray(position, Math.min(position + length, bytes.length))
    return { bytes: slice, bytesRead: slice.length }
  })
  const listFiles = vi.fn(async () => [] as string[])
  const unwatch = vi.fn()
  const watch = vi.fn(async (_root, callback, options) => {
    onChange = () => callback([])
    onTerminalError = options?.onTerminalError ?? (() => {})
    return unwatch
  })
  return {
    provider: {
      stat: vi.fn(async () => ({
        size: bytes.length,
        type: 'file' as const,
        mtime: version,
        mtimeMs: version
      })),
      readFile,
      readFileRange,
      listFiles,
      supportsFileRangeRead: vi.fn(async () => rangeSupported),
      watch
    } as unknown as IFilesystemProvider,
    setContent(content: string): void {
      bytes = Buffer.from(content)
      version++
    },
    emitChange(): void {
      onChange()
    },
    emitTerminalError(error: Error): void {
      onTerminalError(error)
    },
    readFile,
    readFileRange,
    listFiles,
    watch,
    unwatch
  }
}

describe('remote TraeX transcript access', () => {
  it('reads an exact paginated tail through bounded positional reads', async () => {
    const source = [
      codexLine('a-1', 'one'),
      codexLine('a-2', 'two'),
      codexLine('a-3', 'three')
    ].join('')
    const harness = memoryProvider(source)

    const tail = await readRemoteNativeChatTranscriptTail(harness.provider, {
      agent: 'traex',
      sessionId: 'session-1',
      transcriptPath: '/remote/rollout.jsonl',
      initialLimit: 2,
      limit: 2
    })

    expect(tail).toMatchObject({
      messages: [
        { id: 'a-2', blocks: [{ type: 'text', text: 'two' }] },
        { id: 'a-3', blocks: [{ type: 'text', text: 'three' }] }
      ],
      hasMore: true
    })
    expect(harness.readFile).not.toHaveBeenCalled()
    expect(harness.readFileRange).toHaveBeenCalled()
    expect(
      harness.readFileRange.mock.calls.every((call) => (call[2] as number) <= 256 * 1024)
    ).toBe(true)
  })

  it('falls back to one bounded whole-file read for an older relay', async () => {
    const harness = memoryProvider(codexLine('a-1', 'legacy'), false)

    const tail = await readRemoteNativeChatTranscriptTail(harness.provider, {
      agent: 'traex',
      sessionId: 'session-1',
      transcriptPath: '/remote/rollout.jsonl',
      initialLimit: 40,
      limit: 40
    })

    expect(tail).toMatchObject({ messages: [{ id: 'a-1' }], hasMore: false })
    expect(harness.readFile).toHaveBeenCalledWith('/remote/rollout.jsonl', {
      maxTextBytes: 10 * 1024 * 1024
    })
    expect(harness.readFileRange).not.toHaveBeenCalled()
  })

  it('resolves a missing hook path from TraeX roots without scanning Codex roots', async () => {
    const harness = memoryProvider(codexLine('a-1', 'resolved'))
    harness.listFiles.mockImplementation(async (root: string) =>
      root === '~/.trae/cli/sessions'
        ? ['2026/09/04/rollout-2026-09-04T00-00-00-session-1.jsonl']
        : []
    )

    const tail = await readRemoteNativeChatTranscriptTail(harness.provider, {
      agent: 'traex',
      sessionId: 'session-1',
      initialLimit: 40,
      limit: 40
    })

    expect(tail).toMatchObject({ messages: [{ id: 'a-1' }] })
    expect(harness.listFiles).toHaveBeenCalledWith('~/.trae/cli/sessions', {
      signal: undefined,
      maxResults: 32,
      searchQuery: 'session-1'
    })
    expect(harness.listFiles).not.toHaveBeenCalledWith(
      expect.stringContaining('.codex'),
      expect.anything()
    )
    expect(harness.readFileRange).toHaveBeenCalledWith(
      '~/.trae/cli/sessions/2026/09/04/rollout-2026-09-04T00-00-00-session-1.jsonl',
      expect.any(Number),
      expect.any(Number),
      expect.anything()
    )
  })

  it('omits current turn lifecycle when paging an older transcript window', async () => {
    const oldest = codexLine('a-1', 'old')
    const source = oldest + codexLifecycleLine('task_complete', 'turn-1')
    const harness = memoryProvider(source)

    const current = await readRemoteNativeChatTranscriptTail(harness.provider, {
      agent: 'traex',
      sessionId: 'session-1',
      transcriptPath: '/remote/rollout.jsonl',
      initialLimit: 40,
      limit: 40
    })
    const older = await readRemoteNativeChatTranscriptTail(harness.provider, {
      agent: 'traex',
      sessionId: 'session-1',
      transcriptPath: '/remote/rollout.jsonl',
      initialLimit: 40,
      limit: 40,
      beforeOffset: Buffer.byteLength(oldest)
    })

    expect(current).toMatchObject({
      lifecycle: { state: 'completed', turnId: 'turn-1' }
    })
    expect(older).not.toHaveProperty('lifecycle')
  })

  it('watches the transcript directory and replaces the bounded window after changes', async () => {
    const first = codexLine('a-1', 'first')
    const harness = memoryProvider(first)
    const onInitialSnapshot = vi.fn()
    const onReplace = vi.fn()

    const subscription = await subscribeRemoteNativeChatTranscript(harness.provider, {
      agent: 'traex',
      sessionId: 'session-1',
      transcriptPath: '/remote/sessions/rollout.jsonl',
      initialLimit: 40,
      debounceMs: 0,
      reconciliationIntervalMs: 60_000,
      onInitialSnapshot,
      onReplace,
      onAppend: vi.fn()
    })

    expect(harness.watch).toHaveBeenCalledWith(
      posix.dirname('/remote/sessions/rollout.jsonl'),
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(onInitialSnapshot).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'a-1' })],
      false,
      0,
      undefined,
      undefined
    )

    harness.setContent(first + codexLine('a-2', 'second'))
    harness.emitChange()
    await vi.waitFor(() =>
      expect(onReplace).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'a-1' }), expect.objectContaining({ id: 'a-2' })],
        false,
        0,
        undefined
      )
    )

    subscription.unsubscribe()
    expect(harness.unwatch).toHaveBeenCalledOnce()
  })

  it('surfaces a terminal remote-watch failure and closes the subscription', async () => {
    const harness = memoryProvider(codexLine('a-1', 'first'))
    const onInitialSnapshot = vi.fn()
    const subscription = await subscribeRemoteNativeChatTranscript(harness.provider, {
      agent: 'traex',
      sessionId: 'session-1',
      transcriptPath: '/remote/rollout.jsonl',
      initialLimit: 40,
      reconciliationIntervalMs: 60_000,
      onInitialSnapshot,
      onAppend: vi.fn()
    })

    harness.emitTerminalError(new Error('remote watcher exhausted recovery'))

    expect(onInitialSnapshot).toHaveBeenLastCalledWith(
      [],
      false,
      0,
      'remote watcher exhausted recovery'
    )
    expect(harness.unwatch).toHaveBeenCalledOnce()
    subscription.unsubscribe()
    expect(harness.unwatch).toHaveBeenCalledOnce()
  })
})
