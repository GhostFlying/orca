import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

function loadConfig(macArchitecture) {
  const path = require.resolve('./fork-electron-builder-config.cjs')
  const previous = process.env.ORCA_FORK_MAC_ARCH
  if (macArchitecture) {
    process.env.ORCA_FORK_MAC_ARCH = macArchitecture
  } else {
    delete process.env.ORCA_FORK_MAC_ARCH
  }
  delete require.cache[path]
  try {
    return require(path)
  } finally {
    if (previous === undefined) {
      delete process.env.ORCA_FORK_MAC_ARCH
    } else {
      process.env.ORCA_FORK_MAC_ARCH = previous
    }
    delete require.cache[path]
  }
}

const config = loadConfig()

describe('fork Electron Builder config', () => {
  it('targets the fork release repository', () => {
    expect(config.publish).toMatchObject({
      provider: 'github',
      owner: 'GhostFlying',
      repo: 'orca',
      releaseType: 'prerelease'
    })
  })

  it('does not claim a Windows signing publisher', () => {
    expect(config.win.verifyUpdateCodeSignature).toBe(false)
    expect(config.win.signtoolOptions).toBeUndefined()
  })

  it('keeps macOS outside the trusted release-signing path', () => {
    expect(config.forceCodeSigning).toBe(false)
    expect(config.mac.identity).toBe('-')
    expect(config.mac.hardenedRuntime).toBe(false)
    expect(config.mac.notarize).toBe(false)
    expect(config.mac.target).toEqual([
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] }
    ])
  })

  it.each(['x64', 'arm64'])('limits macOS targets to the requested %s architecture', (arch) => {
    expect(loadConfig(arch).mac.target).toEqual([
      { target: 'dmg', arch: [arch] },
      { target: 'zip', arch: [arch] }
    ])
  })

  it('rejects an unsupported macOS architecture', () => {
    expect(() => loadConfig('riscv64')).toThrow('Unsupported ORCA_FORK_MAC_ARCH: riscv64')
  })
})
