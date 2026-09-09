import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const config = require('./fork-electron-builder-config.cjs')

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
    expect(config.mac.notarize).toBe(false)
  })
})
