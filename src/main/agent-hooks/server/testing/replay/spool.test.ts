import { describe, expect, it } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_HOOK_SPOOL_MAX_FILES,
  drainAgentHookSpoolAsync,
  launchTokenHash,
  readSpoolFile,
  type SpoolRecord
} from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { AgentHookServer } from '../../agent-hook-server'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

describe('agent hook spool', () => {
  it('waits for a newline before replaying a complete-looking final record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-unterminated-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'pane-live.jsonl')
    const record = JSON.stringify({
      paneKey: 'tab:live',
      source: 'codex',
      receivedAt: Date.now(),
      payload: { state: 'done' }
    })
    writeFileSync(file, record)
    const ingested: SpoolRecord[] = []
    const options = {
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (value: SpoolRecord) => {
        ingested.push(value)
      }
    }
    expect(await drainAgentHookSpoolAsync(options)).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(record)

    appendFileSync(file, '\n')
    expect(await drainAgentHookSpoolAsync(options)).toBe(1)
    expect(ingested).toHaveLength(1)
    expect(readFileSync(file)).toHaveLength(0)
  })

  it('does not let historical empty pane files starve newer records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-empty-files-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    for (let index = 0; index < AGENT_HOOK_SPOOL_MAX_FILES; index += 1) {
      writeFileSync(join(spool, `pane-empty-${index}.jsonl`), '')
    }
    const live = join(spool, 'pane-live.jsonl')
    writeFileSync(
      live,
      `\n${JSON.stringify({ paneKey: 'tab:live', source: 'codex', receivedAt: Date.now(), payload: { state: 'done' } })}\n`
    )
    const ingested: SpoolRecord[] = []
    await drainAgentHookSpoolAsync({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (record) => {
        ingested.push(record)
      }
    })
    expect(ingested).toHaveLength(1)
    expect(ingested[0]?.paneKey).toBe('tab:live')
  })

  it('rejects stale launch tokens before ingest and truncates in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'pane-1.jsonl')
    writeFileSync(
      file,
      `\n${JSON.stringify({ paneKey: 'tab:1', source: 'codex', launchToken: 'old', receivedAt: Date.now(), payload: { state: 'done' } })}\n`
    )
    const inode = statSync(file).ino
    const ingested: unknown[] = []
    await drainAgentHookSpoolAsync({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => launchTokenHash('new')!,
      ingest: (record) => {
        ingested.push(record)
      }
    })
    expect(ingested).toHaveLength(0)
    expect(readFileSync(file)).toHaveLength(0)
    expect(statSync(file).ino).toBe(inode)
  })

  it('restores TraeX identity from a spooled Trae hook', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-spool-traex-'))
    const paneKey = makePaneKey('tab-traex', '00000000-0000-4000-8000-000000000004')
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    const spoolPath = join(spoolDir, 'pane-traex.jsonl')
    const record = {
      paneKey,
      source: 'trae',
      observedAgent: 'traex',
      receivedAt: Number.MAX_SAFE_INTEGER - 1000,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hello',
        session_id: 'traex-session'
      }
    }
    writeFileSync(spoolPath, `\n${JSON.stringify(record)}\n`)

    expect(readSpoolFile(spoolPath).records[0]?.observedAgent).toBe('traex')
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        paneKey,
        agentType: 'traex',
        providerSession: { key: 'session_id', id: 'traex-session' }
      })
    } finally {
      server.stop()
    }
  })

  it('rejects a stale remote replay against the hydrated launch-token fence', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-spool-remote-fence-'))
    const paneKey = makePaneKey('tab-remote-fence', '00000000-0000-4000-8000-000000000003')
    const first = new AgentHookServer()
    const second = new AgentHookServer()
    try {
      await first.start({ env: 'production', userDataPath })
      first.ingestRemote(
        {
          paneKey,
          source: 'codex',
          launchToken: 'old-generation',
          payload: { state: 'working', agentType: 'codex', prompt: 'old' }
        },
        'ssh-1'
      )
      first.flushStatusPersistSync()
      first.stop()

      await second.start({ env: 'production', userDataPath })
      second.ingestRemote(
        {
          paneKey,
          source: 'codex',
          launchToken: 'new-generation',
          isReplay: true,
          payload: { state: 'done', agentType: 'codex', prompt: 'stale completion' }
        },
        'ssh-2'
      )
      expect(second.getStatusSnapshot()[0]).toMatchObject({
        paneKey,
        state: 'working',
        prompt: 'old'
      })
    } finally {
      first.stop()
      second.stop()
    }
  })
})
