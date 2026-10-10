import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return `${result.stdout}\n${result.stderr}`
}

export function assertAdhocSignature(details, target) {
  if (!/^Signature=adhoc$/m.test(details) || /linker-signed/.test(details)) {
    throw new Error(`Expected a complete ad-hoc signature: ${target}`)
  }
  if (/^Authority=|^TeamIdentifier=(?!not set$)/m.test(details)) {
    throw new Error(`Unexpected signing certificate or Team ID: ${target}`)
  }
}

function verifyCode(target, appBundle = false) {
  if (!existsSync(target)) {
    throw new Error(`Missing signed component: ${target}`)
  }
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', target])
  assertAdhocSignature(run('codesign', ['--display', '--verbose=4', target]), target)
  if (appBundle && !existsSync(join(target, 'Contents', '_CodeSignature', 'CodeResources'))) {
    throw new Error(`Missing sealed resources: ${target}`)
  }
}

export function verifyForkMacApp(appPath) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS signature verification requires macOS')
  }
  verifyCode(appPath, true)
  const frameworks = join(appPath, 'Contents', 'Frameworks')
  verifyCode(join(frameworks, 'Orca Helper.app'), true)
  for (const entry of readdirSync(frameworks)) {
    if (entry.endsWith('.app') && entry !== 'Orca Helper.app') {
      verifyCode(join(frameworks, entry), true)
    }
  }
  verifyCode(join(appPath, 'Contents', 'Resources', 'Orca Computer Use.app'), true)
  for (const helper of ['orca-notification-status', 'orca-keyboard-layout']) {
    verifyCode(join(appPath, 'Contents', 'MacOS', helper))
  }
}

export function verifyForkMacArtifacts(distDirectory, version) {
  for (const directory of ['mac', 'mac-arm64']) {
    verifyForkMacApp(join(distDirectory, directory, 'Orca.app'))
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'orca-fork-signatures-'))
  const mountedVolumes = new Set()
  try {
    for (const [arch, zipName] of [
      ['x64', `Orca-${version}-mac.zip`],
      ['arm64', `Orca-${version}-arm64-mac.zip`]
    ]) {
      const zipDirectory = join(temporaryDirectory, `zip-${arch}`)
      run('ditto', ['-x', '-k', join(distDirectory, zipName), zipDirectory])
      verifyForkMacApp(join(zipDirectory, 'Orca.app'))
      const mountDirectory = join(temporaryDirectory, `dmg-${arch}`)
      mkdirSync(mountDirectory)
      mountedVolumes.add(mountDirectory)
      run('hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-noautoopen',
        '-mountpoint',
        mountDirectory,
        join(distDirectory, `orca-macos-${arch}.dmg`)
      ])
      try {
        verifyForkMacApp(join(mountDirectory, 'Orca.app'))
      } finally {
        run('hdiutil', ['detach', mountDirectory])
        mountedVolumes.delete(mountDirectory)
      }
    }
  } finally {
    if (mountedVolumes.size === 0) {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    } else {
      console.error(
        `Preserving verification directory with an attached or uncertain volume: ${temporaryDirectory}`
      )
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  )
  verifyForkMacArtifacts(resolve(process.argv[2] || 'dist'), version)
  console.log('Verified complete ad-hoc signatures in both macOS apps, ZIPs, and DMGs')
}
