import { describe, expect, it } from 'vitest'
import { buildPosixAgentHookPostCommand } from './hook-post-command'
import { buildPosixHookObservedAgentLines } from './hook-stdin-contract'

describe('buildPosixAgentHookPostCommand', () => {
  it('sends the observed agent exactly once on both POSIX transports', () => {
    const command = buildPosixAgentHookPostCommand('trae').join('\n')

    expect(command.match(/X-Orca-Agent-Hook-Observed-Agent/g)).toHaveLength(1)
    expect(command.match(/observedAgent=/g)).toHaveLength(1)
  })
})

describe('buildPosixHookObservedAgentLines', () => {
  it('detects only an exact TraeX ancestor for the shared Trae hook', () => {
    const script = buildPosixHookObservedAgentLines('trae').join('\n')

    expect(script).toContain('ancestor_depth=0')
    expect(script).toContain('ancestor_depth" -lt 8')
    expect(script).toContain(String.raw`traex|traex\ *|*/traex|*/traex\ *`)
    expect(script).toContain('ORCA_AGENT_HOOK_OBSERVED_AGENT=traex')
    expect(script).not.toContain('traex-code-mode-host')
    expect(buildPosixHookObservedAgentLines('codex')).toEqual([])
  })
})
