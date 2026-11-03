import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { assertAutomationExtraAgentArgs } from './automation-extra-agent-args-record'
import { parseExtraAgentArgs } from './automation-extra-agent-args'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

describe.each([
  ['darwin', false, 'posix'],
  ['linux', true, 'posix'],
  ['win32', false, 'powershell'],
  ['win32', false, 'cmd']
] as const)('Trae automation model on %s (remote %s, %s)', (platform, isRemote, shell) => {
  it.each(['-m', '--model'])('%s replaces host models in a TraeX launch', (option) => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'trae',
      settings: {
        agentCmdOverrides: { trae: 'traex' },
        agentDefaultArgs: {
          trae: '--model host-model -c model=legacy -p ultra --config=model_reasoning_effort=high'
        }
      },
      platform,
      isRemote,
      shell,
      extraAgentArgs: `${option} provider/selected-model`
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: 'Review the workspace' })
    if (!plan) {
      throw new Error('Expected a Trae startup plan')
    }
    expect(tokenizeStartupCommand(plan.launchCommand, shell)).toMatchObject({
      ok: true,
      tokens: [
        'traex',
        '-p',
        'ultra',
        '--config=model_reasoning_effort=high',
        option,
        'provider/selected-model',
        '--',
        'Review the workspace'
      ]
    })
  })
})

describe('Trae automation model validation', () => {
  it.each(['-p ultra', '--effort high', '-c model=other', '--yolo', '--resume session'])(
    'refuses non-model options: %s',
    (extraAgentArgs) => {
      expect(parseExtraAgentArgs({ agent: 'trae', extraAgentArgs })).toMatchObject({
        ok: false,
        error: expect.stringContaining("isn't allowed")
      })
    }
  )

  it.each([
    ['-m', 'needs a value'],
    ['-m first --model second', 'model more than once']
  ])('refuses invalid model arguments: %s', (extraAgentArgs, message) => {
    expect(parseExtraAgentArgs({ agent: 'trae', extraAgentArgs })).toMatchObject({
      ok: false,
      error: expect.stringContaining(message)
    })
  })

  it('accepts saved model arguments only for fresh sessions', () => {
    const automation = {
      agentId: 'trae' as const,
      extraAgentArgs: '-m provider/selected-model',
      reuseSession: false
    }
    expect(() => assertAutomationExtraAgentArgs(automation)).not.toThrow()
    expect(() => assertAutomationExtraAgentArgs({ ...automation, reuseSession: true })).toThrow(
      'Extra arguments require a fresh session'
    )
  })
})
