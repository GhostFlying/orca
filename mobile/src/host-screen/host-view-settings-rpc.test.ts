import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { loadHostViewSettings } from './host-view-settings-rpc'

function success(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

describe('loadHostViewSettings', () => {
  it('loads the display preference when the view settings request fails', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method: string) => {
      if (method === 'ui.get') {
        throw new Error('unavailable')
      }
      return success({ settings: { showPinnedWorktreesInGroups: true } })
    })

    await expect(loadHostViewSettings(client)).resolves.toEqual({
      ui: undefined,
      showPinnedWorktreesInGroups: true
    })
  })

  it('loads view settings when the display preference request fails', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method: string) => {
      if (method === 'settings.get') {
        throw new Error('unavailable')
      }
      return success({ ui: { groupBy: 'repo' } })
    })

    await expect(loadHostViewSettings(client)).resolves.toEqual({
      ui: { groupBy: 'repo' },
      showPinnedWorktreesInGroups: undefined
    })
  })
})
