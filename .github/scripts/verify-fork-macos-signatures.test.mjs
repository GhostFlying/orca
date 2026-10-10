import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertAdhocSignature,
  verifyForkMacApp,
  verifyForkMacArtifacts
} from './verify-fork-macos-signatures.mjs'

describe('fork macOS signature identity', () => {
  it('accepts complete ad-hoc signatures without a certificate', () => {
    expect(() =>
      assertAdhocSignature('Signature=adhoc\nTeamIdentifier=not set\n', 'app')
    ).not.toThrow()
  })

  it('rejects the linker-only signature from the broken release', () => {
    expect(() =>
      assertAdhocSignature(
        'CodeDirectory flags=0x20002(adhoc,linker-signed)\nSignature=adhoc\n',
        'app'
      )
    ).toThrow('complete ad-hoc signature')
  })

  it.each([
    'Signature=adhoc\nAuthority=Developer ID Application: Test\n',
    'Signature=adhoc\nTeamIdentifier=TESTTEAM\n',
    'Signature size=1234\nAuthority=Developer ID Application: Test\n'
  ])('rejects certificate-based identities: %s', (details) => {
    expect(() => assertAdhocSignature(details, 'app')).toThrow()
  })
})

describe.skipIf(process.platform !== 'darwin')('native fork macOS signature gate', () => {
  let directory
  let executable
  let app

  function run(command, args) {
    execFileSync(command, args, { stdio: 'pipe' })
  }

  function createBundle(path, identifier) {
    mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(path, 'Contents', 'Resources'), { recursive: true })
    cpSync(executable, join(path, 'Contents', 'MacOS', 'fixture'))
    writeFileSync(join(path, 'Contents', 'Resources', 'asset.txt'), 'original')
    writeFileSync(
      join(path, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`
    )
  }

  function signApp() {
    for (const target of [
      join(app, 'Contents', 'Frameworks', 'Orca Helper.app'),
      join(app, 'Contents', 'Resources', 'Orca Computer Use.app'),
      join(app, 'Contents', 'MacOS', 'orca-notification-status'),
      join(app, 'Contents', 'MacOS', 'orca-keyboard-layout'),
      app
    ]) {
      run('codesign', ['--force', '--sign', '-', target])
    }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-signature-test-'))
    const source = join(directory, 'fixture.c')
    executable = join(directory, 'fixture')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    run('cc', [source, '-o', executable])
    app = join(directory, 'Orca.app')
    createBundle(app, 'test.orca')
    createBundle(join(app, 'Contents', 'Frameworks', 'Orca Helper.app'), 'test.orca.helper')
    createBundle(join(app, 'Contents', 'Resources', 'Orca Computer Use.app'), 'test.orca.computer')
    for (const helper of ['orca-notification-status', 'orca-keyboard-layout']) {
      cpSync(executable, join(app, 'Contents', 'MacOS', helper))
    }
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('rejects the unsigned bundle and accepts a fully sealed ad-hoc bundle', () => {
    expect(() => verifyForkMacApp(app)).toThrow()
    signApp()
    expect(() => verifyForkMacApp(app)).not.toThrow()
  })

  it.each([
    ['Contents', 'Resources', 'asset.txt'],
    ['Contents', 'Resources', 'Orca Computer Use.app', 'Contents', 'Resources', 'asset.txt'],
    ['Contents', 'MacOS', 'orca-keyboard-layout']
  ])('rejects tampering at %j', (...components) => {
    signApp()
    writeFileSync(join(app, ...components), 'modified')
    expect(() => verifyForkMacApp(app)).toThrow()
  })

  it('checks all final archives and rejects a damaged ZIP despite valid unpacked apps', () => {
    signApp()
    const dist = join(directory, 'dist')
    const version = '1.2.3'
    for (const unpacked of ['mac', 'mac-arm64']) {
      cpSync(app, join(dist, unpacked, 'Orca.app'), { recursive: true })
    }
    for (const [arch, zipName] of [
      ['x64', `Orca-${version}-mac.zip`],
      ['arm64', `Orca-${version}-arm64-mac.zip`]
    ]) {
      run('ditto', ['-c', '-k', '--keepParent', app, join(dist, zipName)])
      const imageSource = join(directory, `image-${arch}`)
      cpSync(app, join(imageSource, 'Orca.app'), { recursive: true })
      run('hdiutil', [
        'create',
        '-quiet',
        '-srcfolder',
        imageSource,
        '-format',
        'UDZO',
        join(dist, `orca-macos-${arch}.dmg`)
      ])
    }
    expect(() => verifyForkMacArtifacts(dist, version)).not.toThrow()
    writeFileSync(join(app, 'Contents', 'Resources', 'asset.txt'), 'modified')
    const zip = join(dist, `Orca-${version}-arm64-mac.zip`)
    rmSync(zip)
    run('ditto', ['-c', '-k', '--keepParent', app, zip])
    expect(() => verifyForkMacArtifacts(dist, version)).toThrow()
  }, 60_000)
})
