import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const TEMPLATE_WORKFLOW_PATH = '.github/workflows/fork-orcad-template.yml'
const UPSTREAM_WORKFLOW_PATH = '.github/workflows/node-server-tests.yml'

export function generateTemplateWorkflow(source, upstreamSha) {
  if (!/^[a-f0-9]{40}$/.test(upstreamSha)) {
    throw new Error('Template workflow source must be a full upstream commit SHA')
  }
  const triggers = /^on:\n[\s\S]*?(?=^\S)/m.exec(source)
  const call = triggers?.[0].match(/^  workflow_call:\n(?:^ {4}.*\n|^\s*\n)*/m)?.[0]
  if (
    !call ||
    [...call.matchAll(/^      ([a-z_]+):$/gm)].map((match) => match[1]).join(',') !==
      'ref,build_template' ||
    /^    secrets:/m.test(call) ||
    !/^      ref:\n(?:^ {8}.*\n)*?^        type: string$/m.test(call) ||
    !/^      build_template:\n(?:^ {8}.*\n)*?^        type: boolean$/m.test(call)
  ) {
    throw new Error('Upstream template workflow_call interface changed; inspect before adapting')
  }
  if (!/^permissions:\n  contents: read\n(?=\n)/m.test(source) || /^    permissions:/m.test(source)) {
    throw new Error('Upstream template workflow must use read-only contents permission')
  }
  // A maintenance-only push must not let change detection skip release qualification.
  const changes = /^  changes:\n    if: >-\n((?:^ {6}.+\n)+)/m.exec(source)
  if (!changes || changes[1].includes('${{')) {
    throw new Error('Upstream change-detection condition changed; inspect before adapting')
  }
  const condition = changes[1].trim().replace(/\s*\n\s*/g, ' ')
  const qualified = source.replace(
    changes[0],
    `  changes:\n    if: >-\n      \${{ !inputs.build_template && (${condition}) }}\n`
  )
  const generated = qualified.replace(triggers[0], `on:\n${call}\n`)
  return `# Generated from ${upstreamSha}:${UPSTREAM_WORKFLOW_PATH}.
# Regenerate with .github/scripts/fork-orcad-template-workflow.mjs; do not edit.
${generated}`
}

export function templateWorkflowAt(upstreamSha, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(upstreamSha)) {
    throw new Error('Template workflow source must be a full upstream commit SHA')
  }
  const source = execFileSync('git', ['show', `${upstreamSha}:${UPSTREAM_WORKFLOW_PATH}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return generateTemplateWorkflow(source, upstreamSha)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const upstream = process.argv.find((arg) => arg.startsWith('--upstream='))?.slice(11)
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  const generated = templateWorkflowAt(upstream)
  const destination = output ?? TEMPLATE_WORKFLOW_PATH
  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== generated) {
      throw new Error('Fork template workflow differs from its selected upstream Release')
    }
  } else {
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, generated)
  }
}
