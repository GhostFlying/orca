import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

const event = (payload: Record<string, unknown>): string =>
  `${JSON.stringify({ type: 'event_msg', payload })}\n`

describe('TraeX root completion without Stop', () => {
  let server: AgentHookServer
  let directory: string

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
    })
    directory = mkdtempSync(join(tmpdir(), 'traex-root-end-'))
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(['trae', 'traex'] as const)(
    'reports a failed %s root without children and does not finish its next turn',
    async (source) => {
      const path = join(directory, 'root.jsonl')
      writeFileSync(path, event({ type: 'task_started', turn_id: 'turn-1' }))
      const hook = async (turnId: string): Promise<void> => {
        const response = await postHookEvent(
          server,
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              session_id: 'root-session',
              turn_id: turnId,
              prompt: `Do ${turnId}`,
              transcript_path: path
            },
            source === 'traex' ? { observedAgent: 'traex' } : {}
          ),
          '/hook/trae'
        )
        expect(response.status).toBe(204)
      }
      await hook('turn-1')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'working' }
      })

      appendFileSync(
        path,
        event({
          type: 'task_complete',
          turn_id: 'turn-1',
          error: { message: 'upstream failure', codex_error_info: 'other' }
        })
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done', outcome: 'failure' }
      })

      const late = await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name: 'PostToolUse',
            session_id: 'root-session',
            turn_id: 'turn-1',
            transcript_path: path,
            tool_name: 'Bash'
          },
          source === 'traex' ? { observedAgent: 'traex' } : {}
        ),
        '/hook/trae'
      )
      expect(late.status).toBe(204)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'done', outcome: 'failure' }
      })

      appendFileSync(path, event({ type: 'task_started', turn_id: 'turn-2' }))
      await hook('turn-2')
      appendFileSync(path, event({ type: 'task_complete', turn_id: 'turn-1' }))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'working' }
      })

      appendFileSync(path, event({ type: 'task_complete', turn_id: 'turn-2' }))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done' }
      })
    }
  )
})
