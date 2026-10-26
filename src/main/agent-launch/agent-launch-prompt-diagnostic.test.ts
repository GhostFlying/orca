import { describe, expect, it } from 'vitest'
import { deliverTerminalLaunchPrompt } from './agent-launch-prompt-delivery'
import type { AgentLaunchPromptDiagnostic } from '../../shared/agent-launch-intent'

describe('launch diagnostic receipt propagation', () => {
  it.each(['none', 'possible'] as const)(
    'preserves %s write certainty',
    async (promptWriteState) => {
      const diagnostic: AgentLaunchPromptDiagnostic = {
        code: promptWriteState === 'none' ? 'readiness_timeout' : 'delivery_unknown',
        phase: promptWriteState === 'none' ? 'readiness' : 'write',
        promptWriteState,
        elapsedMs: 60000,
        terminalHandle: 'term_1'
      }
      const result = await deliverTerminalLaunchPrompt(
        {
          intent: {
            agent: 'claude',
            target: { kind: 'existing', worktree: 'wt-7' },
            prompt: { text: 'do the thing', delivery: 'submit' }
          },
          surfaces: {
            createStructuredSession: async () => {
              throw new Error('unused')
            },
            createTerminalAgent: async () => {
              throw new Error('unused')
            },
            deliverTerminalPrompt: async ({ onDiagnostic }) => {
              onDiagnostic?.(diagnostic)
              return false
            }
          }
        },
        'term_1',
        { freshLaunch: true }
      )
      expect(result).toEqual({
        outcome: promptWriteState === 'none' ? 'not-delivered' : 'unconfirmed',
        diagnostic
      })
    }
  )
})
