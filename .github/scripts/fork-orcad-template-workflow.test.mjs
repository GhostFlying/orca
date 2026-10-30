import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { generateTemplateWorkflow, templateWorkflowAt } from './fork-orcad-template-workflow.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const generated = read('../workflows/fork-orcad-template.yml')
const upstreamSha = generated.match(/^# Generated from ([a-f0-9]{40}):/)[1]
const upstream = execFileSync(
  'git',
  ['show', `${upstreamSha}:.github/workflows/node-server-tests.yml`],
  {
    encoding: 'utf8'
  }
)
const template = parse(generated)
const build = parse(read('../workflows/fork-release-build.yml'))
const syncText = read('../workflows/sync-upstream-release.yml')
const hotfixText = read('../workflows/fork-hotfix-candidate.yml')
const expression = (value) => ['$', '{{ ', value, ' }}'].join('')
const withFastRunnersInput = (source) =>
  source.includes('\n      fast_runners:\n')
    ? source
    : source.replace(
        /(^  workflow_call:\n[\s\S]*?^      build_template:\n(?:^ {8}.*\n)+)/m,
        `$1      fast_runners:\n        type: boolean\n        default: false\n`
      )
const withReadOnlyJobPermissions = (source) =>
  /^    permissions:/m.test(source)
    ? source
    : source.replace('  persistence:\n', '  persistence:\n    permissions:\n      contents: read\n')

describe('fork server template workflow', () => {
  it('reproduces the selected release with only call triggers and complete qualification', () => {
    expect(templateWorkflowAt(upstreamSha)).toBe(generated)
    expect(generateTemplateWorkflow(upstream, upstreamSha)).toBe(generated)
    expect(Object.keys(template.on)).toEqual(['workflow_call'])
    expect(template.on.workflow_call).toEqual(parse(upstream).on.workflow_call)
    const original = parse(upstream)
    const expectedJobs = structuredClone(original.jobs)
    expectedJobs.changes.if = expression(
      `!inputs.build_template && (${original.jobs.changes.if.trim().replace(/\s*\n\s*/g, ' ')})`
    )
    expect(template.jobs).toEqual(expectedJobs)
    expect(template.permissions).toEqual({ contents: 'read' })
    for (const [key, value] of Object.entries(original)) {
      if (key !== 'on' && key !== 'jobs') {
        expect(template[key]).toEqual(value)
      }
    }
  })

  it('regenerates future release lanes instead of carrying the old qualification body', () => {
    const future = upstream.replace('timeout-minutes: 30', 'timeout-minutes: 45')
    const next = parse(generateTemplateWorkflow(future, 'a'.repeat(40)))
    expect(next.jobs.desktop_template['timeout-minutes']).toBe(45)
    expect(Object.keys(next.on)).toEqual(['workflow_call'])
  })

  it('accepts the known fast-runner input and read-only job permissions', () => {
    const compatible = withReadOnlyJobPermissions(withFastRunnersInput(upstream))
    const next = parse(generateTemplateWorkflow(compatible, 'a'.repeat(40)))
    expect(next.on.workflow_call.inputs.fast_runners).toMatchObject({
      type: 'boolean',
      default: parse(compatible).on.workflow_call.inputs.fast_runners.default
    })
    expect(next.jobs.persistence.permissions).toEqual({ contents: 'read' })
  })

  it('preserves read-only artifact access for template qualification', () => {
    const compatible = upstream.replace(
      /(^  desktop_template:\n[\s\S]*?^    permissions:\n)      contents: read\n(?:      actions: read\n)?/m,
      '$1      contents: read\n      actions: read\n'
    )
    const next = parse(generateTemplateWorkflow(compatible, upstreamSha))
    expect(next.jobs.desktop_template.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(() =>
      generateTemplateWorkflow(compatible.replace('actions: read', 'actions: write'), upstreamSha)
    ).toThrow('read-only contents permission')
  })

  it.each([
    (source) =>
      source.replace(
        "Upload each lane's release slot and merge them into the orcad-template artifact\n        type: boolean",
        'changed\n        type: string'
      ),
    (source) => source.replace('contents: read', 'contents: write'),
    (source) =>
      withReadOnlyJobPermissions(source).replace(
        '    permissions:\n      contents: read',
        '    permissions:\n      contents: write'
      ),
    (source) =>
      source.replace(
        '  workflow_call:\n    inputs:\n',
        '  workflow_call:\n    inputs:\n      unexpected:\n        type: string\n'
      ),
    (source) => source.replace('  changes:', '  changed:')
  ])('rejects an incompatible upstream interface or qualification shape', (change) => {
    expect(() => generateTemplateWorkflow(change(upstream), upstreamSha)).toThrow()
    expect(() => generateTemplateWorkflow(upstream, 'main')).toThrow('full upstream commit SHA')
  })

  it('binds the template to the exact candidate without publishing credentials', () => {
    expect(build.jobs['orcad-template']).toEqual({
      needs: 'candidate',
      permissions: { contents: 'read', actions: 'read' },
      uses: './.github/workflows/fork-orcad-template.yml',
      with: {
        ref: expression('needs.candidate.outputs.candidate_sha'),
        build_template: true,
        fast_runners: false
      }
    })
    const checks = template.jobs.persistence.steps.filter((step) =>
      step.uses?.startsWith('actions/checkout@')
    )
    expect(checks.every((step) => step.with.ref === expression('inputs.ref'))).toBe(true)
    const upload = template.jobs.desktop_template.steps.find(
      (step) => step.with?.name === 'orcad-template'
    )
    expect(upload.with['include-hidden-files']).toBe(true)
    expect(upload.with['if-no-files-found']).toBe('error')
  })

  it("requires this run's template before every desktop package and blocks finalization on failure", () => {
    const desktop = build.jobs.desktop
    expect(desktop.needs).toEqual(['candidate', 'orcad-template'])
    expect(desktop.env.ORCA_REQUIRE_ORCAD_TEMPLATE).toBe('1')
    const download = desktop.steps.findIndex((step) => step.with?.name === 'orcad-template')
    expect(desktop.steps[download]).toEqual({
      name: "Download this candidate's server template",
      uses: 'actions/download-artifact@v8',
      with: { name: 'orcad-template', path: 'out/orcad-template' }
    })
    const packages = desktop.steps.filter(
      (step) =>
        step.run?.includes('electron-builder') || step.with?.command?.includes('electron-builder')
    )
    expect(packages).toHaveLength(4)
    for (const step of packages) {
      expect(desktop.steps.indexOf(step)).toBeGreaterThan(download)
    }
    const verify = desktop.steps.findIndex(
      (step) => step.name === 'Verify packaged server template'
    )
    const stage = desktop.steps.findIndex((step) => step.name === 'Stage desktop release assets')
    expect(verify).toBeGreaterThan(Math.max(...packages.map((step) => desktop.steps.indexOf(step))))
    expect(verify).toBeLessThan(stage)
    expect(build.jobs.finalize.needs).toContain('orcad-template')
    expect(build.jobs.finalize.if).toBeUndefined()
    expect(desktop['continue-on-error']).toBeUndefined()
  })

  it('refreshes upstream sync, retains hotfix workflows, and registers maintenance paths', () => {
    const anchor = parse(syncText).jobs.prepare.steps.find(
      (step) => step.name === 'Create safe release anchor'
    )
    expect(anchor.run).toContain('fork-orcad-template-workflow.mjs --upstream="$TARGET_SHA"')
    expect(anchor.run.indexOf('--upstream="$TARGET_SHA"')).toBeLessThan(
      anchor.run.lastIndexOf('git add')
    )
    expect(anchor.run).toContain('.github/workflows/fork-orcad-template.yml')
    expect(parse(syncText).jobs['workflow-policy'].steps[1]?.run ?? syncText).toContain(
      'fork-orcad-template.yml'
    )
    expect(hotfixText).toContain('            .github/workflows\n')
    expect(hotfixText).not.toContain('fork-orcad-template-workflow.mjs --upstream=')
    for (const name of ['fork-orcad-template-workflow', 'verify-fork-orcad-template']) {
      for (const suffix of ['.mjs', '.test.mjs']) {
        const path = `.github/scripts/${name}${suffix}`
        for (const text of [syncText, hotfixText, read('./fork-maintenance-state.mjs')]) {
          expect(text).toContain(path)
        }
      }
    }
  })
})
