import type { AgentHookSource } from '../../shared/agent-hook-relay'

/**
 * Extra form lines inserted before the final `payload@-` line (each should end with ` ^`).
 * Used by Grok to attach `grokHome` without fragile string replace on the shared template.
 */
export function buildWindowsAgentHookPostCommand(
  source: AgentHookSource,
  extraFormLines: readonly string[] = []
): string {
  // Why: PowerShell startup makes inline per-turn Codex hooks visibly slow, so mirror the POSIX curl path.
  // Why: fully-qualify curl so a repo-local curl.exe can't hijack hook payloads.
  return [
    `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/${source}" ^`,
    '  --connect-timeout 0.5 --max-time 1.5 ^',
    '  -H "Content-Type: application/x-www-form-urlencoded" ^',
    '  -H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%" ^',
    '  --data-urlencode "paneKey=%ORCA_PANE_KEY%" ^',
    '  --data-urlencode "tabId=%ORCA_TAB_ID%" ^',
    '  --data-urlencode "launchToken=%ORCA_AGENT_LAUNCH_TOKEN%" ^',
    '  --data-urlencode "worktreeId=%ORCA_WORKTREE_ID%" ^',
    '  --data-urlencode "env=%ORCA_AGENT_HOOK_ENV%" ^',
    '  --data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%" ^',
    '  --data-urlencode "observedAgent=%ORCA_AGENT_HOOK_OBSERVED_AGENT%" ^',
    ...extraFormLines,
    '  --data-urlencode "payload@-" >nul 2>nul'
  ].join('\r\n')
}

// Why: PowerShell per-post costs ~300ms startup and mangles UTF-8 via code-page translation; curl.exe (Win10 1803+) avoids both.
export function buildWindowsAgentHookCurlPostCommand(source: AgentHookSource): string {
  return [
    '"%SystemRoot%\\System32\\curl.exe" -sS -X POST',
    `"http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/${source}"`,
    '--connect-timeout 0.5 --max-time 1.5',
    '-H "Content-Type: application/x-www-form-urlencoded"',
    '-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"',
    '--data-urlencode "paneKey=%ORCA_PANE_KEY%"',
    '--data-urlencode "tabId=%ORCA_TAB_ID%"',
    '--data-urlencode "launchToken=%ORCA_AGENT_LAUNCH_TOKEN%"',
    '--data-urlencode "worktreeId=%ORCA_WORKTREE_ID%"',
    '--data-urlencode "env=%ORCA_AGENT_HOOK_ENV%"',
    '--data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%"',
    '--data-urlencode "observedAgent=%ORCA_AGENT_HOOK_OBSERVED_AGENT%"',
    '--data-urlencode "payload@-"',
    '>nul 2>&1'
  ].join(' ')
}
