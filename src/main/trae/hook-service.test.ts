import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as osModule from 'node:os'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock }
})

import { TraeHookService } from './hook-service'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries
} from '../codex/config-toml-trust'
import { findTraeManagedTrustEntries } from './trae-hook-config'

let home: string
let previousTraeHome: string | undefined
let previousTraeCliHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-trae-hooks-'))
  homedirMock.mockReturnValue(home)
  previousTraeHome = process.env.TRAE_HOME
  previousTraeCliHome = process.env.TRAECLI_HOME
  delete process.env.TRAE_HOME
  delete process.env.TRAECLI_HOME
})

afterEach(() => {
  homedirMock.mockReset()
  if (previousTraeHome === undefined) {
    delete process.env.TRAE_HOME
  } else {
    process.env.TRAE_HOME = previousTraeHome
  }
  if (previousTraeCliHome === undefined) {
    delete process.env.TRAECLI_HOME
  } else {
    process.env.TRAECLI_HOME = previousTraeCliHome
  }
  rmSync(home, { recursive: true, force: true })
})

describe('TraeHookService', () => {
  it('installs idempotent hooks and enables the existing Trae feature', () => {
    const traeHome = join(home, '.trae')
    const cliHome = join(traeHome, 'cli')
    mkdirSync(cliHome, { recursive: true })
    writeFileSync(
      join(cliHome, 'hooks.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] },
        note: 'keep'
      })
    )
    writeFileSync(join(traeHome, 'traecli.toml'), '[features]\nhooks = false\nother = true\n')
    const service = new TraeHookService()

    expect(service.install().state).toBe('installed')
    const firstHooks = readFileSync(join(cliHome, 'hooks.json'), 'utf8')
    const firstToml = readFileSync(join(traeHome, 'traecli.toml'), 'utf8')
    expect(service.install().state).toBe('installed')
    expect(readFileSync(join(cliHome, 'hooks.json'), 'utf8')).toBe(firstHooks)
    expect(readFileSync(join(traeHome, 'traecli.toml'), 'utf8')).toBe(firstToml)

    const config = JSON.parse(firstHooks)
    expect(config.note).toBe('keep')
    expect(config.hooks.Stop[0].hooks[0].command).toBe('user-hook')
    expect(config.hooks.Stop[1].hooks[0].command).toContain('trae-hook')
    expect(firstToml).toContain('[features]\nhooks = true\nother = true')
    const entries = findTraeManagedTrustEntries(config, join(cliHome, 'hooks.json'))
    const trust = readHookTrustEntries(join(traeHome, 'traecli.toml'))
    for (const entry of entries) {
      expect(trust.get(computeTrustKey(entry))).toEqual({
        enabled: true,
        trustedHash: computeTrustedHash(entry)
      })
    }
  })

  it('removes only Orca hooks and trust while keeping hooks enabled', () => {
    const traeHome = join(home, '.trae')
    const cliHome = join(traeHome, 'cli')
    const service = new TraeHookService()
    expect(service.install().state).toBe('installed')
    const hooksPath = join(cliHome, 'hooks.json')
    const config = JSON.parse(readFileSync(hooksPath, 'utf8'))
    config.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'user-hook' }] })
    writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`)

    expect(service.remove().state).toBe('not_installed')
    const removed = JSON.parse(readFileSync(hooksPath, 'utf8'))
    expect(removed.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-hook' }] }])
    expect(readFileSync(join(traeHome, 'traecli.toml'), 'utf8')).toContain('hooks = true')
    expect(readFileSync(join(traeHome, 'traecli.toml'), 'utf8')).not.toContain('trae-hook')
    expect(existsSync(join(home, '.orca', 'agent-hooks', 'trae-hook.sh'))).toBe(true)
  })

  it('honors separate TRAE_HOME and TRAECLI_HOME paths', () => {
    process.env.TRAE_HOME = join(home, 'config')
    process.env.TRAECLI_HOME = join(home, 'runtime')
    const service = new TraeHookService()

    expect(service.install().state).toBe('installed')
    expect(existsSync(join(home, 'runtime', 'hooks.json'))).toBe(true)
    expect(readFileSync(join(home, 'config', 'traecli.toml'), 'utf8')).toContain('hooks = true')
  })
})
