import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertForkPatchPaths,
  inspectForkCandidate,
  inspectForkHotfixSource,
  inspectForkPatchStack,
  isDirectExecution,
  verifyForkHotfixCandidate
} from './fork-maintenance-state.mjs'

function git(root, ...args) {
  const gitBinary = process.env.ORCA_FORK_MAINTENANCE_GIT_BINARY || 'git'
  return execFileSync(gitBinary, ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fork Maintainer',
      GIT_AUTHOR_EMAIL: 'fork@example.test',
      GIT_COMMITTER_NAME: 'Fork Maintainer',
      GIT_COMMITTER_EMAIL: 'fork@example.test'
    }
  }).trim()
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'orca-fork-maintenance-'))
  git(root, 'init')
  git(root, 'checkout', '-b', 'main')
  git(root, 'config', 'core.hooksPath', join(root, 'disabled-hooks'))
  writeFileSync(join(root, 'base.txt'), 'base\n')
  git(root, 'add', 'base.txt')
  git(root, 'commit', '-m', 'base')
  git(
    root,
    'commit',
    '--allow-empty',
    '-m',
    'generated anchor',
    '-m',
    'Fork-Maintenance-Generated: upstream-anchor-v1'
  )
  git(root, 'branch', 'anchor')
  return root
}

function appendCommit(root, file, value, subject) {
  mkdirSync(join(root, file, '..'), { recursive: true })
  writeFileSync(join(root, file), value)
  git(root, 'add', file)
  git(root, 'commit', '-m', subject)
  return git(root, 'rev-parse', 'HEAD')
}

