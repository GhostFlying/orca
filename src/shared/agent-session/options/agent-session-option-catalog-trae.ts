import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

function removeTraeConfig(tokens: readonly string[], key: string): string[] {
  return removeAgentArgOption('trae', tokens, ['-c', '--config'], (value) =>
    new RegExp(`^\\s*${key}\\s*=`).test(value ?? '')
  )
}

export const TRAE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      options: [
        {
          id: 'effort',
          label: 'Reasoning effort',
          category: 'thought_level',
          kind: {
            type: 'select',
            choices: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'xhigh', label: 'Extra high' }
            ],
            defaultValue: 'medium'
          },
          apply: {
            launchArgs: (value) => ['-c', `model_reasoning_effort=${JSON.stringify(value)}`],
            removeAgentArgs: (tokens) => removeTraeConfig(tokens, 'model_reasoning_effort'),
            midSession: { kind: 'unsupported' }
          }
        }
      ]
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) =>
      removeTraeConfig(removeAgentArgOption('trae', tokens, ['-m', '--model']), 'model'),
    midSession: { kind: 'unsupported' }
  }
}
