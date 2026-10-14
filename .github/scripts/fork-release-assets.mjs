#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseStableTag } from './upstream-release.mjs'

const SHA_PATTERN = /^[0-9a-f]{40}$/
const CERTIFICATE_SHA256_PATTERN = /^[0-9a-f]{64}$/
const REQUIRED_ASSETS = [
  ['Windows installer', /^orca-windows-setup\.exe$/],
  ['Windows blockmap', /^orca-windows-setup\.exe\.blockmap$/],
  ['Windows update manifest', /^latest\.yml$/],
  ['Linux x64 AppImage', /^orca-linux\.AppImage$/],
  ['Linux arm64 AppImage', /^orca-linux-arm64\.AppImage$/],
  ['Linux x64 deb', /^orca-ide_.+_amd64\.deb$/],
  ['Linux arm64 deb', /^orca-ide_.+_arm64\.deb$/],
  ['Linux x64 rpm', /^orca-ide-.+\.x86_64\.rpm$/],
  ['Linux arm64 rpm', /^orca-ide-.+\.aarch64\.rpm$/],
  ['Linux x64 update manifest', /^latest-linux\.yml$/],
  ['Linux arm64 update manifest', /^latest-linux-arm64\.yml$/],
  ['macOS x64 DMG', /^orca-macos-x64\.dmg$/],
  ['macOS arm64 DMG', /^orca-macos-arm64\.dmg$/],
  ['macOS x64 ZIP', /^Orca-\d+\.\d+\.\d+-mac\.zip$/],
  ['macOS arm64 ZIP', /^Orca-\d+\.\d+\.\d+-arm64-mac\.zip$/],
  ['macOS update manifest', /^latest-mac\.yml$/],
  ['Android APK', /^orca-mobile-android-.+\.apk$/],
  ['iOS unsigned IPA', /^orca-mobile-ios-.+-unsigned\.ipa$/]
]

function filesUnder(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...filesUnder(path))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function releaseTag(upstreamTag, candidateSha) {
  if (!parseStableTag(upstreamTag)) {
    throw new Error('upstream tag must match vX.Y.Z')
  }
  if (!SHA_PATTERN.test(candidateSha)) {
    throw new Error('candidate SHA must be lowercase hex')
  }
  return `${upstreamTag}-fork.${candidateSha.slice(0, 12)}`
}