describe('inspectForkPatchStack', () => {
  it('returns an ordered linear patch stack and accepts a fast-forward target', () => {
    const root = createRepository()
    git(root, 'switch', '-c', 'fork')
    const first = appendCommit(root, 'one.txt', 'one\n', 'one')
    const second = appendCommit(root, 'two.txt', 'two\n', 'two')
    git(root, 'switch', 'main')
    appendCommit(root, 'upstream.txt', 'upstream\n', 'upstream')

    expect(
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: root
      })
    ).toMatchObject({
      version: 1,
      patchCommits: [first, second],
      patchCount: 2
    })
  })

  it('excludes one generated maintenance snapshot from the replay stack', () => {
    const root = createRepository()
    git(root, 'switch', '-c', 'fork')
    const patch = appendCommit(root, 'fork.txt', 'fork\n', 'fork')
    appendCommit(
      root,
      '.github/workflows/fork-sync.yml',
      'name: Fork Sync\n',
      'chore(fork): restore maintenance snapshot\n\nFork-Maintenance-Generated: maintenance-snapshot-v1'
    )

    expect(
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: root
      })
    ).toMatchObject({
      patchCommits: [patch],
      patchCount: 1,
      generatedMaintenanceSnapshotSha: expect.stringMatching(/^[0-9a-f]{40}$/)
    })
  })

  it('rejects malformed or duplicate generated maintenance snapshots', () => {
    const malformedRoot = createRepository()
    git(malformedRoot, 'switch', '-c', 'fork')
    writeFileSync(join(malformedRoot, 'fork.txt'), 'fork\n')
    mkdirSync(join(malformedRoot, '.github/workflows'), { recursive: true })
    writeFileSync(join(malformedRoot, '.github/workflows/fork-sync.yml'), 'name: Fork Sync\n')
    git(malformedRoot, 'add', '.')
    git(
      malformedRoot,
      'commit',
      '-m',
      'malformed snapshot',
      '-m',
      'Fork-Maintenance-Generated: maintenance-snapshot-v1'
    )

    expect(() =>
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: malformedRoot
      })
    ).toThrow('changes a non-maintenance path')

    const duplicateRoot = createRepository()
    git(duplicateRoot, 'switch', '-c', 'fork')
    appendCommit(
      duplicateRoot,
      '.github/workflows/fork-sync.yml',
      'name: Fork Sync\n',
      'first snapshot\n\nFork-Maintenance-Generated: maintenance-snapshot-v1'
    )
    appendCommit(
      duplicateRoot,
      '.github/workflows/pr.yml',
      'name: PR Checks\n',
      'second snapshot\n\nFork-Maintenance-Generated: maintenance-snapshot-v1'
    )

    expect(() =>
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: duplicateRoot
      })
    ).toThrow('multiple generated maintenance snapshots')

    const nonFinalRoot = createRepository()
    git(nonFinalRoot, 'switch', '-c', 'fork')
    appendCommit(
      nonFinalRoot,
      '.github/workflows/fork-sync.yml',
      'name: Fork Sync\n',
      'snapshot\n\nFork-Maintenance-Generated: maintenance-snapshot-v1'
    )
    appendCommit(nonFinalRoot, 'fork.txt', 'fork\n', 'later patch')

    expect(() =>
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: nonFinalRoot
      })
    ).toThrow('must be the final fork commit')
  })

  it('rejects a raw upstream commit as the anchor', () => {
    const root = createRepository()
    git(root, 'branch', '-f', 'anchor', 'anchor^')
    git(root, 'switch', '-c', 'fork', 'anchor')
    appendCommit(root, 'fork.txt', 'fork\n', 'fork')

    expect(() =>
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: root
      })
    ).toThrow('upstream anchor is not a generated maintenance anchor')
  })

  it('rejects an anchor that is not an ancestor of the fork', () => {
    const root = createRepository()
    git(root, 'switch', '--orphan', 'fork')
    appendCommit(root, 'fork.txt', 'fork\n', 'fork')

    expect(() =>
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: root
      })
    ).toThrow('anchor is not an ancestor of fork')
  })

  it('rejects merge commits in the fork-only range', () => {
    const root = createRepository()
    git(root, 'switch', '-c', 'side', 'anchor')
    appendCommit(root, 'side.txt', 'side\n', 'side')
    git(root, 'switch', '-c', 'fork', 'anchor')
    appendCommit(root, 'fork.txt', 'fork\n', 'fork')
    git(root, 'merge', '--no-ff', 'side', '-m', 'merge side')

    expect(() =>
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'main',
        cwd: root
      })
    ).toThrow('fork patch stack contains merge commits')
  })

  it('rejects a target that is not a fast-forward of the anchor', () => {
    const root = createRepository()
    git(root, 'switch', '-c', 'fork')
    appendCommit(root, 'fork.txt', 'fork\n', 'fork')
    git(root, 'switch', '--orphan', 'target')
    appendCommit(root, 'target.txt', 'target\n', 'target')

    expect(() =>
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'target',
        requireTargetDescendant: true,
        cwd: root
      })
    ).toThrow('target is not a fast-forward of the anchored upstream commit')
  })

  it('accepts detached release commits when ancestry is not required', () => {
    const root = createRepository()
    git(root, 'switch', '-c', 'fork')
    appendCommit(root, 'fork.txt', 'fork\n', 'fork')
    git(root, 'switch', '--orphan', 'release')
    appendCommit(root, 'release.txt', 'release\n', 'release')

    expect(
      inspectForkPatchStack({
        anchorRef: 'anchor',
        forkRef: 'fork',
        targetRef: 'release',
        cwd: root
      })
    ).toMatchObject({ patchCount: 1 })
  })
})

describe('CLI entrypoint', () => {
  it('recognizes executable paths reached through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-fork-maintenance-entrypoint-'))
    const script = join(root, 'script.mjs')
    const alias = join(root, 'script-alias.mjs')
    writeFileSync(script, 'export {}\n')
    symlinkSync(script, alias)

    expect(isDirectExecution(pathToFileURL(script).href, alias)).toBe(true)
  })
})

describe('fork patch path boundary', () => {
  it('accepts every business commit in source range without pinning identity or subject', () => {
    const root = createRepository()
    git(root, 'switch', '-c', 'fork')
    const first = appendCommit(root, 'mobile/first.ts', 'first\n', 'arbitrary first patch')
    const second = appendCommit(root, 'mobile/second.ts', 'second\n', 'renamed replayed patch')

    expect(() => assertForkPatchPaths([first, second], root)).not.toThrow()
  })

  it('rejects business patches that change maintenance paths', () => {
    const maintenanceRoot = createRepository()
    git(maintenanceRoot, 'switch', '-c', 'fork')
    const maintenance = appendCommit(
      maintenanceRoot,
      '.github/workflows/fork-release-build.yml',
      'name: changed\n',
      'fix(mobile): honor pinned workspace display preference'
    )
    expect(() => assertForkPatchPaths([maintenance], maintenanceRoot)).toThrow(
      'changes a maintenance path'
    )
  })
})

