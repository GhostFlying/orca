import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { makePaneKey } from '../../shared/stable-pane-id'
import { committingSpawn } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const TAB_ID = 'ask-tab'
export const WORKTREE_ID = 'wt-1'
export const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
export const PTY_ID = 'pty-ask'

export async function createRuntimeWithHookRows(
  rows: AgentStatusIpcPayload[],
  /** Pass a store to exercise the OSC producer; otherwise the rows stand in for it. */
  statusWiring?: ReturnType<typeof makeAgentStatusStoreWiring>
): Promise<OrcaRuntimeService> {
  const readRows = statusWiring
    ? (): AgentStatusIpcPayload[] => [...rows, ...statusWiring.deps.getAgentStatusSnapshot()]
    : (): AgentStatusIpcPayload[] => rows
  // Switch-on, main's layout answers which pane holds the PTY, so the runtime needs a store.
  const store = ORCA_LAYOUT_OWNER_IS_MAIN
    ? partialRuntimeStore({
        getRepos: () => [],
        getRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getProjects: () => [],
        getSettings: () => ({})
      })
    : null
  const runtime = new OrcaRuntimeService(store, undefined, {
    ...(statusWiring
      ? {
          onTerminalAgentStatus: statusWiring.deps.onTerminalAgentStatus,
          reconcileAgentStatusForEndedProcess:
            statusWiring.deps.reconcileAgentStatusForEndedProcess,
          getAgentProviderSessionSnapshot: statusWiring.deps.getAgentProviderSessionSnapshot,
          getAgentProviderSessionRowsForPane: statusWiring.deps.getAgentProviderSessionRowsForPane
        }
      : {}),
    getAgentStatusSnapshot: readRows,
    ...(statusWiring ? {} : { getAgentProviderSessionRowsForPane: readRows })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture overrides only this runtime launch-scope method.
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn(committingSpawn(runtime, async () => ({ id: PTY_ID }))),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    title: 'Terminal'
  })
  return runtime
}
