import { createTerminalEscapeScanner } from './terminal-escape-scanner'

/** The fullscreen loading frame has a composer too; only the live chat paints its footer. */
export function createCodexComposerReadyScanner({
  promptGlyph = '›',
  requireFooter = false
}: { promptGlyph?: '›' | '❯'; requireFooter?: boolean } = {}): {
  observe: (data: string) => { ready: boolean }
} {
  let bracketedPaste = false
  let altScreen = false
  let leftAltScreen = false
  let synchronized = false
  let sawSynchronizedFrame = false
  let promptSeen = false
  let promptRow: number | null = null
  let footerRow: number | null = null
  let hintRow: number | null = null
  let permissionHintRow: number | null = null
  let textRow: number | null = null
  let textTail = ''
  let row: number | null = null
  let savedRow: number | null = null
  let cursorShown = false
  const paintedRows = new Set<number>()

  const resetLayout = (): void => {
    promptSeen = false
    promptRow = null
    footerRow = null
    hintRow = null
    permissionHintRow = null
    textRow = null
    textTail = ''
    row = null
    savedRow = null
    cursorShown = false
    paintedRows.clear()
  }
  const scanner = createTerminalEscapeScanner({
    onCsi: (privateMarker, params, final) => {
      if (privateMarker === '?' && (final === 'h' || final === 'l')) {
        const set = final === 'h'
        for (const mode of params.split(';')) {
          if (mode === '2004') {
            bracketedPaste = set
            if (!set) {
              resetLayout()
            }
          } else if (mode === '1049') {
            altScreen = set
            leftAltScreen = !set
            resetLayout()
          } else if (mode === '2026') {
            synchronized = set
            sawSynchronizedFrame = true
          } else if (mode === '25') {
            cursorShown = set
          }
        }
      } else if (final === 'H' || final === 'f') {
        row = Math.max(1, Number(params.split(';')[0] || '1'))
      } else if (final === 'J' && params === '2') {
        resetLayout()
      }
    },
    onEscape: (final) => {
      // TraeX animates its logo with DECSC/DECRC while leaving the composer cursor in place.
      if (requireFooter && final === '7') {
        savedRow = row
      }
      if (requireFooter && final === '8') {
        row = savedRow
      }
    },
    onText: (text) => {
      for (const char of text) {
        if (requireFooter && row !== null && promptRow !== null && row > promptRow) {
          if (textRow !== row) {
            textRow = row
            textTail = ''
          }
          textTail = (textTail + char).slice(-9)
          if (textTail === 'shift+tab') {
            permissionHintRow = row
          }
        }
        if (row !== null && !/\s/.test(char) && paintedRows.size < 128) {
          paintedRows.add(row)
        }
        if (char === '\n' && row !== null) {
          row += 1
        } else if (char === promptGlyph && (bracketedPaste || altScreen)) {
          promptSeen = true
          promptRow = row
        } else if (char === '·' && promptRow !== null && row !== null && row > promptRow) {
          footerRow = row
        } else if (char === '?' && promptRow !== null && row !== null && row > promptRow) {
          hintRow = Math.max(hintRow ?? row, row)
        }
      }
    }
  })

  return {
    observe: (data) => {
      scanner.observe(data)
      const liveFullscreenComposer =
        (altScreen || requireFooter) &&
        !synchronized &&
        cursorShown &&
        promptRow !== null &&
        row !== null &&
        row >= promptRow &&
        (requireFooter
          ? // Status plus a painted footer also covers truncated hints and read-only mode.
            (permissionHintRow !== null && row < permissionHintRow) ||
            (footerRow !== null &&
              footerRow > promptRow + 1 &&
              row < footerRow &&
              paintedRows.has(footerRow + 1))
          : hintRow !== null &&
            // Single-item status lines have no separator; their reserved row is below the input padding.
            ((footerRow !== null && footerRow === hintRow - 1 && row < footerRow) ||
              (row + 2 < hintRow && paintedRows.has(hintRow - 1))))
      // Older inline builds do not paint synchronized fullscreen frames.
      const legacyComposer =
        !requireFooter && promptSeen && !leftAltScreen && (!altScreen || !sawSynchronizedFrame)
      return {
        ready: bracketedPaste && (liveFullscreenComposer || legacyComposer)
      }
    }
  }
}
