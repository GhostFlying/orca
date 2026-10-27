import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'
import type { RootTurnObservation } from '../../shared/root-turn-observation'

const jsonLine = (row: unknown): string => `${JSON.stringify(row)}\n`

const native = vi.hoisted(() => ({ read: vi.fn(), stop: vi.fn(async () => {}) }))
vi.mock('../trae/traex-root-history-reader', () => ({
  TraexRootHistoryReader: class {
    read = native.read
    stop = native.stop
  }
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
describe('host native root observation with empty JSONL', () => {
  it('publishes failed root within two polls and keeps pending operations separate', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const observation: RootTurnObservation = {
      version: 1,
      sessionId: 'root-session',
      turnId: 'native-turn',
      observedAt: Date.now(),
      startedAt: Date.now() - 1000,
      completedAt: Date.now() + 1000,
      source: 'native-api',
      state: 'failed',
      operations: 'pending',
      errorCode: 'other',
      retryable: false
    }
    native.read.mockResolvedValue(observation)
    try {
      const response = await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'root-session',
            turn_id: 'native-turn',
            prompt: 'Do work',
            transcript_path: '/missing/sessions/2026/10/27/empty.jsonl'
          },
          { observedAgent: 'traex', launchToken: 'native-launch' }
        ),
        '/hook/trae'
      )
      expect(response.status).toBe(204)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(native.read).toHaveBeenCalled()
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: observation.completedAt },
        rootTurn: { state: 'failed', operations: 'pending', retryable: false }
      })
      await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'PostToolUse',
            session_id: 'root-session',
            turn_id: 'native-turn',
            transcript_path: '/missing/sessions/2026/10/27/empty.jsonl'
          },
          { observedAgent: 'traex', launchToken: 'native-launch' }
        ),
        '/hook/trae'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'done', outcome: 'failure' }
      })
      await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'SubagentStart',
            session_id: 'child-session',
            agent_id: 'child-session',
            turn_id: 'native-turn',
            prompt: 'Child task'
          },
          { observedAgent: 'traex', launchToken: 'native-launch' }
        ),
        '/hook/trae'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        providerSession: { id: 'root-session' },
        rootTurn: { state: 'failed', operations: 'pending' }
      })
    } finally {
      server.stop()
    }
  })
  it('keeps JSONL reconciliation armed after a native in-progress observation', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    const directory = mkdtempSync(join(tmpdir(), 'native-root-fallback-'))
    const path = join(directory, 'root.jsonl')
    writeFileSync(
      path,
      jsonLine({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'native-turn' }
      })
    )
    native.read.mockResolvedValue({
      version: 1,
      sessionId: 'root-session',
      turnId: 'native-turn',
      observedAt: Date.now(),
      startedAt: Date.now(),
      state: 'running',
      operations: 'unknown',
      source: 'native-api',
      retryable: false
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'root-session',
            turn_id: 'native-turn',
            transcript_path: path,
            prompt: 'Do work'
          },
          { launchToken: 'native-launch', observedAgent: 'traex' }
        ),
        '/hook/trae'
      )
      await vi.advanceTimersByTimeAsync(5000)
      native.read.mockResolvedValue(undefined)
      appendFileSync(
        path,
        jsonLine({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'native-turn',
            error: { codex_error_info: 'other' }
          }
        })
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'done', outcome: 'failure' }
      })
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('keeps unknown-read availability separate from the execution evidence clock', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    native.read.mockResolvedValue({
      version: 1,
      source: 'native-api',
      sessionId: 'session',
      turnId: 'turn',
      startedAt: 0,
      observedAt: Date.now(),
      state: 'unknown',
      operations: 'unknown',
      retryable: false
    })
    try {
      await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'session',
            turn_id: 'turn',
            prompt: 'Do work',
            transcript_path: '/missing/sessions/2026/10/27/root.jsonl'
          },
          { observedAgent: 'traex', launchToken: 'launch' }
        ),
        '/hook/trae'
      )
      const before = server.getStatusSnapshot()[0]
      await vi.advanceTimersByTimeAsync(5000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        evidenceObservedAt: before.evidenceObservedAt,
        rootTurn: { state: 'unknown' }
      })
    } finally {
      server.stop()
    }
  })
  it('continues observing cancelled-root operations until they settle', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const fact = {
      version: 1,
      source: 'native-api',
      sessionId: 'session',
      turnId: 'turn',
      startedAt: Date.now(),
      observedAt: Date.now(),
      completedAt: Date.now() + 1,
      state: 'cancelled',
      operations: 'pending',
      retryable: false
    }
    native.read.mockResolvedValue(fact)
    try {
      await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'session',
            turn_id: 'turn',
            prompt: 'Do work',
            transcript_path: '/missing/sessions/2026/10/27/root.jsonl'
          },
          { observedAgent: 'traex', launchToken: 'launch' }
        ),
        '/hook/trae'
      )
      await vi.advanceTimersByTimeAsync(5000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { outcome: 'cancellation' },
        rootTurn: { operations: 'pending' }
      })
      native.read.mockResolvedValue({ ...fact, operations: 'settled' })
      await vi.advanceTimersByTimeAsync(5000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { outcome: 'cancellation' },
        rootTurn: { operations: 'settled' }
      })
      expect(native.read).toHaveBeenCalledTimes(2)
    } finally {
      server.stop()
    }
  })
})
