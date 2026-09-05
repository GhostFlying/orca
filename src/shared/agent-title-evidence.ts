import {
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  containsAgentSpinnerGlyph,
  isClaudeIdentityFrameSegment,
  isClaudeManagementTitle,
  isCursorNativeAgentTitle
} from './agent-title-core'
import { findAgentNamesInTitle } from './agent-title-name-tokens'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import { isDeepSeekBuildTerminalTitle } from './dsb-terminal-title'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { getPiCompatibleSyntheticAgentLabel } from './pi-compatible-synthetic-title'
import {
  SYNTHETIC_AGENT_TITLE_AGENTS,
  SYNTHETIC_AGENT_TITLE_PROFILES
} from './synthetic-agent-title'
import type { ObservedAgent } from './observed-agent'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

/** Collect before ranking: anchored identity names outrank vendor glyphs, which outrank free-text mentions. Free text alone never identifies a pane; prefer no icon to a wrong one. Activity parsing handles generic busy signals separately. */
export type AgentTitleEvidenceReason =
  | 'anchored'
  | 'vendor-marker'
  | 'conflicting-anchored-names'
  | 'conflicting-vendor-markers'
  | 'free-text-only'
  | 'no-evidence'

export type AgentTitleEvidence = {
  readonly vendorMarkers: readonly ObservedAgent[]
  readonly anchoredNames: readonly ObservedAgent[]
  readonly freeTextNames: readonly ObservedAgent[]
  /** Null whenever the title cannot answer on its own. Callers fall back to stronger signals. */
  readonly agent: ObservedAgent | null
  readonly reason: AgentTitleEvidenceReason
}

/** Catalog labels known to be emitted as terminal titles, not merely presented in Orca's UI. */
const EMITTED_DISPLAY_LABEL_AGENTS = [
  'claude-agent-teams',
  'mimo-code',
  'prime-agent',
  'command-code',
  'copilot'
] as const satisfies readonly ObservedAgent[]

const DISPLAY_LABELS = [
  ...EMITTED_DISPLAY_LABEL_AGENTS.map(
    (agent) => [TUI_AGENT_DISPLAY_NAMES[agent].toLowerCase(), agent] as const
  ),
  ['claude code', 'claude'],
  ['gemini cli', 'gemini'],
  ['agent teams', 'claude-agent-teams']
] satisfies readonly (readonly [string, ObservedAgent])[]

const GEMINI_GLYPHS = [GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION]
const ANTIGRAVITY_MODEL_TITLE_RE = /^(?:agy|antigravity)(?:\s*[\u00B7\u2014:-]\s*|\s+)gemini\s+\d/i

/** Orca owns the final - <agent> suffix. Require leading whitespace to avoid treating hyphenated cwd names as ownership. */
const OWNER_SUFFIX_RE = /\s-\s+([A-Za-z][\w-]*)\s*$/
const WINDOWS_LAUNCHER_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1)$/i
const WRAPPER_SEPARATOR = ' | '
const MAX_WRAPPER_EVIDENCE_SEGMENTS = 8
const RESERVED_OWNER_IDS: ReadonlyMap<string, ObservedAgent> = new Map([
  ['pi', 'pi'],
  ['omp', 'omp'],
  ['claude-agent-teams', 'claude-agent-teams'],
  ['qwen-code', 'qwen-code']
])

function getEvidenceTitleSegments(title: string): string[] {
  const segments = [title]
  let separatorIndex = title.lastIndexOf(WRAPPER_SEPARATOR)
  while (separatorIndex >= 0 && segments.length < MAX_WRAPPER_EVIDENCE_SEGMENTS) {
    const wrapped = title.slice(separatorIndex + WRAPPER_SEPARATOR.length).trim()
    if (wrapped && !segments.includes(wrapped)) {
      segments.push(wrapped)
    }
    const previousSeparatorIndex = separatorIndex
    separatorIndex = title.lastIndexOf(WRAPPER_SEPARATOR, separatorIndex - 1)
    if (separatorIndex === previousSeparatorIndex) {
      break
    }
  }
  return segments
}

