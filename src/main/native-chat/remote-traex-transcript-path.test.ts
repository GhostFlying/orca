import { describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import { resolveRemoteTraexTranscriptPath } from './remote-traex-transcript-path'

function providerWithFiles(filesByRoot: Record<string, string[]>): IFilesystemProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This focused fake implements the only filesystem operation used by the resolver.
  return {
    listFiles: vi.fn(async (root: string) => filesByRoot[root] ?? [])
  } as unknown as IFilesystemProvider
}

describe('resolveRemoteTraexTranscriptPath', () => {
  it('finds the newest matching rollout in the primary TraeX root', async () => {
    const provider = providerWithFiles({
      '~/.trae/cli/sessions': [
        '2026/10/rollout-2026-10-10-session-1.jsonl',
        '2026/10/rollout-2026-10-11-session-1.jsonl',
        '2026/10/rollout-other.jsonl'
      ]
    })

    await expect(resolveRemoteTraexTranscriptPath(provider, 'session-1')).resolves.toBe(
      '~/.trae/cli/sessions/2026/10/rollout-2026-10-11-session-1.jsonl'
    )
  })

  it('falls back to the legacy TraeX root and rejects unsafe paths', async () => {
    const provider = providerWithFiles({
      '~/.trae/cli/sessions': ['../rollout-session-1.jsonl', '/tmp/session-1.jsonl'],
      '~/.trae/sessions': ['nested/session-1.jsonl']
    })

    await expect(resolveRemoteTraexTranscriptPath(provider, 'session-1')).resolves.toBe(
      '~/.trae/sessions/nested/session-1.jsonl'
    )
  })

  it('returns null when neither TraeX root contains the session', async () => {
    await expect(resolveRemoteTraexTranscriptPath(providerWithFiles({}), 'missing')).resolves.toBe(
      null
    )
  })
})
