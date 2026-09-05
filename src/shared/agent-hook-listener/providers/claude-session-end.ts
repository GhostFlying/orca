const PROCESS_EXIT_REASONS = new Set([
  'prompt_input_exit',
  'logout',
  'other',
  'bypass_permissions_disabled'
])

export function isClaudeProcessExitSessionEndReason(reason: string | undefined): boolean {
  return reason !== undefined && PROCESS_EXIT_REASONS.has(reason)
}
