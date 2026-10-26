import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const buildText = readFileSync(
  new URL('../workflows/fork-release-build.yml', import.meta.url),
  'utf8'
)
const syncText = readFileSync(
  new URL('../workflows/sync-upstream-release.yml', import.meta.url),
  'utf8'
)
const hotfixText = readFileSync(
  new URL('../workflows/fork-hotfix-candidate.yml', import.meta.url),
  'utf8'
)
const stateText = readFileSync(new URL('./fork-maintenance-state.mjs', import.meta.url), 'utf8')
const desktop = parse(buildText).jobs.desktop
const expression = (value) => ['$', '{{ ', value, ' }}'].join('')

describe('fork release macOS build workflow', () => {
  it('builds each architecture on a native runner', () => {
    expect(desktop.strategy.matrix.include).toContainEqual({
      platform: 'macos-x64',
      mac_arch: 'x64',
      os: 'macos-15-intel'
    })
    expect(desktop.strategy.matrix.include).toContainEqual({
      platform: 'macos-arm64',
      mac_arch: 'arm64',
      os: 'macos-15'
    })
    const macInstall = desktop.steps.find(
      (step) => step.name === 'Install macOS release dependencies'
    )
    expect(macInstall.if).toBe("runner.os == 'macOS'")
    expect(macInstall.with.command).toBe('pnpm install:release')
    expect(
      desktop.steps.some((step) => step.uses === './.github/actions/install-mobile-dependencies')
    ).toBe(true)
  })

  it('verifies each signed native artifact before staging it', () => {
    const steps = desktop.steps
    const packageStep = steps.find((step) => step.name === 'Package ad-hoc macOS client')
    const verification = steps.find(
      (step) => step.name === 'Verify complete ad-hoc macOS signatures'
    )
    expect(packageStep.env).toEqual({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_NAME: '-',
      ORCA_COMPUTER_MACOS_SIGN_IDENTITY: '-',
      ORCA_FORK_MAC_ARCH: expression('matrix.mac_arch')
    })
    expect(packageStep.uses).toBe('nick-fields/retry@v4')
    expect(packageStep.with.max_attempts).toBe(3)
    expect(packageStep.with.command).toContain(
      `config/scripts/pinned-node-downloads.mjs darwin-${expression('matrix.mac_arch')}`
    )
    expect(packageStep.with.command).toContain(
      `electron-builder --config config/scripts/fork-electron-builder-config.cjs --mac --${expression('matrix.mac_arch')} --publish never`
    )
    expect(packageStep.if).toBe("runner.os == 'macOS'")
    expect(verification.if).toBe("runner.os == 'macOS'")
    expect(verification.run).toBe(
      `node .github/scripts/verify-fork-macos-signatures.mjs dist ${expression('matrix.mac_arch')}`
    )
    const stage = steps.find((step) => step.name === 'Stage desktop release assets')
    expect(stage.run).toContain('latest-mac-x64.yml')
    expect(stage.run).toContain('latest-mac-arm64.yml')
    expect(steps.indexOf(verification)).toBeGreaterThan(steps.indexOf(packageStep))
    expect(steps.indexOf(verification)).toBeLessThan(steps.indexOf(stage))
  })

  it('keeps signature verification in every maintenance path allowlist', () => {
    for (const path of [
      '.github/scripts/fork-release-build-macos.test.mjs',
      '.github/scripts/verify-fork-macos-signatures.mjs',
      '.github/scripts/verify-fork-macos-signatures.test.mjs'
    ]) {
      expect(syncText).toContain(path)
      expect(hotfixText).toContain(path)
      expect(stateText).toContain(`'${path}'`)
    }
  })
})
