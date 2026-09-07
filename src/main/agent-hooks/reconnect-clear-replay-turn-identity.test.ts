import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { GOOD_PANE, PANE } from './server.test-fixtures'

const CONNECTION = 'ssh-target'
const T0 = 1_800_000_000_000

type RelayEnvelope = Omit<AgentHookEventPayload, 'connectionId'>

function doneEnvelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return {
    paneKey: PANE,
    source: 'claude',
    launchToken: 'launch-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    hasExplicitPrompt: true,
    promptInteractionKey: 'turn-1',
    hookEventName: 'Stop',
    providerPromptId: 'prompt-1',
    toolUseId: 'tool-1',
    providerSession: { key: 'session_id', id: 'session-1' },
    payload: {
      state: 'done',
      prompt: 'finish the task',
      agentType: 'claude',
      turnCompletedAt: T0 - 100
    },
    ...overrides
  }
}

function current(server: AgentHookServer, paneKey = PANE) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)!
}

describe('reconnect clear and relay replay turn identity', () => {
  let server: AgentHookServer

  beforeEach(() => {
    _internals.resetCachesForTests()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    server = new AgentHookServer()
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reclaims the cleared turn timestamp while advancing delivery time', () => {
    const envelope = doneEnvelope()
    server.ingestRemote(envelope, CONNECTION)
    const baseline = current(server)

    vi.setSystemTime(T0 + 5_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    server.ingestRemote({ ...envelope, isReplay: true }, CONNECTION)

    expect(current(server)).toMatchObject({
      stateStartedAt: baseline.stateStartedAt,
      receivedAt: T0 + 5_001
    })
  })

  it('keeps one completion identity through repeated reconnect replays', () => {
    const envelope = doneEnvelope()
    server.ingestRemote(envelope, CONNECTION)
    const baselineStateStartedAt = current(server).stateStartedAt

    for (let reconnect = 1; reconnect <= 12; reconnect += 1) {
      vi.setSystemTime(T0 + reconnect * 5_000)
      server.clearStatusEntriesForConnection(CONNECTION)
      server.ingestRemote({ ...envelope, isReplay: true }, CONNECTION)
      expect(current(server).stateStartedAt).toBe(baselineStateStartedAt)
    }
  })

  it('gives a completion first observed after disconnect a new identity', () => {
    server.ingestRemote(doneEnvelope(), CONNECTION)
    const baselineStateStartedAt = current(server).stateStartedAt

    vi.setSystemTime(T0 + 5_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    server.ingestRemote(
      doneEnvelope({
        isReplay: true,
        promptInteractionKey: 'turn-2',
        providerPromptId: 'prompt-2',
        payload: {
          state: 'done',
          prompt: 'finish the task',
          agentType: 'claude',
          turnCompletedAt: T0 + 4_000
        }
      }),
      CONNECTION
    )

    expect(current(server).stateStartedAt).toBe(T0 + 5_001)
    expect(current(server).stateStartedAt).not.toBe(baselineStateStartedAt)
  })

  it.each(['waiting', 'blocked'] as const)(
    'gives a %s status first observed after disconnect a new identity',
    (state) => {
      server.ingestRemote(doneEnvelope(), CONNECTION)
      const baselineStateStartedAt = current(server).stateStartedAt

      vi.setSystemTime(T0 + 5_000)
      server.clearStatusEntriesForConnection(CONNECTION)
      server.ingestRemote(
        doneEnvelope({
          isReplay: true,
          promptInteractionKey: 'turn-2',
          providerPromptId: 'prompt-2',
          toolUseId: 'tool-2',
          payload: {
            state,
            prompt: 'approve the action',
            agentType: 'claude'
          }
        }),
        CONNECTION
      )

      expect(current(server)).toMatchObject({ state, stateStartedAt: T0 + 5_001 })
      expect(current(server).stateStartedAt).not.toBe(baselineStateStartedAt)
    }
  )

  it.each([
    ['connection', doneEnvelope({ isReplay: true }), 'other-connection'],
    ['source', doneEnvelope({ isReplay: true, source: 'codex' }), CONNECTION],
    ['launch', doneEnvelope({ isReplay: true, launchToken: 'launch-2' }), CONNECTION],
    [
      'provider session',
      doneEnvelope({
        isReplay: true,
        providerSession: { key: 'session_id', id: 'session-2' }
      }),
      CONNECTION
    ],
    ['tool use', doneEnvelope({ isReplay: true, toolUseId: 'tool-2' }), CONNECTION]
  ])('does not reclaim when the %s identity changes', (_label, replay, connectionId) => {
    server.ingestRemote(doneEnvelope(), CONNECTION)
    const baselineStateStartedAt = current(server).stateStartedAt

    vi.setSystemTime(T0 + 5_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    server.ingestRemote(replay, connectionId)

    const replacement = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
    // A conflicting launch can be fenced entirely; any accepted replacement must be a new turn.
    expect(replacement?.stateStartedAt).not.toBe(baselineStateStartedAt)
  })

  it('does not let a live event reclaim a cleared replay identity', () => {
    const envelope = doneEnvelope()
    server.ingestRemote(envelope, CONNECTION)

    vi.setSystemTime(T0 + 5_000)
    server.clearStatusEntriesForConnection(CONNECTION)
    server.ingestRemote(envelope, CONNECTION)

    expect(current(server).stateStartedAt).toBe(T0 + 5_001)
  })

  it('forgets the cleared identity on genuine pane teardown', () => {
    const envelope = doneEnvelope()
    server.ingestRemote(envelope, CONNECTION)
    server.clearStatusEntriesForConnection(CONNECTION)
    server.clearPaneState(PANE)

    vi.setSystemTime(T0 + 5_000)
    server.ingestRemote({ ...envelope, isReplay: true }, CONNECTION)

    expect(current(server).stateStartedAt).toBe(T0 + 5_000)
  })

  it('moves the cleared identity with pane authority', () => {
    const envelope = doneEnvelope()
    server.ingestRemote(envelope, CONNECTION)
    const baselineStateStartedAt = current(server).stateStartedAt
    server.clearStatusEntriesForConnection(CONNECTION)
    server.transferPaneAuthority(PANE, GOOD_PANE, 'pty-1')

    vi.setSystemTime(T0 + 5_000)
    server.ingestRemote({ ...envelope, isReplay: true }, CONNECTION)

    expect(current(server, GOOD_PANE).stateStartedAt).toBe(baselineStateStartedAt)
  })
})
