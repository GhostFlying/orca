import { describe, expect, it } from 'vitest'
import { parsePosixTraeHomeProbeOutput, resolveTraeHomePaths } from './trae-home-paths'

describe('Trae home paths', () => {
  it('uses TRAECLI_HOME independently from TRAE_HOME', () => {
    expect(
      resolveTraeHomePaths({
        homeDir: '/home/dev',
        env: { TRAE_HOME: '/home/dev/.config/trae', TRAECLI_HOME: '/home/dev/.cache/traecli' },
        platform: 'linux'
      })
    ).toEqual({
      traeHomeDir: '/home/dev/.config/trae',
      traeCliHomeDir: '/home/dev/.cache/traecli'
    })
  })

  it('falls back and confines remote paths to the guest home', () => {
    expect(
      parsePosixTraeHomeProbeOutput(
        '/home/dev',
        '__ORCA_TRAE_HOME__/srv/other\n__ORCA_TRAECLI_HOME__../relative\n'
      )
    ).toEqual({ traeHomeDir: '/home/dev/.trae', traeCliHomeDir: '/home/dev/.trae/cli' })
  })
})