function stripBareNameDecoration(text: string): string {
  return text
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
}

function agentForBareName(text: string): ObservedAgent | null {
  const trimmed = text.trim()
  if (!trimmed || /[\\/]/.test(trimmed)) {
    return null
  }
  const stripped = stripBareNameDecoration(trimmed)
  // The entire vendor display label makes the same identity claim as a bare agent token.
  const normalized = stripped.toLowerCase()
  const label = DISPLAY_LABELS.find(([text]) => text === normalized)
  if (label) {
    return label[1]
  }
  const bareToken = stripped.replace(WINDOWS_LAUNCHER_SUFFIX_RE, '')
  const names = findAgentNamesInTitle(bareToken)
  // Require the whole remainder to be the name; task phrases and hyphenated directories cannot anchor identity.
  return names.length === 1 && /^[\p{L}\p{N}]+$/u.test(bareToken) ? names[0] : null
}

function agentForWholeTitle(text: string): ObservedAgent | null {
  const trimmed = text.trim()
  if (!trimmed || /[\\/]/.test(trimmed)) {
    return null
  }
  const stripped = stripBareNameDecoration(trimmed)
  const normalized = stripped.toLowerCase()
  const label = DISPLAY_LABELS.find(([text]) => text === normalized)
  if (label) {
    return label[1]
  }
  if (!WINDOWS_LAUNCHER_SUFFIX_RE.test(stripped)) {
    return null
  }
  return agentForBareName(stripped)
}

function agentForOwnerSuffix(text: string): ObservedAgent | null {
  const normalized = text.trim().toLowerCase()
  return RESERVED_OWNER_IDS.get(normalized) ?? agentForBareName(text)
}

function agentForSyntheticTitle(text: string): ObservedAgent | null {
  const trimmed = text.trim()
  if (/[\\/]/.test(trimmed)) {
    return null
  }
  const normalized = trimmed.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase()
  for (const agent of SYNTHETIC_AGENT_TITLE_AGENTS) {
    const profile = SYNTHETIC_AGENT_TITLE_PROFILES[agent]
    const emittedLabels = [profile.permissionLabel, profile.idleLabel]
    if (profile.synthesizeWorkingTitle !== false) {
      // Working labels are emitted only as spinner frames; a bare name is free text.
      if (
        profile.synthesizeTerminalTitle !== false &&
        containsAgentSpinnerGlyph(trimmed) &&
        normalized === profile.workingLabel.toLowerCase()
      ) {
        return agent
      }
    }
    if (
      profile.synthesizeTerminalTitle !== false &&
      emittedLabels.some((label) => normalized === label.toLowerCase())
    ) {
      return agent
    }
  }
  return null
}

function collectVendorMarkers(segments: readonly string[]): ObservedAgent[] {
  const markers = new Set<ObservedAgent>()
  for (const segment of segments) {
    // Only a leading identity-position sigil counts; the same glyph inside task text is decoration.
    if (GEMINI_GLYPHS.some((glyph) => segment.startsWith(glyph))) {
      markers.add('gemini')
    }
    if (
      segment.startsWith(`${CLAUDE_IDLE} `) ||
      segment === CLAUDE_IDLE ||
      segment.startsWith('. ') ||
      segment.startsWith('* ')
    ) {
      markers.add('claude')
    }
    if (isCursorNativeAgentTitle(segment)) {
      markers.add('cursor')
    }
  }
  return [...markers]
}

function namesConsumedByAnchoredLabels(
  segments: readonly string[],
  anchoredNames: ReadonlySet<ObservedAgent>
): Set<ObservedAgent> {
  const consumed = new Set<ObservedAgent>()
  for (const segment of segments) {
    const normalized = stripBareNameDecoration(segment).toLowerCase()
    const label = DISPLAY_LABELS.find(([text]) => text === normalized)
    if (label && anchoredNames.has(label[1])) {
      for (const name of findAgentNamesInTitle(label[0])) {
        consumed.add(name)
      }
    }
  }
  return consumed
}

