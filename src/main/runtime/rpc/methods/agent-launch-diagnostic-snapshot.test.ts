import { describe, expect, it, vi } from 'vitest'
import { readLaunchDiagnosticSnapshot } from './agent-launch-diagnostic-snapshot'

describe('bounded launch evidence', () => {
  it('keeps only exact readiness markers and redacts credentials, commands and prompt content', async () => {
    const readTerminal = vi.fn(async () => ({
      handle: 'term_1',
      status: 'running' as const,
      tail: [
        'old secret',
        ...Array.from({ length: 10 }, () => 'token=secret'),
        'Do you trust the files in this folder?',
        'private user prompt'
      ],
      truncated: false,
      nextCursor: null
    }))
    const snapshot = await readLaunchDiagnosticSnapshot({ readTerminal }, 'term_1')
    expect(readTerminal).toHaveBeenCalledWith('term_1', { limit: 12 })
    expect(snapshot?.tail).toHaveLength(12)
    expect(snapshot?.tail).toContain('Do you trust the files in this folder?')
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private/)
  })

  it('bounds unavailable terminal evidence without affecting the launch result', async () => {
    vi.useFakeTimers()
    try {
      const pending = readLaunchDiagnosticSnapshot(
        { readTerminal: () => new Promise(() => {}) },
        'term_1'
      )
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
