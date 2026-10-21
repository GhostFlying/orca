import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationService } from '../automations/service'
import { createRuntimeAutomationRunTerminalObserver } from '../automations/runtime-terminal-run-observer'
import { closeTestStores, createStore, makeRepo, testState } from '../persistence-test-harness'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir }
}))

const TAB_ID = 'trae-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'trae-pty'
const WORKSPACE_ID = 'r1::/repo'

function hookRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    agentType: 'trae',
    prompt: '',
    state: 'done',
    mainAgent: { state: 'done', stateStartedAt: now },
    receivedAt: now,
    stateStartedAt: now,
    ...overrides
  }
}

async function headlessPane(rows: AgentStatusIpcPayload[]) {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => rows,
    getAgentProviderSessionRowsForPane: (paneKey) => rows.filter((row) => row.paneKey === paneKey)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the existing launch-scope lookup is replaced; terminal waits run through the real runtime.
  const launchScope = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(launchScope, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKSPACE_ID,
    path: '/repo',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'trae-incarnation' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'traecli'
  })
  const terminal = await runtime.createTerminal(`id:${WORKSPACE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'trae',
    title: 'Terminal'
  })
  return { runtime, terminal }
}

describe('Trae automation completion without a renderer', () => {
  let service: AutomationService | undefined

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-trae-completion-'))
  })

  afterEach(async () => {
    service?.stop()
    service = undefined
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('completes a dispatched run from its Stop hook while the terminal remains live', async () => {
    const rows: AgentStatusIpcPayload[] = []
    const { runtime, terminal } = await headlessPane(rows)
    const store = createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Trae check',
      prompt: 'Check the repo',
      agentId: 'trae',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: WORKSPACE_ID,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now()
    })
    service = new AutomationService(store, {
      headlessDispatcher: async () => ({
        workspaceId: WORKSPACE_ID,
        terminalSessionId: TAB_ID,
        terminalPaneKey: PANE_KEY,
        terminalPtyId: PTY_ID
      }),
      terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime, {
        getAgentStatusRowsForPane: (paneKey) => runtime.getAgentStatusRowsForPane(paneKey),
        agentCommandsForRun: () => ['traecli']
      })
    })
    const run = await service.runNow(automation.id)
    expect(run.status).toBe('dispatched')
    rows.push(hookRow())
    runtime.onPtyData(PTY_ID, 'Task complete.\r\n', Date.now())

    await vi.waitFor(
      () => {
        expect(
          store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
        ).toMatchObject({
          status: 'completed',
          error: null
        })
      },
      { timeout: 5000 }
    )
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.objectContaining({ handle: terminal.handle, ptyId: PTY_ID })
    ])
  })

  it.each([
    [
      'working',
      () =>
        hookRow({ state: 'working', mainAgent: { state: 'working', stateStartedAt: Date.now() } })
    ],
    [
      'child completion',
      () => hookRow({ mainAgent: { state: 'working', stateStartedAt: Date.now() } })
    ],
    ['session start', () => hookRow({ sessionBoundary: true })],
    ['identity refresh', () => hookRow({ providerSessionOnly: true })],
    ['unconfirmed restore', () => hookRow({ restoredUnconfirmed: true })],
    ['another agent', () => hookRow({ agentType: 'codex' })],
    ['another pane', () => hookRow({ paneKey: 'another-tab:another-leaf' })],
    [
      'stale completion',
      () => hookRow({ receivedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1 })
    ]
  ] as const)('does not finish from %s', async (_name, makeRow) => {
    const { runtime, terminal } = await headlessPane([makeRow()])
    await expect(
      runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 40
      })
    ).rejects.toThrow('timeout')
  })

  it('keeps a permission wait from completing the run', async () => {
    const { runtime, terminal } = await headlessPane([
      hookRow({ state: 'waiting', mainAgent: { state: 'waiting', stateStartedAt: Date.now() } })
    ])
    const result = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 40
    })
    await expect(
      result.then(
        (value) => value.satisfied,
        () => false
      )
    ).resolves.toBe(false)
  })
})
