import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflowPath = new URL('../workflows/fork-sync.yml', import.meta.url)
const vitestConfigPath = new URL('../../config/vitest.config.ts', import.meta.url)
const workflowText = readFileSync(workflowPath, 'utf8')
const vitestConfigText = readFileSync(vitestConfigPath, 'utf8')
const workflow = parse(workflowText)
const checkoutAction = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'

function job(name) {
  const value = workflow.jobs?.[name]
  if (!value) {
    throw new Error(`Missing workflow job: ${name}`)
  }
  return value
}

describe('fork sync workflow', () => {
  it('serializes maintenance without cancelling an in-flight promotion', () => {
    expect(workflow.concurrency).toEqual({
      group: 'fork-maintenance',
      'cancel-in-progress': false
    })
  })

  it('has no pull request or manual promotion path', () => {
    expect(workflowText).not.toContain('pull_request')
    expect(workflowText).not.toContain('issue_comment')
    expect(workflowText).not.toContain('/promote-fork')
    expect(workflowText).not.toContain('gh pr')
    expect(workflowText).not.toContain('environment:')
    expect(job('promote').if).toBe("needs.prepare.outputs.result == 'clean'")
  })

  it('keeps validation jobs read-only', () => {
    for (const name of [
      'maintenance-contract',
      'lint',
      'typecheck',
      'test',
      'build',
      'cross-version-wire'
    ]) {
      expect(job(name).permissions).toEqual({ contents: 'read' })
      expect(JSON.stringify(job(name))).not.toContain('FORK_MAINTENANCE_SSH_KEY')
    }
  })

  it('pins validation checkouts to the generated preview SHA', () => {
    for (const name of [
      'maintenance-contract',
      'lint',
      'typecheck',
      'test',
      'build',
      'cross-version-wire'
    ]) {
      const checkout = job(name).steps.find((step) => step.uses === checkoutAction)
      expect(checkout?.with?.ref).toBe('${{ needs.prepare.outputs.preview_sha }}')
      expect(checkout?.with?.['persist-credentials']).toBe(false)
    }
  })

  it('fetches cross-version baselines from official release tags', () => {
    const crossVersionSteps = job('cross-version-wire').steps
    const fetchIndex = crossVersionSteps.findIndex(
      (step) => step.name === 'Fetch upstream release tags'
    )
    const testIndex = crossVersionSteps.findIndex((step) =>
      step.run?.includes('cross-version-terminal-wire.unit.test.ts')
    )
    const crossVersionWire = crossVersionSteps.map((step) => step.run ?? '').join('\n')
    expect(fetchIndex).toBeGreaterThan(0)
    expect(testIndex).toBeGreaterThan(fetchIndex)
    expect(crossVersionWire).toContain('"https://github.com/${UPSTREAM_REPOSITORY}.git"')
    expect(crossVersionWire).toContain('"+refs/tags/v*:refs/tags/v*"')
    expect(crossVersionWire).toContain('--no-recurse-submodules')
    expect(crossVersionWire).not.toContain('FORK_MAINTENANCE_SSH_KEY')
  })

  it('restores disabled workflows only as pinned unit-test fixtures', () => {
    const testJob = job('test')
    const fixtureStep = testJob.steps.find(
      (step) => step.name === 'Restore disabled workflow test fixtures'
    )
    const fixtureIndex = testJob.steps.indexOf(fixtureStep)
    const testIndex = testJob.steps.findIndex((step) => step.name === 'Test shard')
    expect(fixtureIndex).toBeGreaterThan(0)
    expect(testIndex).toBeGreaterThan(fixtureIndex)
    expect(fixtureStep?.env?.UPSTREAM_TARGET_SHA).toBe('${{ needs.prepare.outputs.target_sha }}')
    expect(fixtureStep?.run).toContain('"${UPSTREAM_TARGET_SHA}"')
    expect(fixtureStep?.run).toContain(
      'test "$(git rev-parse FETCH_HEAD^{commit})" = "${UPSTREAM_TARGET_SHA}"'
    )
    expect(fixtureStep?.run).toContain('if [ ! -e "${WORKFLOW_PATH}" ]; then')
    expect(fixtureStep?.run).toContain('git checkout FETCH_HEAD -- "${WORKFLOW_PATH}"')
    expect(JSON.stringify(testJob)).not.toContain('FORK_MAINTENANCE_SSH_KEY')
  })

  it('keeps upstream retention tests runnable in fork validation', () => {
    expect(vitestConfigText).toContain("'--expose-gc'")
  })

  it('pins every checkout action to one reviewed commit', () => {
    expect(workflowText).not.toContain('actions/checkout@v')
    const checkoutSteps = Object.values(workflow.jobs).flatMap((value) =>
      (value.steps ?? []).filter((step) => step.uses?.startsWith('actions/checkout@'))
    )
    expect(checkoutSteps).toHaveLength(8)
    expect(checkoutSteps.every((step) => step.uses === checkoutAction)).toBe(true)
  })

  it('uses atomic leases for preview publication and promotion', () => {
    expect(workflowText).toContain('git push --atomic')
    expect(workflowText).toContain('PREVIEW_LEASE_SHA: ${{ steps.refs.outputs.preview_lease_sha }}')
    expect(workflowText).toContain(
      '--force-with-lease="refs/heads/${FORK_BRANCH}:${SOURCE_FORK_SHA}"'
    )
    expect(workflowText).toContain(
      '--force-with-lease="refs/heads/${ANCHOR_BRANCH}:${SOURCE_ANCHOR_SHA}"'
    )
    expect(workflowText).toContain(
      '--force-with-lease="refs/heads/${PREVIEW_BRANCH}:${PREVIEW_SHA}"'
    )
  })

  it('keeps replay compatible with the Git 2.25 workflow baseline', () => {
    const prepare = job('prepare')
      .steps.map((step) => step.run ?? '')
      .join('\n')
    expect(prepare).not.toContain('--empty=drop')
    expect(prepare).toContain('git cherry-pick --skip')
  })

  it('restores the trusted maintenance snapshot before publication', () => {
    const prepare = job('prepare')
      .steps.map((step) => step.run ?? '')
      .join('\n')
    expect(prepare).toContain('git checkout "${SOURCE_FORK_SHA}" -- "${MAINTENANCE_PATHS[@]}"')
    expect(prepare).toContain('Fork-Maintenance-Generated: upstream-anchor-v1')
    expect(prepare).toContain('Fork-Maintenance-Generated: maintenance-snapshot-v1')
    expect(prepare).toContain('git diff --quiet "${SOURCE_FORK_SHA}" "${PREVIEW_SHA}" --')
  })

  it('uses the repository owner identity for replay commits', () => {
    expect(workflow.env.FORK_COMMITTER_NAME).toBe('GhostFlying')
    expect(workflow.env.FORK_COMMITTER_EMAIL).toBe('4019569+GhostFlying@users.noreply.github.com')
  })

  it('verifies the pinned preview before promotion', () => {
    const promote = job('promote')
      .steps.map((step) => step.run ?? '')
      .join('\n')
    expect(promote).toContain('CURRENT_PREVIEW_SHA')
    expect(promote).toContain('fork-maintenance-state.mjs inspect')
    expect(promote).toContain('--anchor="${NEXT_ANCHOR_SHA}"')
    expect(promote).toContain('git diff --quiet "${SOURCE_FORK_SHA}" "${PREVIEW_SHA}" --')
  })

  it('uses a repository-scoped deploy key only in the final push steps', () => {
    expect(workflow.permissions).toEqual({})
    expect(job('prepare').permissions).toEqual({ contents: 'read' })
    expect(job('promote').permissions).toEqual({ contents: 'read' })
    expect(job('conflict').permissions).toEqual({})
    expect(workflowText).not.toContain('FORK_MAINTENANCE_TOKEN')
    for (const name of ['prepare', 'promote']) {
      const checkout = job(name).steps.find((step) => step.uses === checkoutAction)
      expect(checkout?.with?.['ssh-key']).toBeUndefined()
      expect(checkout?.with?.['persist-credentials']).toBe(false)
      const keySteps = job(name).steps.filter((step) =>
        JSON.stringify(step).includes('FORK_MAINTENANCE_SSH_KEY')
      )
      expect(keySteps).toHaveLength(1)
      expect(keySteps[0]).toBe(job(name).steps.at(-1))
      expect(keySteps[0].run).toContain('git push --atomic')
    }
  })

  it('never publishes a raw upstream commit as a maintenance ref', () => {
    expect(workflowText).toContain('${NEXT_ANCHOR_SHA}:refs/heads/${ANCHOR_BRANCH}')
    expect(workflowText).not.toContain('${TARGET_SHA}:refs/heads/${ANCHOR_BRANCH}')
  })

  it('disables inherited workflows outside the fork allowlist', () => {
    expect(job('workflow-policy').permissions).toEqual({ actions: 'write' })
    const policy = job('workflow-policy')
      .steps.map((step) => step.run ?? '')
      .join('\n')
    for (const path of [
      '.github/workflows/fork-sync.yml',
      '.github/workflows/pr.yml',
      '.github/workflows/mobile.yml',
      '.github/workflows/e2e.yml'
    ]) {
      expect(policy).toContain(path)
    }
    expect(policy).toContain('/disable')
  })
})