function collectAnchoredNames(
  segments: readonly string[],
  vendorMarkers: readonly ObservedAgent[]
): ObservedAgent[] {
  const anchored = new Set<ObservedAgent>()
  // Why: a native owner's task text can end with DSB's product-name suffix, including inside wrappers.
  const allowDsbTitle = vendorMarkers.length === 0 && !segments.some(isOpenCodeNativeTitle)

  for (const segment of segments) {
    // Native wrapped titles own their envelope even when session text names other agents.
    if (isOpenCodeNativeTitle(segment)) {
      anchored.add('opencode')
    }
    if (allowDsbTitle && isDeepSeekBuildTerminalTitle(segment)) {
      anchored.add('dsb')
    }

    const suffix = OWNER_SUFFIX_RE.exec(segment)
    if (suffix) {
      const agent = agentForOwnerSuffix(suffix[1])
      if (agent) {
        anchored.add(agent)
      }
    }

    // Strip the leading sigil to expose anchored names: in ✳ agy, the name outranks the inherited Claude glyph.
    const withoutSigil = segment.startsWith(`${CLAUDE_IDLE} `)
      ? segment.slice(CLAUDE_IDLE.length)
      : segment
    const bare = agentForWholeTitle(withoutSigil)
    if (bare) {
      anchored.add(bare)
    }
    const synthetic = agentForSyntheticTitle(segment)
    if (synthetic) {
      anchored.add(synthetic)
    }
    if (isClaudeIdentityFrameSegment(segment)) {
      anchored.add('claude')
    }

    // Parse agy identity plus Gemini model metadata structurally instead of giving Gemini a competitor-specific exception.
    const undecorated = stripLeadingAgentTitleDecorationOrEmpty(segment).trim()
    if (ANTIGRAVITY_MODEL_TITLE_RE.test(undecorated)) {
      anchored.add('antigravity')
    }

    const piCompatible = getPiCompatibleSyntheticAgentLabel(segment)
    if (piCompatible === 'Pi') {
      anchored.add('pi')
    } else if (piCompatible === 'OMP') {
      anchored.add('omp')
    }
  }

  return [...anchored]
}

/** Collects every identity signal in `title` and ranks them by class, never by declaration order. */
export function collectAgentTitleEvidence(title: string): AgentTitleEvidence {
  const empty = { vendorMarkers: [], anchoredNames: [], freeTextNames: [] } as const
  if (!title.trim() || isClaudeManagementTitle(title)) {
    // Why: a `claude agents` management screen is Claude's own UI, not an agent session.
    return { ...empty, agent: null, reason: 'no-evidence' }
  }

  const segments = getEvidenceTitleSegments(title)
  const vendorMarkers = collectVendorMarkers(segments)
  const anchoredNames = collectAnchoredNames(segments, vendorMarkers)
  const anchoredSet = new Set(anchoredNames)
  const anchoredLabelNames = namesConsumedByAnchoredLabels(segments, anchoredSet)
  const freeTextNames = findAgentNamesInTitle(title).filter(
    (agent) => !anchoredSet.has(agent) && !anchoredLabelNames.has(agent)
  )
  const evidence = { vendorMarkers, anchoredNames, freeTextNames } as const

  if (anchoredNames.length === 1) {
    // Why anchored beats a vendor marker: `✳ agy` is an agy pane whose title kept Claude's sigil.
    return { ...evidence, agent: anchoredNames[0], reason: 'anchored' }
  }
  if (anchoredNames.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-anchored-names' }
  }
  if (vendorMarkers.length > 1) {
    return { ...evidence, agent: null, reason: 'conflicting-vendor-markers' }
  }
  if (vendorMarkers.length === 1) {
    // Free-text names cannot veto a vendor glyph (✳ Fix Codex… is Claude); a conflicting anchored name already outranks it.
    return { ...evidence, agent: vendorMarkers[0], reason: 'vendor-marker' }
  }
  return {
    ...evidence,
    agent: null,
    reason: freeTextNames.length > 0 ? 'free-text-only' : 'no-evidence'
  }
}
