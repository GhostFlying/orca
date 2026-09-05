import { join } from 'node:path'
import {
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import type { CodexEventLabel } from '../codex/config-toml-trust'
import { CODEX_EVENT_LABEL } from '../codex/codex-hook-definition'

export const TRAE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop'
] as const

export const TRAE_HOOK_EVENT_LABEL: Record<(typeof TRAE_HOOK_EVENTS)[number], CodexEventLabel> =
  CODEX_EVENT_LABEL

export function getTraeManagedScriptFileName(target: 'local' | 'posix' = 'local'): string {
  return target === 'local' && process.platform === 'win32' ? 'trae-hook.cmd' : 'trae-hook.sh'
}

export function getTraeManagedScriptPath(): string {
  return getSharedManagedScriptPath(getTraeManagedScriptFileName())
}

export function getTraeManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsCmdHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export function getTraeHooksJsonPath(traeCliHomeDir: string): string {
  return join(traeCliHomeDir, 'hooks.json')
}

export function getTraeConfigTomlPath(traeHomeDir: string): string {
  return join(traeHomeDir, 'traecli.toml')
}

export function hasManagedTraeHooks(
  hooks: Record<string, HookDefinition[]> | undefined,
  matches: (command: string | undefined) => boolean
): boolean {
  return TRAE_HOOK_EVENTS.every((eventName) =>
    hooks?.[eventName]?.some((definition) =>
      definition.hooks?.some((hook) => matches(hook.command))
    )
  )
}
