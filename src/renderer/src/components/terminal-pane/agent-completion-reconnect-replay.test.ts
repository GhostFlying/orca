import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'

describe('agent completion reconnect replay identity', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('ignores delivery-time changes while preserving genuinely new done turns', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    const completedTurn = {
      state: 'done' as const,
      prompt: 'finish the task',
      agentType: 'claude' as const,
      stateStartedAt: 1_800_000_000_000
    }

    coordinator.observeHookStatus(completedTurn)
    for (let reconnect = 1; reconnect <= 12; reconnect += 1) {
      vi.advanceTimersByTime(5_000)
      coordinator.observeHookStatus(completedTurn)
    }
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_000)
    coordinator.observeHookStatus({
      ...completedTurn,
      stateStartedAt: 1_800_000_100_000
    })

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })
})
