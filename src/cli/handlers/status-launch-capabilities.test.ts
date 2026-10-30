import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { CORE_HANDLERS } from './core'

vi.mock('../runtime/status-caller', () => ({ resolveCliStatusCaller: async () => undefined }))

afterEach(() => vi.restoreAllMocks())

it('reports local launch support separately from an older execution host', async () => {
  const client = new RuntimeClient(
    mkdtempSync(join(tmpdir(), 'orca-launch-capability-')),
    1000,
    null,
    null,
    'orca'
  )
  vi.spyOn(client, 'getCliStatus').mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      app: { running: true, pid: 1 },
      runtime: { state: 'ready', reachable: true, runtimeId: 'host-1', capabilities: [] },
      graph: { state: 'ready' }
    },
    _meta: { runtimeId: 'host-1' }
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await CORE_HANDLERS.status({ client, flags: new Map(), cwd: '/tmp', json: true, rawArgs: [] })
  const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
  expect(printed.result.client.capabilities).toContain('agent.launch.trae-model.v1')
  expect(printed.result.runtime.capabilities).toEqual([])
})
