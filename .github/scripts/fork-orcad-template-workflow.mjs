import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const TEMPLATE_WORKFLOW_PATH = '.github/workflows/fork-orcad-template.yml'
const UPSTREAM_WORKFLOW_PATH = '.github/workflows/node-server-tests.yml'

function hasReadOnlyPermissions(source) {
  if (!/^permissions:\n  contents: read\n(?=\n)/m.test(source)) {
    return false
  }
  for (const match of source.matchAll(/^    permissions:(.*)$/gm)) {
    if (match[1] !== '') {
      return false
    }
    const body = source.slice(match.index + match[0].length + 1)
    const block = /^((?: {6}[^\n]+\n)+)/.exec(body)?.[1]
    if (!/^contents: read(?:\n {6}actions: read)?$/.test(block?.trim() ?? '')) {
      return false
    }
  }
  return true
}

export function generateTemplateWorkflow(source, upstreamSha) {
  if (!/^[a-f0-9]{40}$/.test(upstreamSha)) {
    throw new Error('Template workflow source must be a full upstream commit SHA')
  }
  const triggers = /^on:\n[\s\S]*?(?=^\S)/m.exec(source)
  const call = triggers?.[0].match(/^  workflow_call:\n(?:^ {4}.*\n|^\s*\n)*/m)?.[0]
  const inputNames = call
    ? [...call.matchAll(/^      ([a-z_]+):$/gm)].map((match) => match[1]).join(',')
    : ''
  if (
    !call ||
    !['ref,build_template', 'ref,build_template,fast_runners'].includes(inputNames) ||
    /^    secrets:/m.test(call) ||
    !/^      ref:\n(?:^ {8}.*\n)*?^        type: string$/m.test(call) ||
    !/^      build_template:\n(?:^ {8}.*\n)*?^        type: boolean$/m.test(call) ||
    (inputNames.includes('fast_runners') &&
      !/^      fast_runners:\n(?:^ {8}.*\n)*?^        type: boolean$/m.test(call))
  ) {
    throw new Error('Upstream template workflow_call interface changed; inspect before adapting')
  }
  if (!hasReadOnlyPermissions(source)) {
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
