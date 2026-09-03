#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const STABLE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

export function parseStableTag(tag) {
  const match = STABLE_TAG_PATTERN.exec(tag)
  if (!match) {
    return null
  }
  return { tag, version: tag.slice(1), parts: match.slice(1).map(Number) }
}

function compareTags(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.parts[index] - right.parts[index]
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

export function eligibleStableReleases(releases) {
  return releases
    .filter((release) => release && release.draft !== true && release.prerelease !== true)
    .map((release) => ({ release, parsed: parseStableTag(release.tag_name ?? '') }))
    .filter(({ parsed }) => parsed)
}

export function resolveStableRelease(releases, requestedTag = '') {
  const eligible = eligibleStableReleases(releases)
  if (requestedTag) {
    if (!parseStableTag(requestedTag)) {
      throw new Error('requested upstream tag must match vX.Y.Z')
    }
    const match = eligible.find(({ parsed }) => parsed.tag === requestedTag)
    if (!match) {
      throw new Error(`${requestedTag} is not a published stable upstream Release`)
    }
    return releaseIdentity(match)
  }
  const latest = eligible.sort((a, b) => compareTags(a.parsed, b.parsed)).at(-1)
  if (!latest) {
    throw new Error('upstream has no published stable desktop Release')
  }
  return releaseIdentity(latest)
}

function releaseIdentity({ release, parsed }) {
  return {
    tag: parsed.tag,
    version: parsed.version,
    releaseUrl: String(release.html_url ?? ''),
    publishedAt: String(release.published_at ?? '')
  }
}

export function validateReleaseCommit({ tag, sha, subject, packageVersion }) {
  const parsed = parseStableTag(tag)
  if (!parsed) {
    throw new Error('upstream release tag must match vX.Y.Z')
  }
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error('release SHA must be a lowercase commit SHA')
  }
  if (subject !== `release: ${tag}`) {
    throw new Error(`release commit subject must be release: ${tag}`)
  }
  if (packageVersion !== parsed.version) {
    throw new Error(`package.json version ${packageVersion} does not match ${tag}`)
  }
  return { ...parsed, sha }
}

async function githubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub request failed ${response.status}: ${body.slice(0, 300)}`)
  }
  return response.json()
}

export async function fetchReleases(repository, token, fetchImpl = fetch) {
  if (!repository) {
    throw new Error('repository is required')
  }
  if (!token) {
    throw new Error('GitHub token is required')
  }
  const releases = []
  for (let page = 1; ; page += 1) {
    const values = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      token
    )
    if (!Array.isArray(values)) {
      throw new Error(`GitHub Releases page ${page} is not an array`)
    }
    releases.push(...values)
    if (values.length < 100) {
      return releases
    }
  }
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repository = process.env.UPSTREAM_REPOSITORY || 'stablyai/orca'
  const requestedTag = (process.env.REQUESTED_UPSTREAM_TAG || '').trim()
  const release = resolveStableRelease(await fetchReleases(repository, token), requestedTag)
  if (process.env.GITHUB_OUTPUT) {
    const outputText = Object.entries(release)
      .map(
        ([name, value]) =>
          `${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}=${value}`
      )
      .join('\n')
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputText}\n`)
  }
  process.stdout.write(`${JSON.stringify(release)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
