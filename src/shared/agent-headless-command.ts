import { isAnteHeadlessOneShotCommand } from './ante-headless-command'
import { isPrimeAgentHeadlessOneShotCommand } from './prime-agent-headless-command'
import { isPrintModeHeadlessOneShotCommand } from './print-mode-headless-command'
import type { ObservedAgent } from './observed-agent'

// Why: a table keeps each CLI's non-interactive contract isolated. TraeX uses
// `-p` for profiles, unlike legacy Trae's print mode.
const HEADLESS_ONE_SHOT_MATCHERS: Partial<
  Record<ObservedAgent, (tokens: readonly string[]) => boolean>
> = {
  claude: isPrintModeHeadlessOneShotCommand,
  trae: isPrintModeHeadlessOneShotCommand,
  traex: isTraexHeadlessOneShotCommand,
  'prime-agent': isPrimeAgentHeadlessOneShotCommand,
  ante: isAnteHeadlessOneShotCommand
}

const TRAEX_NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'backend',
  'dashboard',
  'exec',
  'e',
  'review',
  'login',
  'update',
  'logout',
  'mcp',
  'plugin',
  'channel',
  'mcp-server',
  'acp',
  'app-server',
  'remote-control',
  'completion',
  'sandbox',
  'debug',
  'models',
  'apply',
  'a',
  'archive',
  'delete',
  'unarchive',
  'exec-server',
  'features',
  'doctor',
  'migrate',
  'help'
])
const TRAEX_NON_INTERACTIVE_OPTIONS = new Set(['-V', '-v', '--version', '-h', '--help', '--acp'])
const TRAEX_OPTIONS_WITH_OPTIONAL_VALUE = new Set(['--resume', '-w', '--worktree'])
const TRAEX_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '--disabled-tool',
  '--worktree-base',
  '--worktree-mode',
  '--session-id',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '--permission-mode',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval',
  '--allowed-tool',
  '--disallowed-tool',
  '--shell-tool-timeout'
])

function isTraexHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return false
    }
    if (TRAEX_NON_INTERACTIVE_OPTIONS.has(token)) {
      return true
    }
    if (token.startsWith('-')) {
      const option = token.split('=', 1)[0] ?? token
      if (
        option === token &&
        (TRAEX_OPTIONS_WITH_VALUE.has(option) ||
          (TRAEX_OPTIONS_WITH_OPTIONAL_VALUE.has(option) &&
            tokens[index + 1] !== undefined &&
            !tokens[index + 1]!.startsWith('-') &&
            !TRAEX_NON_INTERACTIVE_SUBCOMMANDS.has(tokens[index + 1]!.toLowerCase())))
      ) {
        index += 1
      }
      continue
    }
    return TRAEX_NON_INTERACTIVE_SUBCOMMANDS.has(token.toLowerCase())
  }
  return false
}

export function isHeadlessOneShotAgentCommand(
  agent: ObservedAgent,
  tokens: readonly string[]
): boolean {
  return HEADLESS_ONE_SHOT_MATCHERS[agent]?.(tokens) ?? false
}

type AgentCommandRecognition = { agent: ObservedAgent } | null

export function filterHeadlessOneShotAgentCommand<T extends AgentCommandRecognition>(
  recognition: T,
  tokens: readonly string[]
): T | null {
  if (recognition && isHeadlessOneShotAgentCommand(recognition.agent, tokens)) {
    return null
  }
  return recognition
}
