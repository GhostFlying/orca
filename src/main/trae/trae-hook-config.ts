import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  removeManagedCommands,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  codexHookSourcePathsEqual,
  computeTrustedHash,
  parseTrustKey,
  readHookTrustEntriesFromContent,
  removeHookTrustEntriesFromContent,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from '../codex/config-toml-trust'
import { enableTraeHooksFeatureInContent } from './trae-hooks-feature'
import { TRAE_HOOK_EVENTS, TRAE_HOOK_EVENT_LABEL } from './trae-hook-definition'

export function buildTraeManagedHooksConfig(args: {
  config: HooksConfig
  configPath: string
  command: string
}): { config: HooksConfig; trustEntries: CodexTrustEntry[] } {
  const nextHooks = { ...args.config.hooks }
  const isManagedCommand = createManagedCommandMatcher('trae-hook.sh')
  const managedEvents = new Set<string>(TRAE_HOOK_EVENTS)

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (managedEvents.has(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  const trustEntries: CodexTrustEntry[] = []
  for (const eventName of TRAE_HOOK_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    nextHooks[eventName] = [...cleaned, { hooks: [buildManagedCommandHook(args.command)] }]
    trustEntries.push({
      sourcePath: args.configPath,
      eventLabel: TRAE_HOOK_EVENT_LABEL[eventName],
      groupIndex: cleaned.length,
      handlerIndex: 0,
      command: args.command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS,
      enabled: true
    })
  }
  return { config: { ...args.config, hooks: nextHooks }, trustEntries }
}

export function findTraeManagedTrustEntries(
  config: HooksConfig,
  configPath: string
): CodexTrustEntry[] {
  const isManagedCommand = createManagedCommandMatcher('trae-hook.sh')
  const entries: CodexTrustEntry[] = []
  for (const [eventName, definitions] of Object.entries(config.hooks ?? {})) {
    const eventLabel = TRAE_HOOK_EVENT_LABEL[eventName as keyof typeof TRAE_HOOK_EVENT_LABEL]
    if (!eventLabel || !Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      definition.hooks?.forEach((hook, handlerIndex) => {
        if (hook.command && isManagedCommand(hook.command)) {
          entries.push({
            sourcePath: configPath,
            eventLabel,
            groupIndex,
            handlerIndex,
            command: hook.command,
            ...(typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {})
          })
        }
      })
    })
  }
  return entries
}

export function removeTraeManagedHooksConfig(args: {
  config: HooksConfig
  configPath: string
  toml: string
}): { config: HooksConfig; toml: string } {
  const nextHooks = { ...args.config.hooks }
  const isManagedCommand = createManagedCommandMatcher('trae-hook.sh')
  const entries = findTraeManagedTrustEntries(args.config, args.configPath)
  const expectedHashes = new Map(
    entries.map((entry) => [entry.eventLabel, computeTrustedHash(entry)] as const)
  )
  const trustKeys = [
    ...entries.map(computeTrustKey),
    ...[...readHookTrustEntriesFromContent(args.toml).entries()].flatMap(([key, state]) => {
      const parsed = parseTrustKey(key)
      return parsed &&
        codexHookSourcePathsEqual(parsed.sourcePath, args.configPath) &&
        state.trustedHash === expectedHashes.get(parsed.eventLabel)
        ? [key]
        : []
    })
  ]

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  return {
    config: { ...args.config, hooks: nextHooks },
    toml: removeHookTrustEntriesFromContent(args.toml, trustKeys)
  }
}

export function enableAndTrustTraeHooks(
  toml: string,
  trustEntries: readonly CodexTrustEntry[]
): string {
  const enabled = enableTraeHooksFeatureInContent(toml)
  const existing = readHookTrustEntriesFromContent(enabled)
  const alreadyTrusted = trustEntries.every((entry) => {
    const state = existing.get(computeTrustKey(entry))
    return state?.enabled === true && state.trustedHash === computeTrustedHash(entry)
  })
  return alreadyTrusted ? enabled : upsertHookTrustEntriesInContent(enabled, trustEntries)
}
