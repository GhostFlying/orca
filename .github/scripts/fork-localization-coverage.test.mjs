import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectLocalizationCandidates,
  main as auditLocalizationCoverage
} from '../../config/scripts/audit-localization-coverage.mjs'
import { releaseLocalizationAllowlist } from './fork-localization-coverage.mjs'

const roots = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function check(source, { filename = 'view.tsx', allowlist = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-localization-test-'))
  roots.push(root)
  const directory = join(root, 'src/renderer/src')
  await mkdir(directory, { recursive: true })
  const upstreamPath = join(directory, 'view.tsx')
  const reports = collectLocalizationCandidates(upstreamPath, '<span>Upstream debt</span>', root)
  const baseline = join(root, 'allowlist.json')
  await writeFile(baseline, JSON.stringify(releaseLocalizationAllowlist(reports, allowlist)))
  await writeFile(join(directory, filename), source)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return auditLocalizationCoverage(root, ['--check', '--allowlist', baseline])
}

describe('fork localization coverage', () => {
  it('accepts unchanged Release debt and localized fork copy', async () => {
    expect(await check('<><span>Upstream debt</span><span>{t("fork.key")}</span></>')).toBe(0)
  })

  it.each([
    '<span>New fork copy</span>',
    '<><span>Upstream debt</span><span>Upstream debt</span></>'
  ])('rejects new text or another instance of Release debt', async (source) => {
    expect(await check(source)).toBe(1)
  })

  it('does not let another file borrow an upstream exclusion', async () => {
    expect(await check('<span>Upstream debt</span>', { filename: 'new.tsx' })).toBe(1)
  })

  it('retains the exact Release allowlist floor for temporarily absent text', async () => {
    const allowlist = [{
      filePath: 'src/renderer/src/view.tsx',
      kind: 'jsx-text',
      text: 'Reviewed exclusion',
      dynamic: false,
      count: 1
    }]
    expect(await check('<span>Reviewed exclusion</span>', { allowlist })).toBe(0)
  })
})