describe('fork hotfix source', () => {
  it('accepts a linear product-only range based on the production fork', () => {
    const root = createRepository()
    git(root, 'switch', '-c', 'fork')
    appendCommit(root, 'product.ts', 'production\n', 'production patch')
    git(root, 'switch', '-c', 'fix/hotfix')
    const first = appendCommit(root, 'product.ts', 'hotfix one\n', 'hotfix one')
    const second = appendCommit(root, 'product.test.ts', 'test\n', 'hotfix test')

    expect(
      inspectForkHotfixSource({ forkRef: 'fork', sourceRef: 'fix/hotfix', cwd: root })
    ).toMatchObject({
      hotfixCommits: [first, second],
      hotfixCommitCount: 2
    })
  })

  it('rejects a source that is unrelated, merged, empty, or changes maintenance paths', () => {
    const empty = createRepository()
    git(empty, 'branch', 'fork')
    expect(() =>
      inspectForkHotfixSource({ forkRef: 'fork', sourceRef: 'HEAD', cwd: empty })
    ).toThrow('contains no commits')

    const unrelated = createRepository()
    git(unrelated, 'branch', 'fork')
    git(unrelated, 'switch', '--orphan', 'fix/unrelated')
    appendCommit(unrelated, 'other.ts', 'other\n', 'unrelated')
    expect(() =>
      inspectForkHotfixSource({
        forkRef: 'fork',
        sourceRef: 'fix/unrelated',
        cwd: unrelated
      })
    ).toThrow('not an ancestor')

    const maintenance = createRepository()
    git(maintenance, 'branch', 'fork')
    git(maintenance, 'switch', '-c', 'fix/maintenance')
    appendCommit(
      maintenance,
      '.github/workflows/fork-release-build.yml',
      'name: changed\n',
      'unsafe maintenance change'
    )
    expect(() =>
      inspectForkHotfixSource({
        forkRef: 'fork',
        sourceRef: 'fix/maintenance',
        cwd: maintenance
      })
    ).toThrow('changes a maintenance path')
  })
})

