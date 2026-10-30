import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

function launch(args: Partial<Parameters<typeof resolveAgentLaunchCommand>[0]>) {
  const result = resolveAgentLaunchCommand({
    agent: 'claude',
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    ...args
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

describe('one copy of each chat-picked flag', () => {
  it('preserves picks when configured arguments contain flags after --', () => {
    const result = launch({
      agentArgs: '-- --model haiku',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--' '--model' 'haiku'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })
})

describe('Trae explicit worker launch preferences', () => {
  it.each(['high', 'xhigh'])('applies the exact catalog model and %s effort', (effort) => {
    const result = launch({
      agent: 'trae',
      sessionOptions: { model: 'gpt-6.1-sol', effort },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: `-m old-model -c " model = legacy" --config 'model_reasoning_effort="low"' -c unrelated=true -- --model prompt-model`
    })
    expect(result.appliedSessionOptions).toEqual({ model: 'gpt-6.1-sol', effort })
    expect(result.command).toBe(
      `traecli '-c' 'unrelated=true' '--model' 'gpt-6.1-sol' '-c' 'model_reasoning_effort="${effort}"' '--' '--model' 'prompt-model'`
    )
    expect(result.resumeLaunch.agentCommand).toBe(
      "traecli '-c' 'unrelated=true' '--' '--model' 'prompt-model'"
    )
  })
})
