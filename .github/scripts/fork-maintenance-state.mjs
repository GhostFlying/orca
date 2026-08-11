import { execFileSync, spawnSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const GIT_BINARY = process.env.ORCA_FORK_MAINTENANCE_GIT_BINARY || 'git'
const GENERATED_ANCHOR_TRAILER = 'Fork-Maintenance-Generated: upstream-anchor-v1'
const GENERATED_SNAPSHOT_TRAILER = 'Fork-Maintenance-Generated: maintenance-snapshot-v1'
const MAINTENANCE_PATHS = [
  '.github/fork-maintenance-plan.md',
  '.github/scripts/fork-maintenance-state.mjs',
  '.github/scripts/fork-maintenance-state.test.mjs',
  '.github/scripts/fork-maintenance-workflow.test.mjs',
  '.github/workflows/',
  'config/vitest.config.ts'
]

function git(args, cwd = process.cwd()) {
  return execFileSync(GIT_BINARY, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function isAncestor(ancestor, descendant, cwd = process.cwd()) {
  const result = spawnSync(GIT_BINARY, ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status === 0) {
    return true
  }
  if (result.status === 1) {
    return false
  }
  throw new Error(result.stderr.trim() || `git merge-base exited ${result.status}`)
}

function lines(value) {
  return value ? value.split('\n').filter(Boolean) : []
}

function commitHasTrailer(commitSha, trailer, cwd) {
  return lines(git(['log', '-1', '--format=%B', commitSha], cwd)).includes(trailer)
}

function isMaintenancePath(path) {
  return MAINTENANCE_PATHS.some((allowedPath) =>
    allowedPath.endsWith('/') ? path.startsWith(allowedPath) : path === allowedPath
  )
}

function assertGeneratedMaintenanceCommit(commitSha, cwd) {
  const changedPaths = lines(
    git(['diff-tree', '--no-commit-id', '--name-only', '-r', `${commitSha}^`, commitSha], cwd)
  )
  if (changedPaths.some((path) => !isMaintenancePath(path))) {
    throw new Error(`generated maintenance commit ${commitSha} changes a non-maintenance path`)
  }
}

function requireGeneratedAnchor(anchorSha, cwd) {
  if (!commitHasTrailer(anchorSha, GENERATED_ANCHOR_TRAILER, cwd)) {
    throw new Error('upstream anchor is not a generated maintenance anchor')
  }
  const [commitSha, ...parents] = git(['rev-list', '--parents', '-n', '1', anchorSha], cwd).split(
    ' '
  )
  if (commitSha !== anchorSha || parents.length !== 1) {
    throw new Error('generated upstream anchor must have exactly one upstream parent')
  }
  assertGeneratedMaintenanceCommit(anchorSha, cwd)
  return requireCommitSha(parents[0], 'upstreamSha')
}

function requireCommitSha(value, field) {
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase 40-character commit SHA`)
  }
  return value
}

export function inspectForkPatchStack({ anchorRef, forkRef, targetRef, cwd = process.cwd() }) {
  const anchorSha = requireCommitSha(git(['rev-parse', `${anchorRef}^{commit}`], cwd), 'anchorSha')
  const forkSha = requireCommitSha(git(['rev-parse', `${forkRef}^{commit}`], cwd), 'forkSha')
  const targetSha = requireCommitSha(git(['rev-parse', `${targetRef}^{commit}`], cwd), 'targetSha')
  const upstreamSha = requireGeneratedAnchor(anchorSha, cwd)

  if (!isAncestor(anchorSha, forkSha, cwd)) {
    throw new Error(`${anchorRef} is not an ancestor of ${forkRef}`)
  }
  if (!isAncestor(upstreamSha, targetSha, cwd)) {
    throw new Error(`${targetRef} is not a fast-forward of the anchored upstream commit`)
  }

  const mergeCommits = lines(git(['rev-list', '--merges', `${anchorSha}..${forkSha}`], cwd))
  if (mergeCommits.length > 0) {
    throw new Error(`fork patch stack contains merge commits: ${mergeCommits.join(', ')}`)
  }

  const rangeCommits = lines(git(['rev-list', '--reverse', `${anchorSha}..${forkSha}`], cwd))
  const generatedWorkflowSnapshots = rangeCommits.filter((commitSha) =>
    commitHasTrailer(commitSha, GENERATED_SNAPSHOT_TRAILER, cwd)
  )
  if (generatedWorkflowSnapshots.length > 1) {
    throw new Error('fork patch stack contains multiple generated maintenance snapshots')
  }
  if (
    generatedWorkflowSnapshots.length === 1 &&
    generatedWorkflowSnapshots[0] !== rangeCommits.at(-1)
  ) {
    throw new Error('generated maintenance snapshot must be the final fork commit')
  }
  for (const commitSha of generatedWorkflowSnapshots) {
    assertGeneratedMaintenanceCommit(commitSha, cwd)
  }

  const patchCommits = rangeCommits.filter(
    (commitSha) => !generatedWorkflowSnapshots.includes(commitSha)
  )
  return {
    version: 1,
    anchorSha,
    upstreamSha,
    forkSha,
    targetSha,
    patchCommits,
    patchCount: patchCommits.length,
    generatedMaintenanceSnapshotSha: generatedWorkflowSnapshots[0] ?? null
  }
}

function parseArguments(argv) {
  const [command, ...rawOptions] = argv
  const options = {}
  for (const rawOption of rawOptions) {
    const separator = rawOption.indexOf('=')
    if (!rawOption.startsWith('--') || separator === -1) {
      throw new Error(`invalid option: ${rawOption}`)
    }
    options[rawOption.slice(2, separator)] = rawOption.slice(separator + 1)
  }
  return { command, options }
}

function requiredOption(options, name) {
  const value = options[name]
  if (!value) {
    throw new Error(`missing --${name}`)
  }
  return value
}

function runCli(argv) {
  const { command, options } = parseArguments(argv)
  if (command === 'inspect') {
    const result = inspectForkPatchStack({
      anchorRef: requiredOption(options, 'anchor'),
      forkRef: requiredOption(options, 'fork'),
      targetRef: requiredOption(options, 'target')
    })
    console.log(JSON.stringify(result))
    return
  }
  throw new Error('usage: fork-maintenance-state.mjs inspect [options]')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
