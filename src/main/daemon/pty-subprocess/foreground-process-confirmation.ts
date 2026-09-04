import type * as pty from 'node-pty'
import { resolveAgentForegroundProcessWithAvailability } from '../../providers/agent-foreground-process'
import { readWindowsConsoleAttachedProcessIds } from '../../providers/windows-console-attached-processes'
import {
  recognizeAgentProcess,
  requiresAgentCommandLineVerification
} from '../../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../../shared/foreground-wrapper-agent'

export async function confirmTrackedForegroundProcess(args: {
  process: pty.IPty
  fallbackProcess: string | null
  contextPaths: readonly string[]
  shouldInspectFallback: (fallbackProcess: string | null) => boolean
  isDead: () => boolean
}): Promise<{ processName: string | null; pid: number | null; recognized: boolean } | null> {
  if (args.isDead() || !args.process.pid) {
    return null
  }
  const recognition = recognizeAgentProcess(args.fallbackProcess)
  const requiresCommandLine = requiresAgentCommandLineVerification(recognition)
  if (
    !args.fallbackProcess ||
    (recognition !== null &&
      process.platform !== 'win32' &&
      !shouldInspectOuterWrapperForegroundProcess(recognition) &&
      !requiresCommandLine) ||
    (process.platform !== 'win32' && !args.shouldInspectFallback(args.fallbackProcess))
  ) {
    return { processName: args.fallbackProcess, pid: null, recognized: false }
  }
  const resolution = await resolveAgentForegroundProcessWithAvailability(
    args.process.pid,
    args.fallbackProcess,
    {
      contextPaths: args.contextPaths,
      fresh: true,
      ...(process.platform === 'win32'
        ? {
            forceProcessScan: true,
            readWindowsConsoleAttachedProcessIds: () =>
              readWindowsConsoleAttachedProcessIds(args.process.pid)
          }
        : {})
    }
  )
  if (args.isDead() || !resolution.available) {
    return null
  }
  const resolvedRecognition = recognizeAgentProcess(resolution.processName)
  return resolvedRecognition
    ? {
        processName: resolvedRecognition.processName,
        pid: resolution.processId ?? null,
        recognized: true
      }
    : { processName: resolution.processName, pid: null, recognized: false }
}
