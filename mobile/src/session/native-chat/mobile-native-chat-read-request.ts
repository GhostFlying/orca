const PAGE = 60
export const MAX_MESSAGES = 2000

export function nextPageWindow(
  limit: number,
  listLength: number
): { nextLimit: number; pageLimit: number } | null {
  // Live output grows the list past the last read, so the next page counts from what is held.
  const held = Math.max(limit, listLength)
  const nextLimit = Math.min(held + PAGE, MAX_MESSAGES)
  return nextLimit > held ? { nextLimit, pageLimit: nextLimit - held } : null
}

export function nativeChatTarget(args: {
  agent: string
  sessionId: string
  terminal: string | null
  worktree: string | null
}): {
  agent: string
  sessionId: string
  terminal?: string
  worktree?: string
} {
  return {
    agent: args.agent,
    sessionId: args.sessionId,
    ...(args.terminal ? { terminal: args.terminal } : {}),
    ...(args.worktree ? { worktree: args.worktree } : {})
  }
}
