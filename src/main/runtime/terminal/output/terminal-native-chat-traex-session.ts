import { OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller } from '../../orchestration/terminal-authority/verify-orchestration-compatibility-caller'

export abstract class OrcaRuntimeWithNativeChatTraexSession extends OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller {
  resolveNativeChatTraexSession(
    handle: string,
    worktreeId: string,
    sessionId: string
  ): { transcriptPath?: string; connectionId: string | null } | null {
    const ptyId = this.resolveLeafForHandle(handle)?.ptyId
    const terminal = ptyId ? this.ptysById.get(ptyId) : null
    const paneKey = this.getTerminalPaneKey(handle)
    if (!terminal || terminal.worktreeId !== worktreeId || !paneKey) {
      return null
    }
    const rows =
      this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ??
      (this.getAgentProviderSessionSnapshotFn?.() ?? []).filter((row) => row.paneKey === paneKey)
    const match = rows
      .filter(
        (row) =>
          row.agentType === 'traex' &&
          row.providerSession?.id === sessionId &&
          row.connectionId === terminal.connectionId
      )
      .reduce<(typeof rows)[number] | undefined>(
        (latest, row) => (!latest || row.receivedAt > latest.receivedAt ? row : latest),
        undefined
      )
    if (!match?.providerSession) {
      return null
    }
    return {
      connectionId: terminal.connectionId,
      ...(match.providerSession.transcriptPath
        ? { transcriptPath: match.providerSession.transcriptPath }
        : {})
    }
  }
}
