import { posix } from 'node:path'
import type { IFilesystemProvider } from '../providers/types'

const MAX_REMOTE_TRAEX_SESSION_CANDIDATES = 32
const REMOTE_TRAEX_SESSION_ROOTS = ['~/.trae/cli/sessions', '~/.trae/sessions'] as const

export async function resolveRemoteTraexTranscriptPath(
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
