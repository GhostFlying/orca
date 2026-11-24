import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  mergeMacUpdateManifests,
  releaseTag,
  verifyAndDescribeAssets,
  verifyReleaseManifests,
  writeReleaseManifests
} from './fork-release-assets.mjs'

const names = [
  'orca-windows-setup.exe',
  'orca-windows-setup.exe.blockmap',
  'latest.yml',
  'orca-linux.AppImage',
  'orca-linux-arm64.AppImage',
  'orca-ide_1.4.188_amd64.deb',
  'orca-ide_1.4.188_arm64.deb',
  'orca-ide-1.4.188.x86_64.rpm',
  'orca-ide-1.4.188.aarch64.rpm',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'orca-macos-x64.dmg',
  'orca-macos-arm64.dmg',
  'Orca-1.4.188-mac.zip',
  'Orca-1.4.188-arm64-mac.zip',
  'latest-mac.yml',
  'orca-mobile-android-0.0.44.apk',
  'orca-mobile-ios-0.0.44-unsigned.ipa'
]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-release-assets-'))
  mkdirSync(join(root, 'nested'))
  for (const name of names) {
    writeFileSync(join(root, 'nested', name), `${name}\n`)
  }
  return root
}

function inputs(directory) {
  return {
    directory,
    candidateSha: 'a'.repeat(40),
    upstreamTag: 'v1.4.188',
    upstreamSha: 'b'.repeat(40),
    desktopVersion: '1.4.188',
    mobileVersion: '0.0.44',
    androidVersionCode: '13',
    androidCertificateSha256: 'c'.repeat(64),
    iosBuildNumber: '1'
  }
}

function splitMacManifestFixture() {
  const root = fixture()
  const nested = join(root, 'nested')
  rmSync(join(nested, 'latest-mac.yml'))
  writeFileSync(
    join(nested, 'latest-mac-x64.yml'),
    `version: 1.4.188
files:
  - url: Orca-1.4.188-mac.zip
    sha512: x64-zip
  - url: orca-macos-x64.dmg
    sha512: x64-dmg
path: Orca-1.4.188-mac.zip
sha512: x64-zip
releaseDate: '2026-10-15T00:00:00.000Z'
`
  )
  writeFileSync(
    join(nested, 'latest-mac-arm64.yml'),
    `version: 1.4.188
files:
  - url: Orca-1.4.188-arm64-mac.zip
    sha512: arm64-zip
  - url: orca-macos-arm64.dmg
    sha512: arm64-dmg
path: Orca-1.4.188-arm64-mac.zip
sha512: arm64-zip
releaseDate: '2026-10-15T00:00:01.000Z'
`
  )
  return root
}

describe('fork release assets', () => {
  it('derives an immutable fork release tag', () => {
    expect(releaseTag('v1.4.188', 'a'.repeat(40))).toBe('v1.4.188-fork.aaaaaaaaaaaa')
  })

  it('accepts one complete cross-platform asset set', () => {
    const metadata = verifyAndDescribeAssets(inputs(fixture()))
    expect(metadata.assets).toHaveLength(names.length)
    expect(metadata.versions.mobileVersion).toBe('0.0.44')
    expect(metadata.androidSigning.certificateSha256).toBe('c'.repeat(64))
  })

  it('merges native-architecture macOS update manifests before describing assets', () => {
    const root = splitMacManifestFixture()
    expect(mergeMacUpdateManifests(root)).toBe(true)
    const manifest = parse(readFileSync(join(root, 'latest-mac.yml'), 'utf8'))
    expect(manifest.path).toBe('Orca-1.4.188-mac.zip')
    expect(manifest.files.map((file) => file.url)).toEqual([
      'Orca-1.4.188-mac.zip',
      'orca-macos-x64.dmg',
      'Orca-1.4.188-arm64-mac.zip',
      'orca-macos-arm64.dmg'
    ])
    expect(existsSync(join(root, 'nested', 'latest-mac-x64.yml'))).toBe(false)
    expect(existsSync(join(root, 'nested', 'latest-mac-arm64.yml'))).toBe(false)
    expect(verifyAndDescribeAssets(inputs(root)).assets).toHaveLength(names.length)
  })

  it('rejects an incomplete split macOS update manifest pair', () => {
    const root = splitMacManifestFixture()
    rmSync(join(root, 'nested', 'latest-mac-arm64.yml'))
    expect(() => mergeMacUpdateManifests(root)).toThrow(
      'latest-mac-arm64.yml asset count must be 1, got 0'
    )
  })

  it('rejects a missing platform artifact', () => {
    const root = fixture()
    rmSync(join(root, 'nested', 'orca-mobile-ios-0.0.44-unsigned.ipa'))
    expect(() => verifyAndDescribeAssets(inputs(root))).toThrow('iOS unsigned IPA')
  })

  it('rejects duplicate basenames from merged workflow artifacts', () => {
    const root = fixture()
    writeFileSync(join(root, 'orca-linux.AppImage'), 'duplicate\n')
    expect(() => verifyAndDescribeAssets(inputs(root))).toThrow('duplicate release asset name')
  })

  it('verifies persisted metadata and checksums after download', () => {
    const root = fixture()
    const metadata = verifyAndDescribeAssets(inputs(root))
    writeReleaseManifests(root, metadata)
    expect(
      verifyReleaseManifests(root, {
        candidateSha: 'a'.repeat(40),
        upstreamTag: 'v1.4.188',
        upstreamSha: 'b'.repeat(40),
        androidCertificateSha256: 'c'.repeat(64)
      })
    ).toEqual(metadata)
    writeFileSync(join(root, 'nested', 'orca-linux.AppImage'), 'tampered\n')
    expect(() =>
      verifyReleaseManifests(root, {
        candidateSha: 'a'.repeat(40),
        upstreamTag: 'v1.4.188',
        upstreamSha: 'b'.repeat(40),
        androidCertificateSha256: 'c'.repeat(64)
      })
    ).toThrow('metadata does not match')
  })
})
