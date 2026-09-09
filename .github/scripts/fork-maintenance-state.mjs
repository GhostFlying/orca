import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const GIT_BINARY = process.env.ORCA_FORK_MAINTENANCE_GIT_BINARY || 'git'
const GENERATED_ANCHOR_TRAILER = 'Fork-Maintenance-Generated: upstream-anchor-v1'
const GENERATED_SNAPSHOT_TRAILER = 'Fork-Maintenance-Generated: maintenance-snapshot-v1'
const HOTFIX_TRANSACTION = 'fork-hotfix-v1'
const MAINTENANCE_PATHS = [
  'AGENTS.md',
  '.github/fork-maintenance-plan.md',
  '.github/fork-maintenance-v1.4.197-implementation-plan.md',
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

export function assertForkPatchPaths(patchCommits, cwd = process.cwd()) {
  for (const commitSha of patchCommits) {
    const changedPaths = lines(
      git(['diff-tree', '--no-commit-id', '--name-only', '-r', `${commitSha}^`, commitSha], cwd)
    )
    if (changedPaths.some(isMaintenancePath)) {
      throw new Error(`fork patch ${commitSha} changes a maintenance path`)
    }
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

function optionalTrailer(commitSha, name, cwd) {
  const prefix = `${name}: `
  const values = lines(git(['show', '-s', '--format=%B', commitSha], cwd))
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
  if (values.length > 1 || values.some((value) => !value)) {
    throw new Error(`${commitSha} may contain at most one non-empty ${name} trailer`)
  }
  return values[0] ?? null
}

function requireCommitSha(value, field) {
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase 40-character commit SHA`)
  }
  return value
}

function requireFixBranch(value, field) {
  const result = spawnSync(GIT_BINARY, ['check-ref-format', '--branch', value], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!value.startsWith('fix/') || result.status !== 0) {
    throw new Error(`${field} must name a valid fix/... branch`)
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
  assertForkPatchPaths(patchCommits, cwd)
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

export function inspectForkHotfixSource({ forkRef, sourceRef, cwd = process.cwd() }) {
  const sourceForkSha = requireCommitSha(
    git(['rev-parse', `${forkRef}^{commit}`], cwd),
    'sourceForkSha'
  )
  const hotfixSourceSha = requireCommitSha(
    git(['rev-parse', `${sourceRef}^{commit}`], cwd),
    'hotfixSourceSha'
  )
  if (sourceForkSha === hotfixSourceSha) {
    throw new Error('hotfix source contains no commits beyond the production fork')
  }
  if (!isAncestor(sourceForkSha, hotfixSourceSha, cwd)) {
    throw new Error('production fork is not an ancestor of the hotfix source')
  }
  const mergeCommits = lines(
    git(['rev-list', '--merges', `${sourceForkSha}..${hotfixSourceSha}`], cwd)
  )
  if (mergeCommits.length > 0) {
    throw new Error(`hotfix source contains merge commits: ${mergeCommits.join(', ')}`)
  }
  const hotfixCommits = lines(
    git(['rev-list', '--reverse', `${sourceForkSha}..${hotfixSourceSha}`], cwd)
  )
  assertForkPatchPaths(hotfixCommits, cwd)
  return {
    version: 1,
    sourceForkSha,
    hotfixSourceSha,
    hotfixCommits,
    hotfixCommitCount: hotfixCommits.length
  }
}

export function inspectForkCandidate({ candidateRef, cwd = process.cwd() }) {
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
  const snapshotSha = state.generatedMaintenanceSnapshotSha
  const transaction = snapshotSha
    ? optionalTrailer(snapshotSha, 'Fork-Maintenance-Transaction', cwd)
    : null
  if (transaction !== null && transaction !== HOTFIX_TRANSACTION) {
    throw new Error(`unsupported Fork-Maintenance-Transaction: ${transaction}`)
  }
  const transactionCommit = transaction === HOTFIX_TRANSACTION ? snapshotSha : anchorSha
  const transactionKind = transaction === HOTFIX_TRANSACTION ? 'fork-hotfix' : 'upstream-release'
  const sourceForkSha = requireCommitSha(
    requiredTrailer(transactionCommit, 'Fork-Maintenance-Source-Fork', cwd),
    'sourceForkSha'
  )
  if (/^0+$/.test(sourceForkSha)) {
    throw new Error('Fork-Maintenance-Source-Fork must identify the captured production fork')
  }
  const sourceAnchorSha = requireCommitSha(
    requiredTrailer(transactionCommit, 'Fork-Maintenance-Source-Anchor', cwd),
    'sourceAnchorSha'
  )
  if (/^0+$/.test(sourceAnchorSha)) {
    throw new Error('Fork-Maintenance-Source-Anchor must identify the captured production anchor')
  }
  const sourcePreviewSha = requireCommitSha(
    requiredTrailer(transactionCommit, 'Fork-Maintenance-Source-Preview', cwd),
    'sourcePreviewSha'
  )
  let hotfixSourceRef = null
  let hotfixSourceSha = null
  if (transactionKind === 'fork-hotfix') {
    if (sourceAnchorSha !== anchorSha) {
      throw new Error('hotfix source anchor does not match the candidate anchor')
    }
    if (/^0+$/.test(sourcePreviewSha)) {
      throw new Error('hotfix source preview must identify the captured production mirror')
    }
    hotfixSourceRef = requireFixBranch(
      requiredTrailer(transactionCommit, 'Fork-Hotfix-Source-Ref', cwd),
      'Fork-Hotfix-Source-Ref'
    )
    hotfixSourceSha = requireCommitSha(
      requiredTrailer(transactionCommit, 'Fork-Hotfix-Source-Commit', cwd),
      'hotfixSourceSha'
    )
  }
  return {
    ...state,
    candidateSha,
    upstreamTag,
    upstreamSha,
    transactionKind,
    sourceForkSha,
    sourceAnchorSha,
    sourcePreviewSha: /^0+$/.test(sourcePreviewSha) ? null : sourcePreviewSha,
    hotfixSourceRef,
    hotfixSourceSha
  }
}

export function verifyForkHotfixCandidate({ candidateRef, sourceRef, cwd = process.cwd() }) {
  const candidate = inspectForkCandidate({ candidateRef, cwd })
  if (candidate.transactionKind !== 'fork-hotfix') {
    throw new Error('candidate is not a fork hotfix transaction')
  }
  if (candidate.sourcePreviewSha !== candidate.sourceForkSha) {
    throw new Error('hotfix source preview is not the captured production fork mirror')
  }
  const source = inspectForkHotfixSource({
    forkRef: candidate.sourceForkSha,
    sourceRef,
    cwd
  })
  if (source.hotfixSourceSha !== candidate.hotfixSourceSha) {
    throw new Error('hotfix source ref does not match the captured source commit')
  }
  const differingPaths = lines(
    git(['diff', '--name-only', source.hotfixSourceSha, candidate.candidateSha], cwd)
  )
  const productDifferences = differingPaths.filter((path) => !isMaintenancePath(path))
  if (productDifferences.length > 0) {
    throw new Error(
      `hotfix candidate differs from its source outside maintenance paths: ${productDifferences.join(', ')}`
    )
  }
  const production = inspectForkPatchStack({
    anchorRef: candidate.sourceAnchorSha,
    forkRef: candidate.sourceForkSha,
    targetRef: `${candidate.sourceAnchorSha}^`,
    cwd
  })
  const retainedProductionPatches = candidate.patchCommits.slice(0, production.patchCount)
  if (retainedProductionPatches.join('\n') !== production.patchCommits.join('\n')) {
    throw new Error('hotfix candidate does not retain the exact production business patch prefix')
  }
  const expectedPatchCount = production.patchCount + source.hotfixCommitCount
  if (candidate.patchCount !== expectedPatchCount) {
    throw new Error(
      `hotfix candidate has ${candidate.patchCount} business patches; expected ${expectedPatchCount}`
    )
  }
  return { ...candidate, hotfixCommits: source.hotfixCommits }
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
  if (command === 'inspect-candidate') {
    console.log(
      JSON.stringify(inspectForkCandidate({ candidateRef: requiredOption(options, 'candidate') }))
    )
    return
  }
  if (command === 'inspect-hotfix-source') {
    console.log(
      JSON.stringify(
        inspectForkHotfixSource({
          forkRef: requiredOption(options, 'fork'),
          sourceRef: requiredOption(options, 'source')
        })
      )
    )
    return
  }
  if (command === 'verify-hotfix-candidate') {
    console.log(
      JSON.stringify(
        verifyForkHotfixCandidate({
          candidateRef: requiredOption(options, 'candidate'),
          sourceRef: requiredOption(options, 'source')
        })
      )
    )
    return
  }
  throw new Error(
    'usage: fork-maintenance-state.mjs <inspect|inspect-candidate|inspect-hotfix-source|verify-hotfix-candidate> [options]'
  )
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
