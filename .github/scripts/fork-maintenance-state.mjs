import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const GIT_BINARY = process.env.ORCA_FORK_MAINTENANCE_GIT_BINARY || 'git'
const GENERATED_ANCHOR_TRAILER = 'Fork-Maintenance-Generated: upstream-anchor-v1'
const GENERATED_SNAPSHOT_TRAILER = 'Fork-Maintenance-Generated: maintenance-snapshot-v1'
export const EXPECTED_FORK_PATCH_SUBJECTS = [
  'fix(mobile): honor pinned workspace display preference',
  'docs(mobile): document workspace settings loaders',
  'fix(mobile): show SSH labels in Run on picker',
  'fix(runtime): preserve worktree names across scan stalls'
]
export const EXPECTED_FORK_PATCH_IDS = [
  '7b329e48d727f84f48edaf32ca55e909671d8c93',
  '3ee38c9ce1f44247484a9ab150b7ef6e55eb4ddd',
  '673b450c91309c0cb6c2c857e36ebb62e3c104ac',
  'a8e3378513e7788a7d0744d998517ecbe4e37078'
]
const MAINTENANCE_PATHS = [
  'AGENTS.md',
  '.github/fork-maintenance-plan.md',
  '.github/scripts/fork-maintenance-state.mjs',
  '.github/scripts/fork-maintenance-state.test.mjs',
  '.github/scripts/fork-release-assets.mjs',
  '.github/scripts/fork-release-assets.test.mjs',
  '.github/scripts/fork-maintenance-workflow.test.mjs',
  '.github/scripts/upstream-release.mjs',
  '.github/scripts/upstream-release.test.mjs',
  '.github/scripts/vitest.config.mjs',
  '.github/workflows/',
  'config/scripts/fork-electron-builder-config.cjs',
  'config/scripts/fork-electron-builder-config.test.mjs',
  'mobile/scripts/build-unsigned-ios.sh'
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

function patchId(commitSha, cwd) {
  const patch = execFileSync(GIT_BINARY, ['show', '--pretty=format:', commitSha], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const result = execFileSync(GIT_BINARY, ['patch-id', '--stable'], {
    cwd,
    encoding: 'utf8',
    input: patch,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
  const [value] = result.split(' ')
  return requireCommitSha(value, 'patchId')
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

export function assertForkPatchContract(
  patchCommits,
  cwd = process.cwd(),
  expectedSubjects = EXPECTED_FORK_PATCH_SUBJECTS,
  expectedPatchIds = EXPECTED_FORK_PATCH_IDS
) {
  let expectedIndex = 0
  const subjects = []
  for (const commitSha of patchCommits) {
    const subject = git(['show', '-s', '--format=%s', commitSha], cwd)
    const currentPatchId = patchId(commitSha, cwd)
    while (
      (expectedSubjects[expectedIndex] !== subject ||
        (expectedPatchIds && expectedPatchIds[expectedIndex] !== currentPatchId)) &&
      expectedIndex < expectedSubjects.length
    ) {
      expectedIndex += 1
    }
    if (expectedIndex >= expectedSubjects.length) {
      throw new Error(`unexpected fork patch: ${subject} (${currentPatchId})`)
    }
    const changedPaths = lines(
      git(['diff-tree', '--no-commit-id', '--name-only', '-r', `${commitSha}^`, commitSha], cwd)
    )
    if (changedPaths.some(isMaintenancePath)) {
      throw new Error(`fork patch ${commitSha} changes a maintenance path`)
    }
    subjects.push(subject)
    expectedIndex += 1
  }
  return subjects
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

function requiredTrailer(commitSha, name, cwd) {
  const prefix = `${name}: `
  const values = lines(git(['show', '-s', '--format=%B', commitSha], cwd))
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
  if (values.length !== 1 || !values[0]) {
    throw new Error(`${commitSha} must contain exactly one ${name} trailer`)
  }
  return values[0]
}

function requireCommitSha(value, field) {
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase 40-character commit SHA`)
  }
  return value
}

export function inspectForkPatchStack({
  anchorRef,
  forkRef,
  targetRef,
  requireTargetDescendant = false,
  cwd = process.cwd()
}) {
  const anchorSha = requireCommitSha(git(['rev-parse', `${anchorRef}^{commit}`], cwd), 'anchorSha')
  const forkSha = requireCommitSha(git(['rev-parse', `${forkRef}^{commit}`], cwd), 'forkSha')
  const targetSha = requireCommitSha(git(['rev-parse', `${targetRef}^{commit}`], cwd), 'targetSha')
  const upstreamSha = requireGeneratedAnchor(anchorSha, cwd)

  if (!isAncestor(anchorSha, forkSha, cwd)) {
    throw new Error(`${anchorRef} is not an ancestor of ${forkRef}`)
  }
  if (requireTargetDescendant && !isAncestor(upstreamSha, targetSha, cwd)) {
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

export function inspectForkCandidate({
  candidateRef,
  cwd = process.cwd(),
  expectedPatchIds = EXPECTED_FORK_PATCH_IDS
}) {
  const candidateSha = requireCommitSha(
    git(['rev-parse', `${candidateRef}^{commit}`], cwd),
    'candidateSha'
  )
  const firstParentCommits = lines(git(['rev-list', '--first-parent', candidateSha], cwd))
  const anchorSha = firstParentCommits.find((commitSha) =>
    commitHasTrailer(commitSha, GENERATED_ANCHOR_TRAILER, cwd)
  )
  if (!anchorSha) {
    throw new Error('candidate has no generated upstream anchor')
  }

  const state = inspectForkPatchStack({
    anchorRef: anchorSha,
    forkRef: candidateSha,
    targetRef: `${anchorSha}^`,
    cwd
  })
  const patchSubjects = assertForkPatchContract(
    state.patchCommits,
    cwd,
    EXPECTED_FORK_PATCH_SUBJECTS,
    expectedPatchIds
  )
  const upstreamTag = requiredTrailer(anchorSha, 'Upstream-Release', cwd)
  if (!/^v\d+\.\d+\.\d+$/.test(upstreamTag)) {
    throw new Error('Upstream-Release trailer must match vX.Y.Z')
  }
  const upstreamSha = requireCommitSha(
    requiredTrailer(anchorSha, 'Upstream-Commit', cwd),
    'upstreamSha'
  )
  if (upstreamSha !== state.upstreamSha) {
    throw new Error('Upstream-Commit trailer does not match the anchor parent')
  }
  const sourceForkSha = requireCommitSha(
    requiredTrailer(anchorSha, 'Fork-Maintenance-Source-Fork', cwd),
    'sourceForkSha'
  )
  const sourceAnchorTrailer = requireCommitSha(
    requiredTrailer(anchorSha, 'Fork-Maintenance-Source-Anchor', cwd),
    'sourceAnchorSha'
  )
  const sourcePreviewSha = requireCommitSha(
    requiredTrailer(anchorSha, 'Fork-Maintenance-Source-Preview', cwd),
    'sourcePreviewSha'
  )
  return {
    ...state,
    candidateSha,
    upstreamTag,
    upstreamSha,
    sourceForkSha,
    sourceAnchorSha: /^0+$/.test(sourceAnchorTrailer) ? null : sourceAnchorTrailer,
    sourcePreviewSha: /^0+$/.test(sourcePreviewSha) ? null : sourcePreviewSha,
    patchSubjects
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
    if (options['enforce-patch-contract'] === 'true') {
      result.patchSubjects = assertForkPatchContract(result.patchCommits)
    }
    console.log(JSON.stringify(result))
    return
  }
  if (command === 'inspect-candidate') {
    console.log(
      JSON.stringify(inspectForkCandidate({ candidateRef: requiredOption(options, 'candidate') }))
    )
    return
  }
  throw new Error('usage: fork-maintenance-state.mjs <inspect|inspect-candidate> [options]')
}

export function isDirectExecution(moduleUrl, executablePath) {
  return (
    Boolean(executablePath) &&
    realpathSync(fileURLToPath(moduleUrl)) === realpathSync(executablePath)
  )
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
