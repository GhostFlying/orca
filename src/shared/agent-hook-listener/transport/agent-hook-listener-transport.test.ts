import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEndpointFileName, writeEndpointFile } from './endpoint-publication'
import { mergeAgentHookRequestHeaders } from '../hook-envelope'
import { createHookListenerState } from '../listener-state'
import { normalizeHookPayload } from '../normalization/normalize-hook-payload'

describe('shared agent-hook-listener', () => {
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  const packedMetadata = (...values: string[]): string =>
    Buffer.from(values.join('\x1f'), 'utf8').toString('base64')

  it('restores TraeX identity from the optional observed-agent header', () => {
    const merged = mergeAgentHookRequestHeaders(
      { hook_event_name: 'UserPromptSubmit', prompt: 'hello', session_id: 'traex-session' },
      {
        'x-orca-agent-hook-meta-encoding': 'base64',
        'x-orca-agent-hook-meta': packedMetadata(
          paneKey,
          'tab-1',
          '',
          'repo::/tmp/work',
          'production',
          '1'
        ),
        'x-orca-agent-hook-observed-agent': 'traex'
      }
    )

    expect(
      normalizeHookPayload(createHookListenerState(), 'trae', merged, 'production')
    ).toMatchObject({
      source: 'traex',
      providerSession: { key: 'session_id', id: 'traex-session' },
      payload: { state: 'working', prompt: 'hello', agentType: 'traex' }
    })
  })
  describe('writeEndpointFile', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-hook-listener-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('refuses unsafe values', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'safe-token',
        env: 'foo&bar',
        version: '1'
      })
      expect(ok).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    })
  })
})
