export const FOREGROUND_AGENT_CACHE_TTL_MS = 1000
export const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
export const WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS = 15_000
export const SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS = 10_000
export const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000

export type CachedAgentForeground = {
  processName: string
  pid: number | null
  refreshedAt: number
}
