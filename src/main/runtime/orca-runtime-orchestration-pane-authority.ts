import { createHash } from 'node:crypto'
import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import type {
  OrchestrationCompatibilityTerminalAuthority,
  TerminalHandleRecord
} from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { resolveStructuredWorkerAuthority } from './structured-worker-authority'
import { OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller } from './orca-runtime-verify-orchestration-compatibility-caller'

export class OrcaRuntimeWithOrchestrationPaneAuthority extends OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller {
  // Declared, not defined: these implementations live further up the runtime mixin chain.
  declare protected getLeavesForPty: (ptyId: string) => RuntimeLeafRecord[]
  declare protected getExistingTerminalHandlesForPtyId: (ptyId: string) => string[]
  declare protected makeRuntimePaneKey: (leaf: RuntimeLeafRecord) => string
  declare protected getOrchestrationDbIfAvailable: () => OrchestrationDb | null
  declare protected getLivePtyForHandle: (
    handle: string
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  declare getTerminalProcessIncarnation: (handle: string) => string | null

  /** Every pane key this PTY could be addressed by, including restored receipts. */
  protected collectPaneKeysForPty(ptyId: string): Set<string> {
    const paneKeys = new Set<string>()
    const pty = this.ptysById.get(ptyId)
    if (pty?.paneKey && parsePaneKey(pty.paneKey)) {
      paneKeys.add(pty.paneKey)
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (receipt?.paneKey && parsePaneKey(receipt.paneKey)) {
      paneKeys.add(receipt.paneKey)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (isValidTerminalTabId(leaf.tabId) && isTerminalLeafId(leaf.leafId)) {
        paneKeys.add(makePaneKey(leaf.tabId, leaf.leafId))
      }
    }
    return paneKeys
  }

  /** Status cleanup also owns runtime-admitted legacy OSC rows; orchestration authority does not. */
  protected collectAgentStatusPaneKeysForPty(ptyId: string): Set<string> {
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    const terminalHandles = new Set(this.getExistingTerminalHandlesForPtyId(ptyId))
    // The provider-session snapshot is the unfiltered store view, so certified exit can also
    // retire a dismissed row's identity-only remnant after its pane binding moved.
    for (const row of this.getAgentProviderSessionSnapshotFn?.() ?? []) {
      if (row.terminalHandle && terminalHandles.has(row.terminalHandle)) {
        paneKeys.add(row.paneKey)
      }
    }
    const ptyPaneKey = this.ptysById.get(ptyId)?.paneKey
    if (ptyPaneKey && parseLegacyNumericPaneKey(ptyPaneKey)) {
      paneKeys.add(ptyPaneKey)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const paneKey = this.makeRuntimePaneKey(leaf)
      if (parseLegacyNumericPaneKey(paneKey)) {
        paneKeys.add(paneKey)
      }
    }
    return paneKeys
  }

  getOrchestrationDispatchAuthority(
    terminalHandle: string
  ): OrchestrationCompatibilityTerminalAuthority | null {
    const structured = resolveStructuredWorkerAuthority(
      terminalHandle,
      this.getOrchestrationDbIfAvailable?.() ?? null
    )
    if (structured) {
      return {
        runtimeId: this.runtimeId,
        terminalHandle,
        // Both EMPTY on purpose. `verifyOrchestrationCompatibilityCaller` falls back to the
        // restored-authority receipt keyed by ptyId when there is no launch token, so filling
        // either of these in would silently open hook attestation to a session that has no PTY,
        // no launch secret, and no hook to attest with.
        ptyId: '',
        worktreeId: structured.identity.worktreeId,
        processIncarnation: structured.identity.processIncarnation,
        paneKey: structured.identity.paneKey,
        launchTokenHash: null,
        hostScope: structured.identity.hostScope
      }
    }
    let ptyId: string | null
    try {
      ptyId =
        this.getLivePtyForHandle(terminalHandle)?.pty.ptyId ??
        this.resolveLiveLeafForHandle(terminalHandle)?.ptyId ??
        null
    } catch {
      return null
    }
    if (!ptyId) {
      return null
    }
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected) {
      return null
    }
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    if (!hostScope) {
      return null
    }
    return {
      runtimeId: this.runtimeId,
      terminalHandle,
      ptyId,
      worktreeId: pty.worktreeId,
      processIncarnation: this.getTerminalProcessIncarnation(terminalHandle),
      paneKey: pty.paneKey,
      launchTokenHash: pty.launchToken
        ? createHash('sha256').update(pty.launchToken).digest('hex')
        : null,
      hostScope
    }
  }

  protected retirePtyAgentLaunchAuthority(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return
    }
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (!pty.launchToken && !receipt && !pty.launchAgent) {
      return
    }
    // Why: collect before the delete below, which drops the restored-authority receipt a
    // receipt-only pane's key comes from.
    const paneKeys = this.collectPaneKeysForPty(ptyId)
    this.restoredOrchestrationAuthorityByPtyId.delete(ptyId)
    pty.launchToken = null
    pty.launchIncarnationId = null
    pty.launchAgent = null
    for (const paneKey of paneKeys) {
      this.retireAgentHookCompatibilityAuthorityFn?.(paneKey)
    }
  }
}
