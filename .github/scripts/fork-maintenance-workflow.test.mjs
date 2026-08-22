import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const syncText = readFileSync(
  new URL('../workflows/sync-upstream-release.yml', import.meta.url),
  'utf8'
)
const buildText = readFileSync(
  new URL('../workflows/fork-release-build.yml', import.meta.url),
  'utf8'
)
const unsignedIosText = readFileSync(
  new URL('../../mobile/scripts/build-unsigned-ios.sh', import.meta.url),
  'utf8'
)
const agentsText = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8')
const stateText = readFileSync(new URL('./fork-maintenance-state.mjs', import.meta.url), 'utf8')
const sync = parse(syncText)
const build = parse(buildText)
const expression = (value) => ['$', '{{ ', value, ' }}'].join('')

function job(workflow, name) {
  const value = workflow.jobs?.[name]
  if (!value) {
    throw new Error(`Missing workflow job: ${name}`)
  }
  return value
}

describe('fork release maintenance workflows', () => {
  it('polls published stable releases without following upstream main', () => {
    expect(sync.on.schedule).toEqual([{ cron: '37 * * * *' }])
    expect(sync.on.workflow_dispatch.inputs.upstream_tag).toBeDefined()
    expect(syncText).toContain('upstream-release.mjs')
    expect(syncText).toContain('refs/tags/$UPSTREAM_TAG')
    expect(syncText).not.toContain('refs/remotes/upstream/main')
    expect(sync.env.ANCHOR_BRANCH).toBe('upstream-release')
    expect(sync.env.PREVIEW_BRANCH).toBe('sync/upstream-release')
  })

  it('routes context-free agents to a preserved conflict runbook', () => {
    expect(agentsText).toContain('.github/fork-maintenance-plan.md')
    expect(agentsText).toContain('Never push directly to `fork` or `upstream-release`')
    expect(agentsText).toContain('<!-- BEGIN FORK RELEASE MAINTENANCE -->')
    expect(agentsText).toContain('<!-- END FORK RELEASE MAINTENANCE -->')
    expect(syncText).toContain('git show "$SOURCE_FORK_SHA:AGENTS.md"')
    expect(syncText).toContain('git show "$TARGET_SHA:AGENTS.md"')
    expect(syncText).toContain('>AGENTS.md')
    expect(stateText).toContain("'AGENTS.md'")
  })

  it('publishes only a leased candidate before the build gate', () => {
    const publish = job(sync, 'prepare').steps.find(
      (step) => step.name === 'Publish leased candidate'
    )
    expect(publish.if).toBe("steps.replay.outputs.result == 'clean'")
    expect(publish.run).toContain('--force-with-lease=refs/heads/$PREVIEW_BRANCH')
    expect(publish.run).not.toContain('$PREVIEW_SHA:refs/heads/$FORK_BRANCH')
    expect(publish.run).not.toContain('$ANCHOR_SHA:refs/heads/$ANCHOR_BRANCH')
    expect(sync.jobs.finalize).toBeUndefined()
  })

  it('starts the gated build from an exact preview push', () => {
    expect(build.on.push.branches).toEqual(['sync/upstream-release'])
    expect(build.concurrency).toEqual({
      group: 'fork-release-maintenance',
      'cancel-in-progress': false
    })
    const checkout = job(build, 'candidate').steps.find(
      (step) => step.uses === 'actions/checkout@v6'
    )
    expect(checkout?.with?.ref).toBe(expression('github.sha'))
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  it('keeps candidate validation and build jobs read-only', () => {
    for (const name of [
      'candidate',
      'maintenance-contract',
      'lint',
      'typecheck',
      'test',
      'cross-version-wire',
      'mobile-checks',
      'desktop',
      'android',
      'ios',
      'release-bundle'
    ]) {
      expect(job(build, name).permissions).toEqual({ contents: 'read' })
      expect(JSON.stringify(job(build, name))).not.toContain('FORK_MAINTENANCE_SSH_KEY')
    }
    expect(job(build, 'finalize').permissions).toEqual({ contents: 'write' })
  })

  it('pins every build checkout to the inspected candidate SHA', () => {
    for (const name of [
      'maintenance-contract',
      'lint',
      'typecheck',
      'test',
      'cross-version-wire',
      'mobile-checks',
      'desktop',
      'android',
      'ios',
      'release-bundle',
      'finalize'
    ]) {
      const checkout = job(build, name).steps.find((step) => step.uses === 'actions/checkout@v6')
      expect(checkout?.with?.ref).toBe(expression('needs.candidate.outputs.candidate_sha'))
      expect(checkout?.with?.['persist-credentials']).toBe(false)
    }
  })

  it('fetches and verifies the exact upstream Release for cross-version tests', () => {
    const crossVersion = job(build, 'cross-version-wire')
    const fetchBaseline = crossVersion.steps.find(
      (step) => step.name === 'Fetch exact upstream Release baseline'
    )
    expect(fetchBaseline.env.UPSTREAM_SHA).toBe(expression('needs.candidate.outputs.upstream_sha'))
    expect(fetchBaseline.env.UPSTREAM_TAG).toBe(expression('needs.candidate.outputs.upstream_tag'))
    expect(fetchBaseline.run).toContain('refs/tags/$UPSTREAM_TAG:refs/tags/$UPSTREAM_TAG')
    expect(fetchBaseline.run).toContain('$UPSTREAM_TAG^{commit}')
    const testStep = crossVersion.steps.find((step) =>
      step.run?.includes('cross-version-terminal-wire.unit.test.ts')
    )
    expect(testStep.env.ORCA_CROSS_VERSION_BASELINE_REF).toBe(
      expression('needs.candidate.outputs.upstream_tag')
    )
  })

  it('restores upstream workflow fixtures before running the upstream test suite', () => {
    const testJob = job(build, 'test')
    const checkout = testJob.steps.find((step) => step.uses === 'actions/checkout@v6')
    const restore = testJob.steps.find((step) => step.name === 'Restore upstream workflow fixtures')
    expect(checkout.with['fetch-depth']).toBe(0)
    expect(restore.env.UPSTREAM_SHA).toBe(expression('needs.candidate.outputs.upstream_sha'))
    expect(restore.run).toContain('git checkout "$UPSTREAM_SHA" -- .github/workflows')
    expect(testJob.steps.indexOf(restore)).toBeLessThan(
      testJob.steps.findIndex((step) => step.name === 'Test shard')
    )
  })

  it('builds unsigned desktop and mobile clients without stores', () => {
    expect(buildText).toContain('windows-2022')
    expect(buildText).toContain('ubuntu-24.04-arm')
    expect(buildText).toContain('macos-15')
    expect(buildText).toContain('macos-26')
    expect(buildText).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
    expect(unsignedIosText).toContain('CODE_SIGNING_ALLOWED=NO')
    expect(buildText).toContain('assembleRelease')
    expect(buildText).not.toContain('TestFlight')
  })

  it('uses Git 2.25 compatible replay and atomic exact promotion leases', () => {
    expect(syncText).not.toContain('--empty=drop')
    expect(syncText).toContain('git cherry-pick --skip')
    expect(buildText).toContain('git push --atomic')
    expect(buildText).toContain('--force-with-lease="refs/heads/$FORK_BRANCH:$SOURCE_FORK_SHA"')
    expect(buildText).toContain('--force-with-lease="refs/heads/$ANCHOR_BRANCH:$SOURCE_ANCHOR_SHA"')
    expect(buildText).toContain('--force-with-lease="refs/heads/$PREVIEW_BRANCH:$CANDIDATE_SHA"')
    const promote = job(build, 'finalize').steps.find(
      (step) => step.name === 'Atomically promote candidate'
    )
    expect(promote.run).toContain('"git@github.com:$GITHUB_REPOSITORY.git"')
    expect(promote.run).not.toContain('git remote set-url origin')
  })

  it('publishes only after local and remote asset verification and promotion', () => {
    const names = job(build, 'finalize')
      .steps.map((step) => step.name)
      .filter(Boolean)
    expect(job(build, 'release-bundle').steps.map((step) => step.name)).toContain(
      'Verify complete release assets'
    )
    expect(names.indexOf('Verify trusted release bundle')).toBeLessThan(
      names.indexOf('Create or refresh draft Release')
    )
    expect(names.indexOf('Verify uploaded assets')).toBeLessThan(
      names.indexOf('Atomically promote candidate')
    )
    expect(names.indexOf('Atomically promote candidate')).toBeLessThan(
      names.indexOf('Publish complete fork Release')
    )
    const verifyUploaded = job(build, 'finalize').steps.find(
      (step) => step.name === 'Verify uploaded assets'
    )
    const publish = job(build, 'finalize').steps.find(
      (step) => step.name === 'Publish complete fork Release'
    )
    expect(verifyUploaded.run).not.toContain('refs/tags/$RELEASE_TAG')
    expect(publish.run.indexOf('draft: false')).toBeLessThan(
      publish.run.indexOf('refs/tags/$RELEASE_TAG')
    )
    expect(publish.env.RELEASE_TAG).toBe(expression('needs.release-bundle.outputs.release_tag'))
  })

  it('enforces the intended workflow allowlist', () => {
    const policy = JSON.stringify(job(sync, 'workflow-policy'))
    for (const path of [
      'sync-upstream-release.yml',
      'fork-release-build.yml',
      'pr.yml',
      'mobile.yml',
      'e2e.yml'
    ]) {
      expect(policy).toContain(path)
    }
    expect(policy).toContain('/disable')
  })
})
