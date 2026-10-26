import type { AgentLaunchPromptDiagnostic } from '../../../../shared/agent-launch-intent'
import type { OrcaRuntimeService } from '../../orca-runtime'

const SAFE_LINES = new Set([
  'model: loading',
  'Do you trust the files in this folder?',
  'Trust this workspace?',
  'Sign in to continue',
  'Press Enter to continue',
  'Update available'
])

export async function readLaunchDiagnosticSnapshot(
  runtime: Pick<OrcaRuntimeService, 'readTerminal'>,
  handle: string
): Promise<AgentLaunchPromptDiagnostic['terminalSnapshot']> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const snapshot = await Promise.race([
      runtime.readTerminal(handle, { limit: 12 }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1000)
      })
    ])
    if (!snapshot) {
      return undefined
    }
    return {
      status: snapshot.status,
      tail: snapshot.tail.slice(-12).map((line) => {
        const text = line.trim()
        return SAFE_LINES.has(text) ? text : '[redacted]'
      })
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
