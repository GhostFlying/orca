import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITIES,
  AGENT_LAUNCH_TRAE_MODEL_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TRAE_OPAQUE_EFFORT_RUNTIME_CAPABILITY
} from '../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { agentLaunchFixture, agentLaunchHostFixture } from './agent-launch-test-fixtures'

const WORKTREE_ID = 'repo-1::/tmp/repo'
const ORIGINAL_EXIT_CODE = process.exitCode

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE
})

async function runRefused(argv: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await main(argv, '/tmp/repo')
  expect(process.exitCode).toBe(1)
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
}

function launchCalls(): unknown[][] {
  return callMock.mock.calls.filter(
    ([method]) =>
      method === 'agent.launchReplay' || method === 'agent.launch' || method === 'worktree.create'
  )
}

describe('orca cli agent launch', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each(['high', 'xhigh'])(
    'passes Trae model and %s effort without substitution',
    async (effort) => {
      queueFixtures(callMock, agentLaunchHostFixture(), agentLaunchFixture(WORKTREE_ID))
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await main(
        [
          'agent',
          'launch',
          '--agent',
          'trae',
          '--worktree',
          `id:${WORKTREE_ID}`,
          '--model',
          'gpt-6.1-sol',
          '--effort',
          effort,
          '--surface',
          'terminal',
          '--json'
        ],
        '/tmp/repo'
      )
      expect(callMock).toHaveBeenCalledWith(
        'agent.launchReplay',
        expect.objectContaining({
          agent: 'trae',
          sessionOptions: { model: 'gpt-6.1-sol', effort },
          surface: 'terminal'
        })
      )
    }
  )

  it('refuses Trae preferences on an older host before launching', async () => {
    queueFixtures(
      callMock,
      okFixture('status', {
        capabilities: AGENT_LAUNCH_RUNTIME_CAPABILITIES.filter(
          (capability) => capability !== AGENT_LAUNCH_TRAE_MODEL_RUNTIME_CAPABILITY
        )
      })
    )
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'trae',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--model',
      'gpt-6.1-sol',
      '--effort',
      'high',
      '--json'
    ])
    expect(JSON.parse(output).error.code).toBe('incompatible_runtime')
    expect(launchCalls()).toEqual([])
  })

  it('refuses opaque Trae effort on a host that would discard it', async () => {
    queueFixtures(
      callMock,
      okFixture('status', {
        capabilities: AGENT_LAUNCH_RUNTIME_CAPABILITIES.filter(
          (capability) => capability !== AGENT_LAUNCH_TRAE_OPAQUE_EFFORT_RUNTIME_CAPABILITY
        )
      })
    )
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'trae',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--model',
      'deepseek-v4.1-flash',
      '--effort',
      'high',
      '--json'
    ])
    expect(JSON.parse(output).error.code).toBe('incompatible_runtime')
    expect(launchCalls()).toEqual([])
  })

  it('passes opaque Trae effort to a host that applies it', async () => {
    queueFixtures(callMock, agentLaunchHostFixture(), agentLaunchFixture(WORKTREE_ID))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'agent',
        'launch',
        '--agent',
        'trae',
        '--worktree',
        `id:${WORKTREE_ID}`,
        '--model',
        'deepseek-v4.1-flash',
        '--effort',
        'high',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({
        agent: 'trae',
        sessionOptions: { model: 'deepseek-v4.1-flash', effort: 'high' }
      })
    )
  })

  it('retains known Trae effort support on the previous host capability', async () => {
    queueFixtures(
      callMock,
      okFixture('status', {
        capabilities: AGENT_LAUNCH_RUNTIME_CAPABILITIES.filter(
          (capability) => capability !== AGENT_LAUNCH_TRAE_OPAQUE_EFFORT_RUNTIME_CAPABILITY
        )
      }),
      agentLaunchFixture(WORKTREE_ID)
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'agent',
        'launch',
        '--agent',
        'trae',
        '--worktree',
        `id:${WORKTREE_ID}`,
        '--model',
        'gpt-6.1-sol',
        '--effort',
        'high',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({
        agent: 'trae',
        sessionOptions: { model: 'gpt-6.1-sol', effort: 'high' }
      })
    )
  })

  it('refuses an unadvertised Trae effort before contacting the host', async () => {
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'trae',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--model',
      'gpt-6.1-sol',
      '--effort',
      'ultra',
      '--json'
    ])
    expect(JSON.parse(output).error.code).toBe('invalid_argument')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('returns an exact recovery command and removes blind retry advice after a lost reply', async () => {
    queueFixtures(callMock, agentLaunchHostFixture())
    callMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'runtime_unavailable',
        'The Orca runtime closed the connection before responding. Restart Orca and try again.'
      )
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const args = [
      'agent',
      'launch',
      '--agent',
      'codex',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--prompt',
      'Fix it',
      '--json'
    ]
    await main(args, '/tmp/repo')
    const error = JSON.parse(String(logSpy.mock.calls[0]?.[0])).error
    expect(error.code).toBe('agent_session_operation_unknown')
    expect(error.data.retrySafe).toBe(true)
    expect(error.data.recoveryCommand).toEqual([
      expect.any(String),
      ...args,
      '--retry-launch',
      error.data.operationId
    ])
    expect(JSON.stringify(error)).not.toContain('Restart Orca and try again')
    expect(launchCalls()).toEqual([
      ['agent.launchReplay', expect.objectContaining({ operationId: error.data.operationId })]
    ])
  })

  it('keeps recovery identity when an older replacement host refuses a replay method', async () => {
    const operationId = `${Date.now()}-${'c'.repeat(32)}`
    queueFixtures(callMock, agentLaunchHostFixture())
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'refused',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'replacement' }
      })
    )
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'codex',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--retry-launch',
      operationId,
      '--json'
    ])
    const error = JSON.parse(output).error
    expect(error.code).toBe('agent_session_operation_unknown')
    expect(error.data.operationId).toBe(operationId)
    expect(error.data.nextSteps.join(' ')).toContain('never retry as a fresh launch')
    expect(launchCalls()).toEqual([
      ['agent.launchReplay', expect.objectContaining({ operationId })]
    ])
  })
})
