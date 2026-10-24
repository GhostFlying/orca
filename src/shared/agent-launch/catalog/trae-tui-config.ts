import type { TuiAgentConfigSource } from './tui-agent-config-types'

export const TRAE_TUI_CONFIG = {
  // Use TRAE CN’s unique traecli alias; unrelated bytedance/trae-agent also installs trae-cli.
  detectCmd: 'traecli',
  promptInjectionMode: 'argv',
  // Cobra’s -- stops subcommands and flags from consuming prompt text such as help/config/-….
  argvPromptSeparator: '--',
  preflightTrust: 'trae',
  draftPasteReadySignal: 'trae-composer-prompt'
} satisfies TuiAgentConfigSource
