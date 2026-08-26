import { describe, expect, it, vi } from 'vitest'
import {
  fetchReleases,
  parseStableTag,
  resolveStableRelease,
  validateReleaseCommit
} from './upstream-release.mjs'

function response(body) {
  return { ok: true, status: 200, json: vi.fn(async () => body), text: vi.fn(async () => '') }
}

describe('upstream stable release selection', () => {
  it('accepts only stable desktop tags', () => {
    expect(parseStableTag('v1.4.188')).toMatchObject({ version: '1.4.188' })
    expect(parseStableTag('v1.4.188-rc.0')).toBeNull()
    expect(parseStableTag('mobile-android-v0.0.44')).toBeNull()
  })

  it('selects the highest published stable semver', () => {
    expect(
      resolveStableRelease([
        { tag_name: 'v1.4.99', draft: false, prerelease: false },
        { tag_name: 'v1.4.100', draft: false, prerelease: false },
        { tag_name: 'v1.5.0-rc.0', draft: false, prerelease: true },
        { tag_name: 'mobile-android-v0.0.44', draft: false, prerelease: false },
        { tag_name: 'v2.0.0', draft: true, prerelease: false }
      ])
    ).toMatchObject({ tag: 'v1.4.100', version: '1.4.100' })
  })

  it('requires a requested tag to be a published stable Release', () => {
    const releases = [{ tag_name: 'v1.4.188', draft: false, prerelease: false }]
    expect(resolveStableRelease(releases, 'v1.4.188')).toMatchObject({ tag: 'v1.4.188' })
    expect(() => resolveStableRelease(releases, 'v1.4.189')).toThrow('not a published stable')
    expect(() => resolveStableRelease(releases, 'v1.4.189-rc.0')).toThrow('must match vX.Y.Z')
  })

  it('validates the version-bump release commit', () => {
    expect(
      validateReleaseCommit({
        tag: 'v1.4.188',
        sha: 'a'.repeat(40),
        subject: 'release: v1.4.188',
        packageVersion: '1.4.188'
      })
    ).toMatchObject({ version: '1.4.188' })
    expect(() =>
      validateReleaseCommit({
        tag: 'v1.4.188',
        sha: 'a'.repeat(40),
        subject: 'some main commit',
        packageVersion: '1.4.188'
      })
    ).toThrow('release commit subject')
  })

  it('fetches every Releases API page', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v1.0.${index}` }))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response([{ tag_name: 'v1.4.188' }]))
    await expect(fetchReleases('stablyai/orca', 'token', fetchImpl)).resolves.toHaveLength(101)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
