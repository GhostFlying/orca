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
    expect(sync.env.PINNED_WORKTREE_SCAN_BRANCH).toBe('p/luchengxuan/worktree-scan-last-known-good')
    expect(syncText).toContain('refs/remotes/origin/pinned-worktree-scan')
    expect(syncText).toContain('patchCount: 4')
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
      'android-sign',
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

  it('fetches and verifies every upstream Release used by cross-version tests', () => {
    const crossVersion = job(build, 'cross-version-wire')
    const fetchBaseline = crossVersion.steps.find(
      (step) => step.name === 'Fetch exact upstream Release baselines'
    )
    expect(fetchBaseline.env.UPSTREAM_SHA).toBe(expression('needs.candidate.outputs.upstream_sha'))
    expect(fetchBaseline.env.UPSTREAM_TAG).toBe(expression('needs.candidate.outputs.upstream_tag'))
    expect(fetchBaseline.env.TERMINAL_MODE_METADATA_LEGACY_TAG).toBe('v1.4.190')
    expect(fetchBaseline.env.TERMINAL_MODE_METADATA_LEGACY_SHA).toBe(
      '6e4f817101daa18d82824b69243d9079baa9c416'
    )
    expect(fetchBaseline.run).toContain('refs/tags/$UPSTREAM_TAG:refs/tags/$UPSTREAM_TAG')
    expect(fetchBaseline.run).toContain(
      'refs/tags/$TERMINAL_MODE_METADATA_LEGACY_TAG:refs/tags/$TERMINAL_MODE_METADATA_LEGACY_TAG'
    )
    expect(fetchBaseline.run).toContain('$UPSTREAM_TAG^{commit}')
    expect(fetchBaseline.run).toContain('$TERMINAL_MODE_METADATA_LEGACY_TAG^{commit}')
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
    const repair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.196 signing contract fixture'
    )
    expect(checkout.with['fetch-depth']).toBe(0)
    expect(restore.env.UPSTREAM_SHA).toBe(expression('needs.candidate.outputs.upstream_sha'))
    expect(restore.run).toContain('git checkout "$UPSTREAM_SHA" --')
    expect(restore.run).toContain('.github/workflows')
    expect(restore.run).toContain('config/scripts/windows-signing-workflow-contract.test.mjs')
    expect(repair.if).toBe(
      "needs.candidate.outputs.upstream_sha == 'aad4ae42ea5e555f25fdec679ebbcd18cc1e8911'"
    )
    expect(repair.run).toContain('08aa4e4e6d446f1dd0fc262cf0b9b10735f32439')
    expect(repair.run).toContain('37edc2196d472c30e20f3bf160e7f2dc6077af32')
    expect(repair.run).toContain(
      "it('verifies Windows inner binary signatures fail-open before publishing'"
    )
    expect(testJob.steps.indexOf(restore)).toBeLessThan(testJob.steps.indexOf(repair))
    expect(testJob.steps.indexOf(repair)).toBeLessThan(
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

  it('signs Android releases with the fork key in an isolated job', () => {
    const android = job(build, 'android')
    const signing = job(build, 'android-sign')
    const signingStep = signing.steps.find((step) => step.name === 'Sign and verify APK')
    expect(android.steps.map((step) => step.name).filter(Boolean)).toContain(
      'Remove template debug signing from release build'
    )
    expect(JSON.stringify(android)).not.toContain('FORK_ANDROID_RELEASE_KEYSTORE')
    expect(signing.needs).toEqual(['candidate', 'android'])
    expect(signing.steps.some((step) => step.uses === 'actions/checkout@v6')).toBe(false)
    expect(JSON.stringify(signing)).toContain('FORK_ANDROID_RELEASE_KEYSTORE_BASE64')
    expect(JSON.stringify(signing)).toContain('FORK_ANDROID_RELEASE_KEYSTORE_PASSWORD')
    expect(signing.outputs.certificate_sha256).toBe(
      expression('steps.sign.outputs.certificate_sha256')
    )
    expect(JSON.stringify(signing)).toContain('apksigner')
    expect(signingStep.run).toContain('verify --verbose --print-certs')
    expect(signingStep.run).toContain('^.*certificate SHA-256 digest:')
    expect(signingStep.run).toContain("tr '[:upper:]' '[:lower:]'")
    expect(signingStep.run).toContain("sed -E 's/[[:space:]]*,[[:space:]]*/,/g'")
    expect(signingStep.run).toContain('keytool -exportcert')
    expect(signingStep.run).toContain('test "$certificate_sha256" = "$expected_certificate_sha256"')
    expect(signingStep.run).toContain(
      'test "$certificate_sha256" != "$EXPO_DEBUG_CERTIFICATE_SHA256"'
    )
    expect(signingStep.run).toContain('CN=Orca Fork Release')
    expect(signingStep.run).toContain('echo "certificate_sha256=$certificate_sha256"')
    expect(buildText).toContain('needs.android-sign.outputs.certificate_sha256')
    expect(buildText).toContain('.androidSigning.certificateSha256')
    expect(buildText).toContain('name: android-signing-input')
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

  it('enforces the intended active workflow allowlist', () => {
    const policy = JSON.stringify(job(sync, 'workflow-policy'))
    for (const path of [
      'sync-upstream-release.yml',
      'fork-release-build.yml',
      'pr.yml',
      'mobile.yml'
    ]) {
      expect(policy).toContain(path)
    }
    expect(policy).not.toContain('e2e.yml')
    expect(policy).toContain('/disable')
  })
})
