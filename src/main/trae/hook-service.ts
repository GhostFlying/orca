import { existsSync, readFileSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  readHooksJson,
  wrapPosixHookCommand,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  readTextFileRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { getManagedScript } from '../codex/codex-hook-script'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntriesFromContent,
  writeConfigAtomically
} from '../codex/config-toml-trust'
import {
  buildTraeManagedHooksConfig,
  enableAndTrustTraeHooks,
  findTraeManagedTrustEntries,
  removeTraeManagedHooksConfig
} from './trae-hook-config'
import {
  getTraeConfigTomlPath,
  getTraeHooksJsonPath,
  getTraeManagedCommand,
  getTraeManagedScriptFileName,
  getTraeManagedScriptPath,
  hasManagedTraeHooks
} from './trae-hook-definition'
import {
  getLocalTraeHomePaths,
  normalizePosixTraeHomePaths,
  type TraeHomePaths
} from './trae-home-paths'
import { isTraeHooksFeatureEnabled } from './trae-hooks-feature'

function readText(path: string): string {
  if (!existsSync(path)) {
    return ''
  }
  const raw = readFileSync(path, 'utf8')
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

function status(
  state: AgentHookInstallStatus['state'],
  configPath: string,
  managedHooksPresent: boolean,
  detail: string | null = null
): AgentHookInstallStatus {
  return { agent: 'trae', state, configPath, managedHooksPresent, detail }
}

function getTraeHookStatus(paths: TraeHomePaths): AgentHookInstallStatus {
  const configPath = getTraeHooksJsonPath(paths.traeCliHomeDir)
  const config = readHooksJson(configPath)
  if (!config) {
    return status('error', configPath, false, 'Could not parse Trae hooks.json')
  }
  const matches = createManagedCommandMatcher(getTraeManagedScriptFileName())
  if (!hasManagedTraeHooks(config.hooks, matches)) {
    return status('not_installed', configPath, false)
  }
  const toml = readText(getTraeConfigTomlPath(paths.traeHomeDir))
  if (!isTraeHooksFeatureEnabled(toml)) {
    return status('partial', configPath, true, 'Trae hooks feature is disabled')
  }
  const trust = readHookTrustEntriesFromContent(toml)
  const untrusted = findTraeManagedTrustEntries(config, configPath).filter((entry) => {
    const actual = trust.get(computeTrustKey(entry))
    return actual?.enabled !== true || actual.trustedHash !== computeTrustedHash(entry)
  })
  return untrusted.length === 0
    ? status('installed', configPath, true)
    : status('partial', configPath, true, `${untrusted.length} Trae hooks are not trusted`)
}

function installLocal(paths: TraeHomePaths): AgentHookInstallStatus {
  const configPath = getTraeHooksJsonPath(paths.traeCliHomeDir)
  const tomlPath = getTraeConfigTomlPath(paths.traeHomeDir)
  try {
    const config = readHooksJson(configPath)
    if (!config) {
      return status('error', configPath, false, 'Could not parse Trae hooks.json')
    }
    const scriptPath = getTraeManagedScriptPath()
    const plan = buildTraeManagedHooksConfig({
      config,
      configPath,
      command: getTraeManagedCommand(scriptPath)
    })
    writeManagedScript(scriptPath, getManagedScript('local', 'trae'))
    writeHooksJson(configPath, plan.config)
    const existingToml = readText(tomlPath)
    const updatedToml = enableAndTrustTraeHooks(existingToml, plan.trustEntries)
    if (updatedToml !== existingToml) {
      writeConfigAtomically(tomlPath, updatedToml)
    }
    return getTraeHookStatus(paths)
  } catch (error) {
    return status(
      'error',
      configPath,
      false,
      error instanceof Error ? error.message : String(error)
    )
  }
}

async function installRemote(
  sftp: SFTPWrapper,
  remoteHome: string,
  suppliedPaths?: Partial<TraeHomePaths>
): Promise<AgentHookInstallStatus> {
  const paths = normalizePosixTraeHomePaths(remoteHome, suppliedPaths ?? {})
  const configPath = `${paths.traeCliHomeDir}/hooks.json`
  const tomlPath = `${paths.traeHomeDir}/traecli.toml`
  const scriptPath = `${remoteHome.replace(/\/+$/, '')}/.orca/agent-hooks/trae-hook.sh`
  try {
    const config = await readHooksJsonRemote(sftp, configPath)
    if (!config) {
      return status('error', configPath, false, 'Could not parse remote Trae hooks.json')
    }
    const command = wrapPosixHookCommand(scriptPath)
    const plan = buildTraeManagedHooksConfig({ config, configPath, command })
    await writeManagedScriptRemote(sftp, scriptPath, getManagedScript('posix', 'trae'))
    await writeHooksJsonRemote(sftp, configPath, plan.config)
    const existingToml = (await readTextFileRemote(sftp, tomlPath)) ?? ''
    const updatedToml = enableAndTrustTraeHooks(existingToml, plan.trustEntries)
    if (updatedToml !== existingToml) {
      await writeTextFileRemoteAtomic(sftp, tomlPath, updatedToml)
    }
    return status('installed', configPath, true)
  } catch (error) {
    return status(
      'error',
      configPath,
      false,
      error instanceof Error ? error.message : String(error)
    )
  }
}

export class TraeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(
      getTraeManagedScriptPath(),
      getManagedScript('local', 'trae')
    )
  }

  getStatus(): AgentHookInstallStatus {
    return getTraeHookStatus(getLocalTraeHomePaths())
  }

  install(): AgentHookInstallStatus {
    return installLocal(getLocalTraeHomePaths())
  }

  installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    paths?: Partial<TraeHomePaths>
  ): Promise<AgentHookInstallStatus> {
    return installRemote(sftp, remoteHome, paths)
  }

  remove(): AgentHookInstallStatus {
    const paths = getLocalTraeHomePaths()
    const configPath = getTraeHooksJsonPath(paths.traeCliHomeDir)
    const tomlPath = getTraeConfigTomlPath(paths.traeHomeDir)
    try {
      const configExists = existsSync(configPath)
      const config = readHooksJson(configPath)
      if (!config) {
        return status('error', configPath, false, 'Could not parse Trae hooks.json')
      }
      const existingToml = readText(tomlPath)
      const removed = removeTraeManagedHooksConfig({ config, configPath, toml: existingToml })
      if (configExists) {
        writeHooksJson(configPath, removed.config)
      }
      if (removed.toml !== existingToml) {
        writeConfigAtomically(tomlPath, removed.toml)
      }
      return status('not_installed', configPath, false)
    } catch (error) {
      return status(
        'error',
        configPath,
        false,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}

export const traeHookService = new TraeHookService()
