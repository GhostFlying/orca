import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { decideHostServer } from './ssh-host-server-connect'

const {
  mockSshStore,
  mockConnectionManager,
  mockDeployAndLaunchRelay,
  mockRegisterSshGitProvider
} = mocks

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Server',
  host: 'example.com',
  port: 22,
  username: 'deploy'
}

function prepareConnectedTarget(nextTarget: SshTarget = target): void {
  mockSshStore.getTarget.mockReturnValue(nextTarget)
  mockConnectionManager.connect.mockResolvedValue({})
  mockConnectionManager.getState.mockReturnValue({
    targetId: nextTarget.id,
    status: 'connected',
    error: null,
    reconnectAttempt: 0
  })
}

describe('SSH connect policy', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow, relayBuildId } = harness

  beforeEach(harness.reset)

  it('throws for an unknown target', async () => {
    mockSshStore.getTarget.mockReturnValue(undefined)

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'unknown' })).rejects.toThrow(
      'SSH target "unknown" not found'
    )
  })

  it('uses the interactive policy by default', async () => {
    prepareConnectedTarget()

    await handlers.get('ssh:connect')!(null, { targetId: target.id })

    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target, {
      automatic: false,
      nonInteractive: false
    })
  })

  it('opens the server decision transport with the non-interactive policy', async () => {
    prepareConnectedTarget()

    await handlers.get('ssh:connect')!(null, {
      targetId: target.id,
      automatic: true,
      nonInteractive: true
    })

    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target, {
      automatic: true,
      nonInteractive: true
    })
    expect(decideHostServer).toHaveBeenCalledWith(target)
  })

  it('shares concurrent non-interactive connects for one target', async () => {
    const connection = Promise.withResolvers<object>()
    prepareConnectedTarget()
    mockConnectionManager.connect.mockReturnValue(connection.promise)

    const first = Promise.resolve(
      handlers.get('ssh:connect')!(null, { targetId: target.id, nonInteractive: true })
    )
    const second = Promise.resolve(
      handlers.get('ssh:connect')!(null, { targetId: target.id, nonInteractive: true })
    )
    connection.resolve({})

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(2)
    expect(mockConnectionManager.connect).toHaveBeenNthCalledWith(1, target, {
      automatic: false,
      nonInteractive: true
    })
    expect(mockConnectionManager.connect).toHaveBeenNthCalledWith(2, target, {
      automatic: false,
      nonInteractive: true
    })
  })

  it('does not join an interactive connect from a non-interactive caller', async () => {
    const decision = Promise.withResolvers<null>()
    prepareConnectedTarget()
    vi.mocked(decideHostServer).mockReturnValueOnce(decision.promise)

    const interactive = Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: target.id }))

    await expect(
      handlers.get('ssh:connect')!(null, { targetId: target.id, nonInteractive: true })
    ).rejects.toThrow('interactive SSH connection attempt is already in progress')
    decision.resolve(null)
    await expect(interactive).resolves.toEqual(expect.objectContaining({ status: 'connected' }))
  })

  it('retries interactively after a concurrent non-interactive transport fails', async () => {
    const nonInteractive = Promise.withResolvers<object>()
    prepareConnectedTarget()
    mockConnectionManager.connect
      .mockReturnValueOnce(nonInteractive.promise)
      .mockResolvedValueOnce({})

    const background = Promise.resolve(
      handlers.get('ssh:connect')!(null, { targetId: target.id, nonInteractive: true })
    )
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledOnce())
    const interactive = Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: target.id }))
    nonInteractive.reject(new Error('batch authentication failed'))

    await expect(background).rejects.toThrow('batch authentication failed')
    await expect(interactive).resolves.toEqual(expect.objectContaining({ status: 'connected' }))
    expect(mockConnectionManager.connect).toHaveBeenNthCalledWith(1, target, {
      automatic: false,
      nonInteractive: true
    })
    expect(mockConnectionManager.connect).toHaveBeenNthCalledWith(2, target, {
      automatic: false,
      nonInteractive: false
    })
  })

  it('registers the provider before broadcasting connected authority', async () => {
    prepareConnectedTarget()

    await handlers.get('ssh:connect')!(null, { targetId: target.id })

    const connectedIndex = mockWindow.webContents.send.mock.calls.findIndex(
      ([channel, payload]) =>
        channel === 'ssh:state-changed' &&
        (payload as { state: SshConnectionState }).state.status === 'connected'
    )
    expect(connectedIndex).toBeGreaterThanOrEqual(0)
    expect(mockRegisterSshGitProvider.mock.invocationCallOrder[0]).toBeLessThan(
      mockWindow.webContents.send.mock.invocationCallOrder[connectedIndex]
    )
    expect(mockWindow.webContents.send.mock.calls[connectedIndex]?.[1]).toEqual({
      targetId: target.id,
      state: expect.objectContaining({
        targetId: target.id,
        status: 'connected',
        providerEpoch: expect.any(String),
        connectionGeneration: 1
      })
    })
  })

  it('exposes the detected remote platform in public state', async () => {
    const windowsTarget: SshTarget = {
      ...target,
      label: 'Windows Server',
      host: 'windows.example.com'
    }
    mockDeployAndLaunchRelay.mockResolvedValueOnce({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      serverBuildId: relayBuildId,
      hostPlatform: {
        relayPlatform: 'win32-x64',
        os: 'win32',
        arch: 'x64',
        pathFlavor: 'windows',
        commandDialect: 'powershell',
        pathSeparator: '\\',
        pathDelimiter: ';'
      }
    })
    prepareConnectedTarget(windowsTarget)

    await expect(handlers.get('ssh:connect')!(null, { targetId: target.id })).resolves.toEqual({
      targetId: target.id,
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      providerEpoch: expect.any(String),
      connectionGeneration: 1,
      remotePlatform: 'win32'
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
      targetId: target.id,
      state: {
        targetId: target.id,
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: 1,
        supportsFolderDownload: true,
        remotePlatform: 'win32'
      }
    })
  })
})
