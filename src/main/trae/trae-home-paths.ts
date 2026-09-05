import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export type TraeHomePaths = {
  traeHomeDir: string
  traeCliHomeDir: string
}

export const TRAE_HOME_PROBE_MAX_LENGTH = 4096
const TRAE_HOME_PREFIX = '__ORCA_TRAE_HOME__'
const TRAECLI_HOME_PREFIX = '__ORCA_TRAECLI_HOME__'

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function validAbsolutePath(value: string | undefined, platform: NodeJS.Platform): string | null {
  const candidate = value?.trim() ?? ''
  if (candidate.length === 0 || candidate !== value || hasControlCharacter(candidate)) {
    return null
  }
  const pathOps = platform === 'win32' ? win32 : posix
  return pathOps.isAbsolute(candidate) ? pathOps.normalize(candidate) : null
}

export function resolveTraeHomePaths(options: {
  homeDir: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): TraeHomePaths {
  const platform = options.platform ?? process.platform
  const pathOps = platform === 'win32' ? win32 : posix
  const env = options.env ?? process.env
  const traeHomeDir =
    validAbsolutePath(env.TRAE_HOME, platform) ?? pathOps.join(options.homeDir, '.trae')
  const traeCliHomeDir =
    validAbsolutePath(env.TRAECLI_HOME, platform) ?? pathOps.join(traeHomeDir, 'cli')
  return { traeHomeDir, traeCliHomeDir }
}

export function getLocalTraeHomePaths(): TraeHomePaths {
  return resolveTraeHomePaths({ homeDir: homedir() })
}

export function normalizePosixTraeHomePaths(
  homeDir: string,
  values: { traeHomeDir?: string; traeCliHomeDir?: string }
): TraeHomePaths {
  const defaults = resolveTraeHomePaths({ homeDir, env: {}, platform: 'linux' })
  const resolved = resolveTraeHomePaths({
    homeDir,
    env: { TRAE_HOME: values.traeHomeDir, TRAECLI_HOME: values.traeCliHomeDir },
    platform: 'linux'
  })
  const homeRoot = posix.resolve(homeDir)
  const withinHome = (candidate: string): boolean =>
    candidate === homeRoot || candidate.startsWith(`${homeRoot}/`)
  return {
    traeHomeDir: withinHome(resolved.traeHomeDir) ? resolved.traeHomeDir : defaults.traeHomeDir,
    traeCliHomeDir: withinHome(resolved.traeCliHomeDir)
      ? resolved.traeCliHomeDir
      : defaults.traeCliHomeDir
  }
}

export function buildPosixTraeHomeProbeScript(): string {
  return [
    `printf '${TRAE_HOME_PREFIX}%s\n' "$TRAE_HOME"`,
    `printf '${TRAECLI_HOME_PREFIX}%s\n' "$TRAECLI_HOME"`
  ].join('; ')
}

export function parsePosixTraeHomeProbeOutput(homeDir: string, output: string): TraeHomePaths {
  let traeHomeDir: string | undefined
  let traeCliHomeDir: string | undefined
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(TRAE_HOME_PREFIX)) {
      traeHomeDir = line.slice(
        TRAE_HOME_PREFIX.length,
        TRAE_HOME_PREFIX.length + TRAE_HOME_PROBE_MAX_LENGTH
      )
    } else if (line.startsWith(TRAECLI_HOME_PREFIX)) {
      traeCliHomeDir = line.slice(
        TRAECLI_HOME_PREFIX.length,
        TRAECLI_HOME_PREFIX.length + TRAE_HOME_PROBE_MAX_LENGTH
      )
    }
  }
  return normalizePosixTraeHomePaths(homeDir, { traeHomeDir, traeCliHomeDir })
}
