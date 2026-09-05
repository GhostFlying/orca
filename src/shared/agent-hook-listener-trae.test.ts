import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

function body(eventName: string, payload: Record<string, unknown> = {}) {
  return { paneKey: PANE_KEY, payload: { hook_event_name: eventName, ...payload } }
}

describe('Trae hook lifecycle', () => {
  it('uses Codex-compatible transitions with canonical Trae identity', () => {
    const state = createHookListenerState()
    expect(
      normalizeHookPayload(state, 'trae', body('UserPromptSubmit', { prompt: 'fix it' }), 'test')
        ?.payload
    ).toMatchObject({ state: 'working', prompt: 'fix it', agentType: 'trae' })
    expect(
      normalizeHookPayload(
        state,
        'trae',
        body('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git status' } }),
        'test'
      )?.payload
    ).toMatchObject({ state: 'waiting', agentType: 'trae', toolName: 'Bash' })
    expect(
      normalizeHookPayload(state, 'trae', body('Stop', { last_assistant_message: 'done' }), 'test')
        ?.payload
    ).toMatchObject({ state: 'done', agentType: 'trae', lastAssistantMessage: 'done' })
  })

  it('keeps Codex-compatible state isolated by provider on a reused pane', () => {
    const state = createHookListenerState()
    normalizeHookPayload(state, 'codex', body('UserPromptSubmit', { prompt: 'codex task' }), 'test')
    normalizeHookPayload(
      state,
      'codex',
      body('SubagentStart', { agent_id: 'codex-child', agent_type: 'reviewer' }),
      'test'
    )

    const traeStarted = normalizeHookPayload(
      state,
      'trae',
      body('UserPromptSubmit', { prompt: 'trae task' }),
      'test'
    )
    const codexChildWaiting = normalizeHookPayload(
      state,
      'codex',
      body('PermissionRequest', {
        agent_id: 'codex-child',
        agent_type: 'reviewer',
        tool_name: 'Bash'
      }),
      'test'
    )
    const traeStopped = normalizeHookPayload(state, 'trae', body('Stop'), 'test')

    expect(traeStarted?.payload).toMatchObject({
      state: 'working',
      prompt: 'trae task',
      agentType: 'trae',
      subagents: undefined
    })
    expect(traeStopped?.payload).toMatchObject({
      state: 'done',
      prompt: 'trae task',
      agentType: 'trae',
      subagents: undefined
    })
    expect(codexChildWaiting?.payload).toMatchObject({
      state: 'waiting',
      prompt: 'codex task',
      agentType: 'codex',
      subagents: [expect.objectContaining({ id: 'codex-child', state: 'waiting' })]
    })
  })
})
