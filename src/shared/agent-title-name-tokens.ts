import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAgentName
} from './agent-title-core'
import type { ObservedAgent } from './observed-agent'

const NAME_TOKENS: readonly (readonly [string, ObservedAgent])[] = [
  ['claude', 'claude'],
  ['openclaude', 'openclaude'],
  ['codex', 'codex'],
  ['trae', 'trae'],
  ['traecli', 'trae'],
  ['traex', 'traex'],
  ['copilot', 'copilot'],
  ['cursor', 'cursor'],
  ['gemini', 'gemini'],
  ['antigravity', 'antigravity'],
  ['opencode', 'opencode'],
  ['mimo', 'mimo-code'],
  ['openclaw', 'openclaw'],
  ['aider', 'aider'],
  ['grok', 'grok'],
  ['devin', 'devin']
]

const PATTERN_NAMES: readonly (readonly [RegExp, ObservedAgent])[] = [
  [AGY_AGENT_NAME_RE, 'antigravity'],
  [DROID_AGENT_NAME_RE, 'droid'],
  [HERMES_AGENT_NAME_RE, 'hermes']
]

export function findAgentNamesInTitle(text: string): ObservedAgent[] {
  const found = new Set<ObservedAgent>()
  for (const [token, agent] of NAME_TOKENS) {
    if (titleHasAgentName(text, token)) {
      found.add(agent)
    }
  }
  for (const [pattern, agent] of PATTERN_NAMES) {
    if (pattern.test(text)) {
      found.add(agent)
    }
  }
  return [...found]
}