describe('candidate transaction metadata', () => {
  it('reads the release and exact source leases from the generated anchor', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-fork-candidate-'))
    git(root, 'init')
    git(root, 'checkout', '-b', 'main')
    writeFileSync(join(root, 'base.txt'), 'base\n')
    git(root, 'add', 'base.txt')
    git(root, 'commit', '-m', 'release: v1.4.188')
    const upstream = git(root, 'rev-parse', 'HEAD')
    const sourceFork = 'a'.repeat(40)
    const sourceAnchor = 'b'.repeat(40)
    const sourcePreview = 'c'.repeat(40)
    git(
      root,
      'commit',
      '--allow-empty',
      '-m',
      'generated anchor',
      '-m',
      `Upstream-Release: v1.4.188\nUpstream-Commit: ${upstream}\nFork-Maintenance-Source-Fork: ${sourceFork}\nFork-Maintenance-Source-Anchor: ${sourceAnchor}\nFork-Maintenance-Source-Preview: ${sourcePreview}\nFork-Maintenance-Generated: upstream-anchor-v1`
    )
    const anchor = git(root, 'rev-parse', 'HEAD')
    const patch = appendCommit(
      root,
      'mobile/change.ts',
      'change\n',
      'fix(mobile): show SSH labels in Run on picker'
    )

    expect(inspectForkCandidate({ candidateRef: 'HEAD', cwd: root })).toMatchObject({
      anchorSha: anchor,
      upstreamSha: upstream,
      upstreamTag: 'v1.4.188',
      sourceForkSha: sourceFork,
      sourceAnchorSha: sourceAnchor,
      sourcePreviewSha: sourcePreview,
      patchCommits: [patch]
    })
  })

  it('validates a hotfix candidate against its exact reviewed source', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-fork-hotfix-candidate-'))
    git(root, 'init')
    git(root, 'checkout', '-b', 'release')
    writeFileSync(join(root, 'base.txt'), 'release\n')
    git(root, 'add', 'base.txt')
    git(root, 'commit', '-m', 'release: v1.4.197')
    const upstream = git(root, 'rev-parse', 'HEAD')
    git(
      root,
      'commit',
      '--allow-empty',
      '-m',
      'generated anchor',
      '-m',
      `Upstream-Release: v1.4.197\nUpstream-Commit: ${upstream}\nFork-Maintenance-Source-Fork: ${'1'.repeat(40)}\nFork-Maintenance-Source-Anchor: ${'2'.repeat(40)}\nFork-Maintenance-Source-Preview: ${'3'.repeat(40)}\nFork-Maintenance-Generated: upstream-anchor-v1`
    )
    const anchor = git(root, 'rev-parse', 'HEAD')
    const productionPatch = appendCommit(root, 'product.ts', 'production\n', 'production patch')
    appendCommit(
      root,
      '.github/fork-maintenance-plan.md',
      'old maintenance\n',
      'old snapshot\n\nFork-Maintenance-Generated: maintenance-snapshot-v1'
    )
    git(root, 'branch', 'fork')
    git(root, 'switch', '-c', 'fix/hotfix')
    const sourceHotfix = appendCommit(root, 'product.ts', 'hotfix\n', 'hotfix product')
    const sourceFork = git(root, 'rev-parse', 'fork')

    git(root, 'switch', '-c', 'candidate', productionPatch)
    git(root, 'cherry-pick', sourceHotfix)
    const candidateHotfix = git(root, 'rev-parse', 'HEAD')
    appendCommit(
      root,
      '.github/fork-maintenance-plan.md',
      'new maintenance\n',
      `hotfix snapshot\n\nFork-Maintenance-Transaction: fork-hotfix-v1\nFork-Maintenance-Source-Fork: ${sourceFork}\nFork-Maintenance-Source-Anchor: ${anchor}\nFork-Maintenance-Source-Preview: ${sourceFork}\nFork-Hotfix-Source-Ref: fix/hotfix\nFork-Hotfix-Source-Commit: ${sourceHotfix}\nFork-Maintenance-Generated: maintenance-snapshot-v1`
    )

    expect(
      verifyForkHotfixCandidate({
        candidateRef: 'candidate',
        sourceRef: 'fix/hotfix',
        cwd: root
      })
    ).toMatchObject({
      transactionKind: 'fork-hotfix',
      sourceForkSha: sourceFork,
      sourceAnchorSha: anchor,
      sourcePreviewSha: sourceFork,
      hotfixSourceRef: 'fix/hotfix',
      hotfixSourceSha: sourceHotfix,
      patchCommits: [productionPatch, candidateHotfix],
      hotfixCommits: [sourceHotfix]
    })

    git(
      root,
      'commit',
      '--amend',
      '-m',
      'hotfix snapshot',
      '-m',
      `Fork-Maintenance-Transaction: fork-hotfix-v1\nFork-Maintenance-Source-Fork: ${sourceFork}\nFork-Maintenance-Source-Anchor: ${anchor}\nFork-Maintenance-Source-Preview: ${'4'.repeat(40)}\nFork-Hotfix-Source-Ref: fix/hotfix\nFork-Hotfix-Source-Commit: ${sourceHotfix}\nFork-Maintenance-Generated: maintenance-snapshot-v1`
    )
    expect(() =>
      verifyForkHotfixCandidate({ candidateRef: 'candidate', sourceRef: 'fix/hotfix', cwd: root })
    ).toThrow('source preview is not the captured production fork mirror')

    git(root, 'switch', '-c', 'candidate-tampered', candidateHotfix)
    writeFileSync(join(root, 'product.ts'), 'tampered\n')
    git(root, 'add', 'product.ts')
    git(root, 'commit', '--amend', '--no-edit')
    appendCommit(
      root,
      '.github/fork-maintenance-plan.md',
      'new maintenance\n',
      `hotfix snapshot\n\nFork-Maintenance-Transaction: fork-hotfix-v1\nFork-Maintenance-Source-Fork: ${sourceFork}\nFork-Maintenance-Source-Anchor: ${anchor}\nFork-Maintenance-Source-Preview: ${sourceFork}\nFork-Hotfix-Source-Ref: fix/hotfix\nFork-Hotfix-Source-Commit: ${sourceHotfix}\nFork-Maintenance-Generated: maintenance-snapshot-v1`
    )
    expect(() =>
      verifyForkHotfixCandidate({
        candidateRef: 'candidate-tampered',
        sourceRef: 'fix/hotfix',
        cwd: root
      })
    ).toThrow('differs from its source outside maintenance paths')
  })
})
