import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../codex/config-toml-line-scan'

function lineEnd(content: string, offset: number): number {
  const next = content.indexOf('\n', offset)
  return next === -1 ? content.length : next + 1
}

export function isTraeHooksFeatureEnabled(content: string): boolean {
  let inFeatures = false
  let state = createTomlLineScanState()
  for (let offset = 0; offset < content.length;) {
    const end = lineEnd(content, offset)
    const line = content.slice(offset, end).replace(/\r?\n$/, '')
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)?.replace(/\s+/g, '')
      if (header) {
        inFeatures = header === '[features]'
      } else if (inFeatures && /^[ \t]*hooks[ \t]*=[ \t]*true[ \t]*(?:#.*)?$/.test(line)) {
        return true
      }
    }
    state = updateTomlLineScanState(state, line)
    offset = end
  }
  return false
}

export function enableTraeHooksFeatureInContent(content: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  let inFeatures = false
  let featuresHeaderEnd = -1
  let featuresEnd = content.length
  let state = createTomlLineScanState()

  for (let offset = 0; offset < content.length;) {
    const end = lineEnd(content, offset)
    const rawLine = content.slice(offset, end)
    const line = rawLine.replace(/\r?\n$/, '')
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)?.replace(/\s+/g, '')
      if (header) {
        if (inFeatures) {
          featuresEnd = offset
          break
        }
        inFeatures = header === '[features]'
        if (inFeatures) {
          featuresHeaderEnd = end
        }
      } else if (inFeatures) {
        const match = /^([ \t]*hooks[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?)(\r?\n)?$/.exec(
          rawLine
        )
        if (match) {
          return match[2] === 'true'
            ? content
            : `${content.slice(0, offset)}${match[1]}true${match[3]}${match[4] ?? ''}${content.slice(end)}`
        }
      }
    }
    state = updateTomlLineScanState(state, line)
    offset = end
  }

  if (featuresHeaderEnd !== -1) {
    const insertion =
      featuresEnd === content.length && content.length > 0 && !content.endsWith(eol)
        ? `${eol}hooks = true${eol}`
        : `hooks = true${eol}`
    return `${content.slice(0, featuresEnd)}${insertion}${content.slice(featuresEnd)}`
  }
  const separator =
    content.length === 0
      ? ''
      : content.endsWith(`${eol}${eol}`)
        ? ''
        : content.endsWith(eol)
          ? eol
          : `${eol}${eol}`
  return `${content}${separator}[features]${eol}hooks = true${eol}`
}
