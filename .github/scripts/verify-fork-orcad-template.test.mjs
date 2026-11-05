import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeOrcadTemplateTestFixture } from '../../config/scripts/orcad-template-test-fixture.mjs'
import { packagedResourcesDir, verifyForkOrcadTemplate } from './verify-fork-orcad-template.mjs'

const roots = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fork-orcad-template-'))
  roots.push(root)
  await writeOrcadTemplateTestFixture(root, { compat: true })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return root
}

describe('fork packaged server template verification', () => {
  it('accepts every platform and the compatibility slot in the shipped template', async () => {
    const root = await fixture()
    expect(() => verifyForkOrcadTemplate(root)).not.toThrow()
  })

  it.each([
    'orcad-template',
    'orcad-template/targets/linux-x64-glibc',
    'orcad-template/targets/linux-x64-glibc/.server-target',
    'orcad-template/targets/darwin-arm64/.runtime-node'
  ])('rejects a package missing %s', async (path) => {
    const root = await fixture()
    await rm(join(root, ...path.split('/')), { recursive: true, force: true })
    expect(() => verifyForkOrcadTemplate(root)).toThrow()
  })

  it('rejects changed bytes after packaging', async () => {
    const root = await fixture()
    await writeFile(join(root, 'orcad-template', 'orcad.js'), 'changed')
    expect(() => verifyForkOrcadTemplate(root)).toThrow('checksum mismatch')
  })

  it('locates the actual resources directory for each desktop package', () => {
    const expected = {
      'windows-x64': ['win-unpacked', 'resources'],
      'linux-x64': ['linux-unpacked', 'resources'],
      'linux-arm64': ['linux-arm64-unpacked', 'resources'],
      'macos-x64': ['mac', 'Orca.app', 'Contents', 'Resources'],
      'macos-arm64': ['mac-arm64', 'Orca.app', 'Contents', 'Resources']
    }
    for (const [platform, segments] of Object.entries(expected)) {
      expect(packagedResourcesDir('dist', platform)).toBe(join('dist', ...segments))
    }
    expect(() => packagedResourcesDir('dist', 'other')).toThrow('Unsupported')
  })
})
