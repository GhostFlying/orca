import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { IFilesystemProvider } from '../providers/types'
import { createTranscriptWatchScheduler } from './transcript-watch-scheduler'
import { trackActiveNativeChatWatcher } from './transcript-watcher-count'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
import {
  readRemoteTranscriptTail,
  type RemoteTranscriptTail
} from './remote-transcript-tail-reader'

const MAX_REMOTE_TRAEX_SESSION_CANDIDATES = 32
const REMOTE_TRAEX_SESSION_ROOTS = ['~/.trae/cli/sessions', '~/.trae/sessions'] as const

export async function readRemoteNativeChatTranscriptTail(
  provider: IFilesystemProvider,
  args: Pick<
    SubscribeNativeChatTranscriptArgs,
    'agent' | 'sessionId' | 'transcriptPath' | 'initialLimit'
  > & { limit: number; beforeOffset?: number },
  signal?: AbortSignal
): Promise<RemoteTranscriptTail | { error: string; notFound?: true }> {
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  try {
    const filePath =
      args.transcriptPath?.trim() ||
      (args.agent === 'traex'
        ? await resolveRemoteTraexTranscript(provider, args.sessionId, signal)
        : null)
    if (!filePath) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    const result = await readRemoteTranscriptTail(
      provider,
      filePath,
      args.limit,
      decode,
      args.beforeOffset,
      signal
    )
    if (args.beforeOffset === undefined || result.lifecycle === undefined) {
      return result
    }
    const { lifecycle: _lifecycle, ...page } = result
    return page
  } catch (error) {
    signal?.throwIfAborted()
    return {
      error: error instanceof Error ? error.message : String(error),
      ...(isMissingFileError(error) ? { notFound: true } : {})
    }
  }
}

export async function subscribeRemoteNativeChatTranscript(
  provider: IFilesystemProvider,
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): Promise<NativeChatTranscriptSubscription> {
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { watching: false, unsubscribe: () => {} }
  }
  const filePath =
    args.transcriptPath?.trim() ||
    (args.agent === 'traex'
      ? await resolveRemoteTraexTranscript(provider, args.sessionId, setupSignal)
      : null)
  if (!filePath) {
    return { watching: false, unsubscribe: () => {} }
  }

  const controller = new AbortController()
  const abortFromSetup = (): void => controller.abort(setupSignal?.reason)
  setupSignal?.addEventListener('abort', abortFromSetup, { once: true })
  let closed = false
  let initial = true
  let unwatch = (): void => {}
  let watchInstalled = false
  let reading = false
  let pending = false
  let lastVersion: string | null = null

  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    setupSignal?.removeEventListener('abort', abortFromSetup)
    controller.abort(new Error('Native Chat remote transcript watcher unsubscribed'))
    scheduler.dispose()
    unwatch()
    if (watchInstalled) {
      trackActiveNativeChatWatcher(-1)
      watchInstalled = false
    }
  }

  const emitSnapshot = (tail: RemoteTranscriptTail): void => {
    const lifecycle = initial ? tail.lifecycle : undefined
    if (initial) {
      initial = false
      args.onInitialSnapshot?.(tail.messages, tail.hasMore, tail.beforeOffset, undefined, lifecycle)
      return
    }
    args.onReplace?.(tail.messages, tail.hasMore, tail.beforeOffset, tail.lifecycle)
  }

  const drain = async (): Promise<void> => {
    if (closed) {
      return
    }
    if (reading) {
      pending = true
      return
    }
    reading = true
    try {
      do {
        pending = false
        const stat = await provider.stat(filePath)
        const version = `${stat.size}:${stat.mtimeMs ?? stat.mtime}`
        if (!initial && lastVersion === version) {
          continue
        }
        const tail = await readRemoteTranscriptTail(
          provider,
          filePath,
          args.initialLimit ?? Number.MAX_SAFE_INTEGER,
          decode,
          undefined,
          controller.signal,
          stat.size
        )
        if (!closed) {
          lastVersion = version
          emitSnapshot(tail)
        }
      } while (pending && !closed)
    } catch (error) {
      if (!closed && initial) {
        args.onInitialSnapshot?.(
          [],
          false,
          0,
          error instanceof Error ? error.message : String(error)
        )
      }
    } finally {
      reading = false
    }
  }

  const scheduler = createTranscriptWatchScheduler({
    debounceMs: args.debounceMs,
    reconciliationIntervalMs: args.reconciliationIntervalMs,
    drain: () => void drain(),
    reconcile: drain
  })
  try {
    const watchRoot = (isWindowsAbsolutePathLike(filePath) ? win32 : posix).dirname(filePath)
    const installedUnwatch = await provider.watch(watchRoot, () => scheduler.scheduleEventDrain(), {
      signal: controller.signal,
      onTerminalError: (error) => {
        if (closed) {
          return
        }
        args.onInitialSnapshot?.([], false, 0, error.message)
        close()
      }
    })
    setupSignal?.throwIfAborted()
    if (closed) {
      installedUnwatch()
      return { watching: false, unsubscribe: () => {} }
    }
    unwatch = installedUnwatch
    watchInstalled = true
    trackActiveNativeChatWatcher(1)
    scheduler.startReconciliation()
    await drain()
    return { watching: true, unsubscribe: close }
  } catch (error) {
    close()
    setupSignal?.throwIfAborted()
    if (isMissingFileError(error)) {
      return { watching: false, unsubscribe: () => {} }
    }
    throw error
  }
}

async function resolveRemoteTraexTranscript(
  provider: IFilesystemProvider,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  let unavailable: unknown
  for (const root of REMOTE_TRAEX_SESSION_ROOTS) {
    signal?.throwIfAborted()
    try {
      const files = await provider.listFiles(root, {
        signal,
        maxResults: MAX_REMOTE_TRAEX_SESSION_CANDIDATES,
        searchQuery: sessionId
      })
      const match = files
        .map(normalizeRelativeTranscriptPath)
        .filter((path): path is string => path !== null)
        .filter((path) => transcriptBasenameMatchesSession(path, sessionId))
        .sort()
        .at(-1)
      if (match) {
        return `${root}/${match}`
      }
    } catch (error) {
      signal?.throwIfAborted()
      unavailable = error
    }
  }
  if (unavailable) {
    throw unavailable
  }
  return null
}

function normalizeRelativeTranscriptPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = normalized.split('/')
  return normalized &&
    !normalized.startsWith('/') &&
    segments.every((segment) => segment && segment !== '.' && segment !== '..')
    ? normalized
    : null
}

function transcriptBasenameMatchesSession(path: string, sessionId: string): boolean {
  const filename = posix.basename(path)
  if (!filename.endsWith('.jsonl')) {
    return false
  }
  const stem = filename.slice(0, -'.jsonl'.length)
  return stem === sessionId || stem.endsWith(`-${sessionId}`)
}

function isMissingFileError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null
  return (
    candidate?.code === 'ENOENT' ||
    (typeof candidate?.message === 'string' &&
      candidate.message.includes('no such file or directory'))
  )
}
