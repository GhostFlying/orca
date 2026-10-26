import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'

const NOW = 1_800_000_000_000
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-operation-reload-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('reloads distinct operation keys for the same caller', async () => {
  const store = await openTestAgentSessionRecordStore(directory, { hostId: 'local' })
  const operationIds = [1, 2].map((index) => `${NOW}-${String(index).padStart(32, '0')}`)
  for (const [index, operationId] of operationIds.entries()) {
    await store.admitOperation({
      callerKey: 'client-1',
      operationId,
      fingerprint: `fp-${index + 1}`,
      now: NOW
    })
  }

  const reopened = await openTestAgentSessionRecordStore(directory, { hostId: 'local' })
  expect(reopened.listOperationRows().map((row) => row.operationId)).toEqual(operationIds)
})
