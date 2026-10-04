import type { Automation } from '../../shared/automations/automation-definition'
import { connectTarget } from '../ipc/ssh/ssh-connect-flow'
import { AutomationDispatchRefusedError } from './dispatch/automation-launch-runner'

/** Background runs reach an SSH host without prompting; a prompt-needing target skips the run. */
export async function connectAutomationHost(automation: Automation): Promise<void> {
  if (automation.executionTargetType !== 'ssh') {
    return
  }
  try {
    const state = await connectTarget(automation.executionTargetId, {
      automatic: true,
      nonInteractive: true
    })
    if (state.status !== 'connected') {
      throw new Error('SSH target is unavailable.')
    }
  } catch (error) {
    throw new AutomationDispatchRefusedError({
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
