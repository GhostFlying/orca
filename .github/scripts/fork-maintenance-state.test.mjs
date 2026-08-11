import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectForkPatchStack } from './fork-maintenance-state.mjs'

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
        cwd: root
      })
    ).toThrow('target is not a fast-forward of the anchored upstream commit')
  })
})
