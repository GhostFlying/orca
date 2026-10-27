import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = vi.hoisted(() => ({
  request: vi.fn(async (method: string): Promise<unknown> =>
    method === 'initialize' ? {} : { thread: { id: 'missing' } }
  ),
  notify: vi.fn(),
  close: vi.fn(async () => true),
  spawn: vi.fn()
}))
vi.mock('../codex/codex-app-server-connection', () => ({
  spawnCodexAppServerConnection: native.spawn
}))
import { TraexRootHistoryReader, traexHistoryHome } from './traex-root-history-reader'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
describe('owned native history process', () => {
  it('clears inherited hook identity, reuses read-only transport and closes it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'traex-home-'))
    const parent = join(home, 'sessions', '2026', '10', '27')
    mkdirSync(parent, { recursive: true })
    const transcriptPath = join(parent, 'root.jsonl')
    vi.stubEnv('ORCA_AGENT_HOOK_TOKEN', 'private-inherited-token')
    vi.stubEnv('ORCA_PANE_KEY', 'inherited-pane')
    native.spawn.mockResolvedValue({
      request: native.request,
      notify: native.notify,
      close: native.close,
      closed: false
    })
    const reader = new TraexRootHistoryReader()
    try {
      expect(traexHistoryHome(`${transcriptPath}.lock`)).toBeUndefined()
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          await reader.read({ sessionId: 'session', turnId: 'turn', transcriptPath })
        ).toMatchObject({ state: 'unknown', operations: 'unknown' })
      }
      expect(native.spawn).toHaveBeenCalledTimes(1)
      expect(native.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { TRAECLI_HOME: realpathSync(home) },
          envToDelete: expect.arrayContaining(['ORCA_AGENT_HOOK_TOKEN', 'ORCA_PANE_KEY'])
        })
      )
      expect(native.request.mock.calls.map(([method]) => method)).toEqual([
        'initialize',
        'thread/read',
        'thread/read'
      ])
    } finally {
      await reader.stop()
      rmSync(home, { recursive: true, force: true })
    }
    expect(native.close).toHaveBeenCalledTimes(1)
  })
})
