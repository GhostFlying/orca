import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RootTurnObservation } from '../../shared/root-turn-observation'
import { TraexRootObserver, type TraexRootOwner } from './traex-root-observer'

const owner: TraexRootOwner = {
  paneKey: 'pane',
  launchToken: 'private-launch-token',
  sessionId: 'session',
  turnId: 'turn',
  transcriptPath: '/native/sessions/2026/10/27/root.jsonl'
}
const fact: RootTurnObservation = {
  version: 1,
  sessionId: 'session',
  turnId: 'turn',
  observedAt: 200,
  startedAt: 100,
  source: 'native-api',
  state: 'failed',
  errorCode: 'other',
  operations: 'settled',
  retryable: false
}

afterEach(() => vi.useRealTimers())
describe('native root observation ownership', () => {
  it.each(['launchToken', 'sessionId', 'turnId', 'paneKey'] as const)(
    'drops late history after %s changes',
    async (key) => {
      vi.useFakeTimers()
      let current = { ...owner }
      let finish: ((value: RootTurnObservation) => void) | undefined
      const read = vi.fn(
        () =>
          new Promise<RootTurnObservation>((resolve) => {
            finish = resolve
          })
      )
      const publish = vi.fn()
      const stop = vi.fn(async () => {})
      const observer = new TraexRootObserver(() => current, publish, { read, stop })
      observer.schedule('pane')
      await vi.advanceTimersByTimeAsync(5000)
      expect(read).toHaveBeenCalledTimes(1)
      current = { ...current, [key]: 'replacement' }
      finish?.(fact)
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).not.toHaveBeenCalled()
      observer.stop()
      expect(stop).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it('polls without children, hashes launch credentials and stops owned work', async () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const read = vi.fn(async () => fact)
    const stop = vi.fn(async () => {})
    const observer = new TraexRootObserver(() => owner, publish, { read, stop })
    observer.schedule('pane')
    observer.schedule('pane')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        state: 'failed',
        paneKey: 'pane',
        launchId: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    )
    expect(JSON.stringify(publish.mock.calls)).not.toContain('"launchId":"private-launch-token"')
    observer.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
