import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import type { CodexLeadTurnState } from '../listener-state'

/** The root state a Codex hook event implies; auto-allowed request_user_input still blocks on PreToolUse (Codex 0.145+). */
export function codexHookEventState(
  eventName: unknown,
  toolName: string | undefined
): CodexLeadTurnState['state'] | undefined {
  switch (eventName) {
    case 'Stop':
    case 'Interrupt':
      return 'done'
    case 'PermissionRequest':
      return 'waiting'
    case 'PreToolUse':
      return isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working'
    default:
      return undefined
  }
}

export function codexLeadStateForHookEvent(
  eventName: string | undefined,
  normalizedState?: ParsedAgentStatusPayload['state'],
  toolName?: string
): CodexLeadTurnState['state'] | undefined {
  // Preserve execution-host reviewer ownership; event names alone would turn every relayed approval into waiting.
  return eventName === 'PermissionRequest' && normalizedState === 'working'
    ? 'working'
    : codexHookEventState(eventName, toolName)
}
