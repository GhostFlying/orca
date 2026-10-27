import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server'
import { PANE } from '../main/agent-hooks/server.test-fixtures'

const native = vi.hoisted(() => ({ read: vi.fn(), stop: vi.fn(async () => {}) }))
vi.mock('../main/trae/traex-root-history-reader', () => ({
  TraexRootHistoryReader: class {
    read = native.read
    stop = native.stop
  }
}))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('execution-host native root facts over SSH relay', () => {
  it('reads only on the execution host and forwards failed/pending then settled facts', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    const directory = mkdtempSync(join(tmpdir(), 'relay-native-root-'))
    const main = new AgentHookServer()
    const relay = new RelayAgentHookServer({
      endpointDir: directory,
      forward: (envelope) => main.ingestRemote(envelope, 'conn-native')
    })
    await main.start({ env: 'production' })
    await relay.start()
    const fact = {
      version: 1,
      sessionId: 'session',
      turnId: 'turn',
      source: 'native-api',
      state: 'failed',
      operations: 'pending',
      errorCode: 'other',
      retryable: false,
      startedAt: Date.now(),
      observedAt: Date.now(),
      completedAt: Date.now() + 1
    }
    native.read.mockResolvedValue(fact)
    try {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/trae`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          Connection: 'close'
        },
        body: JSON.stringify({
          paneKey: PANE,
          launchToken: 'relay-launch',
          observedAgent: 'traex',
          env: 'remote',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'Do work',
            session_id: 'session',
            turn_id: 'turn',
            transcript_path: '/missing/sessions/2026/10/27/root.jsonl'
          }
        })
      })
      expect(response.status).toBe(204)
      const child = await fetch(`http://127.0.0.1:${port}/hook/trae`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          Connection: 'close'
        },
        body: JSON.stringify({
          paneKey: PANE,
          launchToken: 'relay-launch',
          observedAgent: 'traex',
          env: 'remote',
          payload: {
            hook_event_name: 'SubagentStart',
            session_id: 'child',
            agent_id: 'child',
            turn_id: 'turn'
          }
        })
      })
      expect(child.status).toBe(204)
      await vi.advanceTimersByTimeAsync(5000)
      expect(main.getStatusSnapshot()[0]).toMatchObject({
        connectionId: 'conn-native',
        mainAgent: { state: 'done', outcome: 'failure' },
        rootTurn: { sessionId: 'session', turnId: 'turn', state: 'failed', operations: 'pending' }
      })
      native.read.mockResolvedValue({ ...fact, operations: 'settled' })
      await vi.advanceTimersByTimeAsync(5000)
      expect(main.getStatusSnapshot()[0]).toMatchObject({ rootTurn: { operations: 'settled' } })
      expect(native.read).toHaveBeenCalledTimes(2)
    } finally {
      relay.stop()
      main.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('polls TraeX JSONL through the compatibility route when native history cannot run', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    const directory = mkdtempSync(join(tmpdir(), 'relay-traex-jsonl-'))
    const path = join(directory, 'root.jsonl')
    const line = (payload: unknown): string => `${JSON.stringify({ type: 'event_msg', payload })}\n`
    writeFileSync(path, line({ type: 'task_started', turn_id: 'turn' }))
    const main = new AgentHookServer()
    const relay = new RelayAgentHookServer({
      endpointDir: join(directory, 'hooks'),
      forward: (envelope) => main.ingestRemote(envelope, 'conn-jsonl')
    })
    native.read.mockResolvedValue(undefined)
    await main.start({ env: 'production' })
    await relay.start()
    try {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/trae`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          Connection: 'close'
        },
        body: JSON.stringify({
          paneKey: PANE,
          launchToken: 'launch',
          observedAgent: 'traex',
          env: 'remote',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'session',
            turn_id: 'turn',
            prompt: 'Do work',
            transcript_path: path
          }
        })
      })
      expect(response.status).toBe(204)
      appendFileSync(
        path,
        line({ type: 'task_complete', turn_id: 'turn', error: { codex_error_info: 'other' } })
      )
      await vi.advanceTimersByTimeAsync(10000)
      expect(main.getStatusSnapshot()[0]).toMatchObject({
        agentType: 'traex',
        mainAgent: { state: 'done', outcome: 'failure' }
      })
    } finally {
      relay.stop()
      main.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
