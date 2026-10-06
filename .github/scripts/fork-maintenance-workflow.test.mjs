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
const hotfixText = readFileSync(
  new URL('../workflows/fork-hotfix-candidate.yml', import.meta.url),
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
const hotfix = parse(hotfixText)
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
    expect(Object.keys(sync.env)).not.toContainEqual(expect.stringMatching(/^PINNED_/))
    expect(syncText).not.toContain('refs/remotes/origin/pinned-')
    expect(syncText).not.toContain('enforce-patch-contract')
    expect(stateText).not.toContain('EXPECTED_FORK_PATCH')
    expect(stateText).not.toContain(`['patch-id', '--stable']`)
    expect(stateText).toContain('assertForkPatchPaths')
    expect(syncText).toContain(`'.patchCommits[]'`)
  })

  it('fails closed when the production anchor is missing', () => {
    const fetch = job(sync, 'prepare').steps.find(
      (step) => step.name === 'Fetch transaction refs and release commit'
    )
    expect(fetch.run).toContain('$ANCHOR_BRANCH is missing; restore it explicitly before syncing.')
    expect(fetch.run).not.toContain('anchor_sha=0000000000000000000000000000000000000000')
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
    expect(build.on.push.branches).toEqual(['candidate/fork-hotfix', 'sync/upstream-release'])
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

  it('intakes reviewed hotfixes without treating a fix branch as a release candidate', () => {
    expect(hotfix.on.schedule).toBeUndefined()
    expect(hotfix.on.workflow_dispatch.inputs.source_ref).toBeDefined()
    expect(hotfix.concurrency).toEqual({
      group: 'fork-release-maintenance',
      'cancel-in-progress': false
    })
    expect(hotfix.env.HOTFIX_CANDIDATE_BRANCH).toBe('candidate/fork-hotfix')
    const prepare = job(hotfix, 'prepare')
    expect(prepare.if).toContain("github.ref == 'refs/heads/fork'")
    expect(prepare.permissions).toEqual({ contents: 'read' })
    expect(hotfixText).toContain('case "$SOURCE_REF" in')
    expect(hotfixText).toContain('fix/*) ;;')
    expect(hotfixText).toContain('test "$source_preview_sha" = "$source_fork_sha"')
    expect(hotfixText).toContain('inspect-hotfix-source')
    expect(hotfixText).toContain('verify-hotfix-candidate')
    expect(hotfixText).toContain('Fork-Maintenance-Transaction: fork-hotfix-v1')
    expect(hotfixText).toContain('Fork-Hotfix-Source-Commit: $HOTFIX_SOURCE_SHA')
    expect(hotfixText).toContain('$CANDIDATE_SHA:refs/heads/$HOTFIX_CANDIDATE_BRANCH')
    expect(hotfixText).not.toContain('$CANDIDATE_SHA:refs/heads/$FORK_BRANCH')
    expect(hotfixText).not.toContain('$CANDIDATE_SHA:refs/heads/$PREVIEW_BRANCH')
  })

  it('selects and revalidates the canonical candidate ref by transaction kind', () => {
    const refs = job(build, 'candidate').steps.find(
      (step) => step.name === 'Verify current transaction refs'
    )
    expect(refs.run).toContain('test "$GITHUB_REF" = "refs/heads/$PREVIEW_BRANCH"')
    expect(refs.run).toContain('test "$GITHUB_REF" = "refs/heads/$HOTFIX_CANDIDATE_BRANCH"')
    expect(refs.run).toContain('test "$(remote_ref "$HOTFIX_SOURCE_REF")" = "$HOTFIX_SOURCE_SHA"')
    expect(refs.run).toContain('verify-hotfix-candidate')
    expect(refs.run).not.toContain('refs/heads/fix/')
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

  it('checks fork code quality against the generated upstream anchor', () => {
    const lint = job(build, 'lint')
    const checkout = lint.steps.find((step) => step.uses === 'actions/checkout@v6')
    const repair = lint.steps.find((step) => step.name === 'Repair v1.4.199 localization fixture')
    const patchQuality = lint.steps.find((step) => step.name === 'Enforce fork patch code quality')
    const repositoryQuality = lint.steps.find(
      (step) => step.name === 'Verify repository-wide quality contracts'
    )

    expect(checkout.with['fetch-depth']).toBe(0)
    expect(repair.if).toBe(
      "needs.candidate.outputs.upstream_sha == '28957d6004dd191b6f0baff493a9fd3d37405d9d'"
    )
    expect(repair.run).toContain('47024572e8c7bcb5863942ff8d7d6a6d0df411fb')
    expect(repair.run).toContain('a1c33b790bc6f75e7ef0b4a897575c605c959dea')
    expect(JSON.stringify(lint)).not.toContain('pnpm lint')
    expect(JSON.stringify(lint)).toContain('pnpm exec oxlint --format github')
    expect(patchQuality.env.FORK_PATCH_BASE).toBe(expression('needs.candidate.outputs.anchor_sha'))
    expect(patchQuality.run).toContain('oxlint-code-quality-native-plugins.json')
    expect(patchQuality.run).toContain('--deny-warnings "${fork_files[@]}"')
    expect(patchQuality.run).toContain('check:code-quality:changed -- "$FORK_PATCH_BASE"')
    expect(patchQuality.run).toContain('check:react-doctor:changed -- "$FORK_PATCH_BASE"')
    expect(repositoryQuality.run).toContain('check:reliability-gates')
    expect(repositoryQuality.run).toContain('verify:localization-coverage')
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
    const relayDependencies = testJob.steps.find(
      (step) => step.name === 'Install relay integration dependencies'
    )
    const restore = testJob.steps.find((step) => step.name === 'Restore upstream workflow fixtures')
    const latestReleaseCutFixtureRepair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.222 release-cut fixtures'
    )
    const releaseCutFixtureRepair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.220 release-cut fixtures'
    )
    const mobileFixtureRepair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.218 mobile workflow fixtures'
    )
    const repair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.196 signing contract fixture'
    )
    const localizationRepair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.199 localization fixture'
    )
    const hourlyRepair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.206 hourly version fixture'
    )
    const latestHourlyRepair = testJob.steps.find(
      (step) => step.name === 'Repair v1.4.215 hourly version fixture'
    )
    const testShard = testJob.steps.find((step) => step.name === 'Test shard')
    expect(checkout.with['fetch-depth']).toBe(0)
    expect(relayDependencies['working-directory']).toBe('cloud')
    expect(relayDependencies.run).toContain(
      "pnpm@10.24.0 --filter '@orca-cloud/relay...' install --frozen-lockfile --ignore-scripts"
    )
    expect(relayDependencies.run).toContain("pnpm@10.24.0 --filter '@orca-cloud/relay^...' build")
    expect(restore.env.UPSTREAM_SHA).toBe(expression('needs.candidate.outputs.upstream_sha'))
    expect(restore.run).toContain('git rm -r --ignore-unmatch -- .github/workflows')
    expect(restore.env.UPSTREAM_TAG).toBe(expression('needs.candidate.outputs.upstream_tag'))
    expect(restore.run).toContain('fixture_sha="$UPSTREAM_SHA"')
    expect(restore.run).toContain(
      '"ci: sync release workflows with main for the $UPSTREAM_TAG cut"'
    )
    expect(restore.run).toContain(
      `git diff --name-only "$sync_sha^" "$sync_sha" -- . ':(exclude).github/workflows'`
    )
    expect(restore.run).toContain('fixture_sha="$sync_sha^"')
    expect(restore.run).toContain('git checkout "$fixture_sha" -- .github/workflows')
    expect(restore.run).toContain('git cat-file -e "$UPSTREAM_SHA:$signing_contract"')
    expect(restore.run).toContain('git rm --ignore-unmatch -- "$signing_contract"')
    expect(restore.run).toContain('config/scripts/windows-signing-workflow-contract.test.mjs')
    expect(latestReleaseCutFixtureRepair.if).toBe(
      "needs.candidate.outputs.upstream_sha == '4bb6f2072b07c1f0664b809551f77754700570e4'"
    )
    expect(latestReleaseCutFixtureRepair.run).toContain('76073d24d89f8d5576c066394601c3aa97427d31')
    expect(latestReleaseCutFixtureRepair.run).toContain('9d986cc3c4d5f534c2bdfe3155a894757dc8bb52')
    expect(latestReleaseCutFixtureRepair.run).toContain('git apply --unidiff-zero')
    expect(latestReleaseCutFixtureRepair.run.match(/git hash-object/g)).toHaveLength(2)
    expect(latestReleaseCutFixtureRepair.run).toContain(
      "expect([...entries].sort()).toEqual(['relay-0.1.0+aaa', 'relay-0.1.0+bbb'])"
    )
    expect(releaseCutFixtureRepair.if).toBe(
      "needs.candidate.outputs.upstream_sha == 'a7927b28ce45cbb044add478d957abe36c99ccd8'"
    )
    expect(releaseCutFixtureRepair.run).toContain('d9dc6332a9f0747d70f7aeaa37110d3c2f0d33ac')
    expect(releaseCutFixtureRepair.run).toContain('d116d79c4189ce069de7b98ae27cd6f961f316d6')
    expect(releaseCutFixtureRepair.run).toContain('expect(ratchet).toBeGreaterThan(join)')
    expect(releaseCutFixtureRepair.run).toContain('74b15e9b2673954d8c31431a17c36643f6ee21a1')
    expect(releaseCutFixtureRepair.run).toContain('8ce6edfcd9568ceb741ce3f4cad63853fd11c446')
    expect(releaseCutFixtureRepair.run).toContain('584c37f6740f757495655ef19d569a724a7e152d')
    expect(releaseCutFixtureRepair.run).toContain('3452e99aff2b26a4fe8785a0a94af4bcd620a480')
    expect(releaseCutFixtureRepair.run).toContain('steps["pnpm-store-mode"].outputs["lookup-only"]')
    expect(releaseCutFixtureRepair.run).toContain("'cache-pnpm-store': 'true'")
    expect(releaseCutFixtureRepair.run).toContain(
      "expect(workflow.on.schedule).toEqual([{ cron: '41 */6 * * *' }])"
    )
    expect(releaseCutFixtureRepair.run).toContain("'cache-pnpm-store-lookup-only': 'true'")
    expect(releaseCutFixtureRepair.run).not.toContain("readWorkflow('pr').jobs.preflight")
    expect(releaseCutFixtureRepair.run).toContain('611dd974b79d1be707b93662da6838053fa3c17f')
    expect(releaseCutFixtureRepair.run).toContain('ee9e63cd4d5e74c5a9bf3c7cb6ce3102616a8d1b')
    expect(releaseCutFixtureRepair.run).toContain('6851ed62f9ba3575a3555b3e5622395ae8de3c4e')
    expect(releaseCutFixtureRepair.run).toContain('045cc5de6d82940fc1c90b9b19648dc0086d8bb8')
    expect(releaseCutFixtureRepair.run).toContain('f6f05c779ebfaf2133d31cb1f9752d598f5fac04')
    expect(releaseCutFixtureRepair.run).toContain('5f45d6872ac498615e7d7f76f591b24e9a4f9d76')
    expect(releaseCutFixtureRepair.run).toContain('2277cd399a491bbddf5041908167976ac217e6e3')
    expect(releaseCutFixtureRepair.run).toContain('d939a6231ef988a6f33d66dae3ea8e30e6e74c53')
    expect(releaseCutFixtureRepair.run).toContain('c79706ab4fdb6bd26ca233058d200d1383c91cd8')
    expect(releaseCutFixtureRepair.run).toContain('35c2cddecc25d484d31d06fa1d8e46b28118d6a3')
    expect(releaseCutFixtureRepair.run).toContain("enabled: 'false'")
    expect(releaseCutFixtureRepair.run).toContain('ORCA_PNPM_STORE_CACHE_PATH')
    expect(releaseCutFixtureRepair.run).toContain('needs.publish-release.result')
    expect(releaseCutFixtureRepair.run).toContain("'darwin-arm64': 'macos-15'")
    expect(releaseCutFixtureRepair.run).toContain(
      "steps.pnpm-store-mode.outputs.lookup-only != 'true'"
    )
    expect(releaseCutFixtureRepair.run).toContain(
      "inputs.cache-dependency-path == 'pnpm-lock.yaml'"
    )
    expect(releaseCutFixtureRepair.run).toContain('c64d019d06cb751615b852cf69d1038c137719e1')
    expect(releaseCutFixtureRepair.run).toContain('c7826210aef12c8d9363d3c5471ba90d6ee3f4ca')
    expect(releaseCutFixtureRepair.run).toContain('c03c7973f6a83aa4593bb7b0fdd1cc40b328da83')
    expect(releaseCutFixtureRepair.run).toContain('ca7d5fe03220e7dd9d95c8ae3e0d8a359c607d88')
    expect(releaseCutFixtureRepair.run).toContain('0ff118ed678340958dc74fea01ca13425447b3ff')
    expect(releaseCutFixtureRepair.run).toContain('607acd0cf5747ccd39649bbe25bff34694686bf3')
    expect(releaseCutFixtureRepair.run).toContain('--defer-graph --full-qualification')
    expect(releaseCutFixtureRepair.run).toContain(
      'git-compat-baseline-__GH_EXPR_OPEN__ runner.os }}'
    )
    expect(releaseCutFixtureRepair.run).toContain(
      String.raw`replaceAll('__GH_EXPR_OPEN__','\$'+'{{')`
    )
    expect(releaseCutFixtureRepair.run).toContain(
      "const cacheInputExpression = '$' + '{{ inputs.cache-pnpm-verification }}'"
    )
    expect(releaseCutFixtureRepair.run).not.toContain(
      "toBe('${{ inputs.cache-pnpm-verification }}')"
    )
    expect(releaseCutFixtureRepair.run).toContain('9558255e482e1eed20d5cd63d115a08768aa7815')
    expect(releaseCutFixtureRepair.run).toContain('c7e58af93e34d0bb683be28fc3f1fa2dec21fcf3')
    expect(releaseCutFixtureRepair.run).toContain('src/main/jcode/hook-gate-script.test.ts')
    expect(releaseCutFixtureRepair.run).toContain(
      'src/main/ipc/preflight-provider-command-selection.test.ts'
    )
    expect(releaseCutFixtureRepair.run).toContain(
      'src/main/ipc/preflight-runnable-local-cli.test.ts'
    )
    expect(mobileFixtureRepair.if).toBe(
      "needs.candidate.outputs.upstream_sha == '75ea50273328d9bd5465170d10a098711d61b5a4'"
    )
    expect(mobileFixtureRepair.run).toContain('cd7c204f8178a90d5c4dfc0b6a74e8f16718d357')
    expect(mobileFixtureRepair.run).toContain('7ff6251afd6dc4f878c5bff1033eddfe8f7699c0')
    expect(mobileFixtureRepair.run).toContain('eafa3194238ea3b8130a09ed754cb54c3b28ed41')
    expect(mobileFixtureRepair.run).toContain("step.name !== 'Summarize RPC recording changes'")
    expect(mobileFixtureRepair.run).toContain('git rm -- "$stale_fixture"')
    expect(localizationRepair.if).toBe(
      "needs.candidate.outputs.upstream_sha == '28957d6004dd191b6f0baff493a9fd3d37405d9d'"
    )
    expect(localizationRepair.run).toContain('47024572e8c7bcb5863942ff8d7d6a6d0df411fb')
    expect(localizationRepair.run).toContain('a1c33b790bc6f75e7ef0b4a897575c605c959dea')
    expect(repair.if).toBe(
      "needs.candidate.outputs.upstream_sha == 'aad4ae42ea5e555f25fdec679ebbcd18cc1e8911'"
    )
    expect(repair.run).toContain('08aa4e4e6d446f1dd0fc262cf0b9b10735f32439')
    expect(repair.run).toContain('37edc2196d472c30e20f3bf160e7f2dc6077af32')
    expect(repair.run).toContain(
      "it('verifies Windows inner binary signatures fail-open before publishing'"
    )
    expect(hourlyRepair.if).toBe(
      "needs.candidate.outputs.upstream_sha == 'c62eca3988ce4d7fce12fbfd20c0c47b39e9ecac'"
    )
    expect(hourlyRepair.run).toContain('7438b16acbd240cc8094d23c180611b02ea1ad20')
    expect(hourlyRepair.run).toContain('ef5bc2a77f60994dd04ebe83cfcbb595017cd385')
    expect(latestHourlyRepair.if).toBe(
      "needs.candidate.outputs.upstream_sha == '083f583a53e4c74a65acf420eee4ca2e0efa9df1'"
    )
    expect(latestHourlyRepair.run).toContain('9f6b9000844fae89a04bf9da3f7d5f604d41e5f4')
    expect(latestHourlyRepair.run).toContain('7438b16acbd240cc8094d23c180611b02ea1ad20')
    expect(latestHourlyRepair.run).toContain('2af342065ba34e48757664a4c417987de297dbe2')
    expect(latestHourlyRepair.run).toContain('861f8941cf1a323d255d0a22dd786d8dc2bcd938')
    expect(testShard.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(testJob.steps.indexOf(restore)).toBeLessThan(testJob.steps.indexOf(repair))
    expect(testJob.steps.indexOf(restore)).toBeLessThan(
      testJob.steps.indexOf(releaseCutFixtureRepair)
    )
    expect(testJob.steps.indexOf(releaseCutFixtureRepair)).toBeLessThan(
      testJob.steps.indexOf(testShard)
    )
    expect(testJob.steps.indexOf(restore)).toBeLessThan(
      testJob.steps.indexOf(latestReleaseCutFixtureRepair)
    )
    expect(testJob.steps.indexOf(latestReleaseCutFixtureRepair)).toBeLessThan(
      testJob.steps.indexOf(testShard)
    )
    expect(testJob.steps.indexOf(restore)).toBeLessThan(testJob.steps.indexOf(localizationRepair))
    expect(testJob.steps.indexOf(restore)).toBeLessThan(testJob.steps.indexOf(mobileFixtureRepair))
    expect(testJob.steps.indexOf(mobileFixtureRepair)).toBeLessThan(
      testJob.steps.indexOf(testShard)
    )
    expect(testJob.steps.indexOf(repair)).toBeLessThan(
      testJob.steps.findIndex((step) => step.name === 'Test shard')
    )
    expect(testJob.steps.indexOf(hourlyRepair)).toBeLessThan(testJob.steps.indexOf(testShard))
    expect(testJob.steps.indexOf(latestHourlyRepair)).toBeLessThan(testJob.steps.indexOf(testShard))
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

  it('installs both macOS CPU variants before packaging both clients', () => {
    const desktop = job(build, 'desktop')
    const macInstall = desktop.steps.find(
      (step) => step.name === 'Install macOS release dependencies'
    )
    expect(macInstall.if).toBe("matrix.platform == 'macos'")
    expect(macInstall.with.command).toBe('pnpm install:release')
    expect(
      desktop.steps.some((step) => step.uses === './.github/actions/install-mobile-dependencies')
    ).toBe(true)
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
    expect(buildText).toContain(
      '--force-with-lease="refs/heads/$PREVIEW_BRANCH:$preview_lease_sha"'
    )
    expect(buildText).toContain('preview_lease_sha="$SOURCE_PREVIEW_SHA"')
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
      'fork-hotfix-candidate.yml',
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
