import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'

function capture(name: string): string {
  return readFileSync(join(__dirname, '../main/runtime/__fixtures__', `traex-${name}.txt`), 'utf8')
}

describe('TraeX native startup composer', () => {
  it.each([
    'footer-empty',
    'narrow-36',
    'noanim-empty',
    'noanim-narrow',
    'width20',
    'width24',
    'readonly80',
    'width20-noanim',
    'readonly-noanim'
  ])('accepts the final footer in the %s layout', (name) => {
    const data = capture(name)
    const scanner = createDraftPasteReadyScanner('trae-composer-prompt')
    let firstReady = -1
    for (let offset = 0; offset < data.length; offset++) {
      const result = scanner.observe(data[offset])
      if (result.ready && firstReady === -1) {
        firstReady = offset
      }
    }
    expect(firstReady).toBeGreaterThan(data.indexOf('\x1b]0;'))
    expect(createDraftPasteReadyScanner('trae-composer-prompt').observe(data).ready).toBe(true)
  })
  it('ignores the provisional inline composer and becomes ready at the final footer frame', () => {
    const data = capture('plain-exact')
    const scanner = createDraftPasteReadyScanner('trae-composer-prompt')
    let firstReady = -1
    for (let offset = 0; offset < data.length; offset++) {
      const result = scanner.observe(data[offset])
      if (result.ready && firstReady === -1) {
        firstReady = offset
      }
    }
    expect(firstReady).toBeGreaterThan(data.indexOf('Context'))
    expect(firstReady).toBeLessThan(data.lastIndexOf('\x1b[?2026h'))
  })

  it('never treats the preliminary composer or subsequent trust menu as ready', () => {
    const scanner = createDraftPasteReadyScanner('trae-composer-prompt')
    const data = capture('plain-parent')
    expect(data).toContain('Do you trust the contents')
    expect(data).toContain('❯')
    for (const character of data) {
      expect(scanner.observe(character)).toMatchObject({ ready: false })
    }
  })

  it('revokes a completed frame when bracketed paste closes', () => {
    const scanner = createDraftPasteReadyScanner('trae-composer-prompt')
    expect(scanner.observe(capture('plain-exact')).ready).toBe(true)
    expect(scanner.observe('\x1b[?2004l❯ shell').ready).toBe(false)
  })
})