export function verifyAndDescribeAssets({
  directory,
  candidateSha,
  upstreamTag,
  upstreamSha,
  desktopVersion,
  mobileVersion,
  androidVersionCode,
  androidCertificateSha256,
  iosBuildNumber
}) {
  if (!SHA_PATTERN.test(candidateSha)) {
    throw new Error('candidate SHA must be lowercase hex')
  }
  if (!SHA_PATTERN.test(upstreamSha)) {
    throw new Error('upstream SHA must be lowercase hex')
  }
  const parsedTag = parseStableTag(upstreamTag)
  if (!parsedTag || parsedTag.version !== desktopVersion) {
    throw new Error('desktop version must match the upstream stable tag')
  }
  if (!CERTIFICATE_SHA256_PATTERN.test(androidCertificateSha256)) {
    throw new Error('Android certificate SHA-256 must be lowercase hex')
  }

  const root = resolve(directory)
  const paths = filesUnder(root).filter(
    (path) => !['checksums.txt', 'build-metadata.json'].includes(basename(path))
  )
  const byName = new Map()
  for (const path of paths) {
    const name = basename(path)
    if (statSync(path).size === 0) {
      throw new Error(`release asset is empty: ${name}`)
    }
    if (byName.has(name)) {
      throw new Error(`duplicate release asset name: ${name}`)
    }
    byName.set(name, path)
  }
  for (const [label, pattern] of REQUIRED_ASSETS) {
    const matches = [...byName.keys()].filter((name) => pattern.test(name))
    if (matches.length !== 1) {
      throw new Error(`${label} asset count must be 1, got ${matches.length}`)
    }
  }

  const assets = [...byName.entries()]
    .map(([name, path]) => ({
      name,
      path: relative(root, path),
      bytes: statSync(path).size,
      sha256: sha256(path)
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return {
    schemaVersion: 1,
    releaseTag: releaseTag(upstreamTag, candidateSha),
    candidateSha,
    upstream: { tag: upstreamTag, sha: upstreamSha },
    versions: { desktopVersion, mobileVersion, androidVersionCode, iosBuildNumber },
    androidSigning: { certificateSha256: androidCertificateSha256 },
    assets
  }
}

export function writeReleaseManifests(directory, metadata) {
  const root = resolve(directory)
  writeFileSync(join(root, 'build-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  const checksums = metadata.assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')
  writeFileSync(join(root, 'checksums.txt'), `${checksums}\n`)
}

export function verifyReleaseManifests(
  directory,
  { candidateSha, upstreamTag, upstreamSha, androidCertificateSha256 }
) {
  const root = resolve(directory)
  const metadata = JSON.parse(readFileSync(join(root, 'build-metadata.json'), 'utf8'))
  if (metadata.candidateSha !== candidateSha) {
    throw new Error('release candidate SHA mismatch')
  }
  if (metadata.upstream?.tag !== upstreamTag) {
    throw new Error('release upstream tag mismatch')
  }
  if (metadata.upstream?.sha !== upstreamSha) {
    throw new Error('release upstream SHA mismatch')
  }
  if (metadata.androidSigning?.certificateSha256 !== androidCertificateSha256) {
    throw new Error('release Android certificate SHA-256 mismatch')
  }
  const described = verifyAndDescribeAssets({
    directory: root,
    candidateSha: metadata.candidateSha,
    upstreamTag: metadata.upstream.tag,
    upstreamSha: metadata.upstream.sha,
    desktopVersion: metadata.versions.desktopVersion,
    mobileVersion: metadata.versions.mobileVersion,
    androidVersionCode: metadata.versions.androidVersionCode,
    androidCertificateSha256: metadata.androidSigning.certificateSha256,
    iosBuildNumber: metadata.versions.iosBuildNumber
  })
  if (JSON.stringify(described) !== JSON.stringify(metadata)) {
    throw new Error('release asset metadata does not match downloaded assets')
  }
  const checksums = metadata.assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')
  if (readFileSync(join(root, 'checksums.txt'), 'utf8') !== `${checksums}\n`) {
    throw new Error('release checksums do not match build metadata')
  }
  return metadata
}

function requiredEnvironment(name) {
  const value = (process.env[name] || '').trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function main() {
  const verifyExisting = process.argv[2] === 'verify-existing'
  const directory = resolve(process.argv[verifyExisting ? 3 : 2] || '')
  if (verifyExisting) {
    const metadata = verifyReleaseManifests(directory, {
      candidateSha: requiredEnvironment('CANDIDATE_SHA'),
      upstreamTag: requiredEnvironment('UPSTREAM_TAG'),
      upstreamSha: requiredEnvironment('UPSTREAM_SHA'),
      androidCertificateSha256: requiredEnvironment('ANDROID_RELEASE_CERTIFICATE_SHA256')
    })
    console.log(JSON.stringify(metadata, null, 2))
    return
  }
  const metadata = verifyAndDescribeAssets({
    directory,
    candidateSha: requiredEnvironment('CANDIDATE_SHA'),
    upstreamTag: requiredEnvironment('UPSTREAM_TAG'),
    upstreamSha: requiredEnvironment('UPSTREAM_SHA'),
    desktopVersion: requiredEnvironment('DESKTOP_VERSION'),
    mobileVersion: requiredEnvironment('MOBILE_VERSION'),
    androidVersionCode: requiredEnvironment('ANDROID_VERSION_CODE'),
    androidCertificateSha256: requiredEnvironment('ANDROID_RELEASE_CERTIFICATE_SHA256'),
    iosBuildNumber: requiredEnvironment('IOS_BUILD_NUMBER')
  })
  writeReleaseManifests(directory, metadata)
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `release_tag=${metadata.releaseTag}\n`, { flag: 'a' })
  }
  console.log(JSON.stringify(metadata, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
