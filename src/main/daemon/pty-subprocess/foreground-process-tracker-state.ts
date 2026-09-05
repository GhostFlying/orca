import type { IPty } from 'node-pty'
import type { RecognizedAgentProcess } from '../../../shared/agent-process-recognition'

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

export type PtyForegroundProcessTracker = {
  recordOutput(data: string): void
  markDead(): void
  /** rawFallback bypasses cached identity and process-table refreshes for cheap polling. */
  getForegroundProcess(options?: { rawFallback?: boolean; cachedOnly?: boolean }): string | null
  confirmForegroundProcess(context?: { decision?: boolean }): Promise<string | null>
  confirmShellForeground(): Promise<boolean>
}

export type PtyForegroundProcessTrackerArgs = {
  process: IPty
  shellPath: string
  cwd?: string
  sessionId: string
  startupAgentRecognition: RecognizedAgentProcess | null
  isDead: () => boolean
}
