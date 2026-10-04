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

import type { SshTarget } from '../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager } = mocks

function createTarget(): SshTarget {
  return {
    id: 'ssh-1',
    label: 'Server',
    host: 'example.com',
    port: 22,
    username: 'deploy'
  }
}

describe('SSH non-interactive connect policy', () => {
  const harness = createSshIpcHarness(mocks)

  beforeEach(harness.reset)

  it('forwards the local non-interactive policy', async () => {
    const target = createTarget()
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await harness.handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1',
      nonInteractive: true
    })

    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target, { nonInteractive: true })
  })

  it('shares concurrent non-interactive attempts for one target', async () => {
    const target = createTarget()
    const connection = Promise.withResolvers<object>()
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockReturnValue(connection.promise)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    const first = Promise.resolve(
      harness.handlers.get('ssh:connect')!(null, {
        targetId: 'ssh-1',
        nonInteractive: true
      })
    )
    const second = Promise.resolve(
      harness.handlers.get('ssh:connect')!(null, {
        targetId: 'ssh-1',
        nonInteractive: true
      })
    )
    connection.resolve({})

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
  })

  it('does not join an interactive attempt from a non-interactive caller', async () => {
    const target = createTarget()
    const connection = Promise.withResolvers<object>()
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockReturnValue(connection.promise)

    const interactive = Promise.resolve(
      harness.handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    )

    await expect(
      harness.handlers.get('ssh:connect')!(null, {
        targetId: 'ssh-1',
        nonInteractive: true
      })
    ).rejects.toThrow('interactive SSH connection attempt is already in progress')
    connection.reject(new Error('interactive failed'))
    await expect(interactive).rejects.toThrow('interactive failed')
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
  })

  it('retries interactively after a concurrent non-interactive attempt fails', async () => {
    const target = createTarget()
    const nonInteractive = Promise.withResolvers<object>()
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect
      .mockReturnValueOnce(nonInteractive.promise)
      .mockResolvedValueOnce({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    const background = Promise.resolve(
      harness.handlers.get('ssh:connect')!(null, {
        targetId: 'ssh-1',
        nonInteractive: true
      })
    )
    const interactive = Promise.resolve(
      harness.handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    )
    nonInteractive.reject(new Error('batch authentication failed'))

    await expect(background).rejects.toThrow('batch authentication failed')
    await expect(interactive).resolves.toEqual(expect.objectContaining({ status: 'connected' }))
    expect(mockConnectionManager.connect).toHaveBeenNthCalledWith(1, target, {
      nonInteractive: true
    })
    expect(mockConnectionManager.connect).toHaveBeenNthCalledWith(2, target)
  })
})
