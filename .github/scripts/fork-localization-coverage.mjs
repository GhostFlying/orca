import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  collectLocalizationCandidates,
  isSkippedFile,
  main as auditLocalizationCoverage
} from '../../config/scripts/audit-localization-coverage.mjs'
import { inspectForkCandidate, isDirectExecution } from './fork-maintenance-state.mjs'

function signature({ filePath, kind, text, dynamic }) {
  return JSON.stringify({ filePath, kind, text, dynamic })
}

export function releaseLocalizationAllowlist(reports, allowlist) {
  const counts = new Map()
  for (const report of reports) {
    const key = signature(report)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const entry of allowlist) {
    const key = signature(entry)
    counts.set(key, Math.max(counts.get(key) ?? 0, entry.count))
  }
  return [...counts].map(([key, count]) => ({ ...JSON.parse(key), count }))
}

export async function main(root = process.cwd()) {
  const candidate = inspectForkCandidate({ candidateRef: 'HEAD', cwd: root })
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const sourceRoot = 'src/renderer/src'
  const files = git('ls-tree', '-r', '--name-only', '-z', candidate.upstreamSha, '--', sourceRoot)
    .split('\0')
    .filter(
      (file) =>
        /\.(?:ts|tsx|js|jsx|mts|cts)$/.test(file) && !isSkippedFile(root, resolve(root, file))
    )
  const sources = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: files.map((file) => `${candidate.upstreamSha}:${file}\n`).join(''),
    maxBuffer: 64 * 1024 * 1024
  })
  let offset = 0
  const reports = files.flatMap((file) => {
    const end = sources.indexOf('\n', offset)
    const header = sources.subarray(offset, end).toString().match(/^[0-9a-f]{40} blob (\d+)$/)
    if (!header) {
      throw new Error(`Could not read Release source: ${file}`)
    }
    const size = Number(header[1])
    const source = sources.subarray(end + 1, end + 1 + size).toString()
    offset = end + size + 2
    return collectLocalizationCandidates(resolve(root, file), source, root)
  })
  const allowlist = JSON.parse(
    git('show', `${candidate.upstreamSha}:config/localization-coverage-allowlist.json`)
  )
  const scratch = await mkdtemp(join(tmpdir(), 'orca-fork-localization-'))
  try {
    const path = join(scratch, 'release-allowlist.json')
    await writeFile(path, JSON.stringify(releaseLocalizationAllowlist(reports, allowlist)))
    console.log(`Localization baseline: ${candidate.upstreamTag} at ${candidate.upstreamSha}.`)
    return await auditLocalizationCoverage(root, ['--check', '--allowlist', path])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}
