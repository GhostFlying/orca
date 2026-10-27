import { describe, expect, it } from 'vitest'
import { readTraexRootHistory } from './traex-root-history'

const identity = { sessionId: 'session', turnId: 'turn', observedAt: 200_000 }
function rpcFor(
  options: {
    turnId?: string
    error?: unknown
    items?: unknown[]
    nextCursor?: unknown
    itemsUnavailable?: boolean
  } = {}
) {
  const calls: string[] = []
  return {
    calls,
    async request(method: string): Promise<unknown> {
      calls.push(method)
      if (method === 'thread/read') {
        return { thread: { id: 'session' } }
      }
      if (method === 'thread/turns/list') {
        return {
          data: [
            {
              id: options.turnId ?? 'turn',
              status: 'failed',
              startedAt: 100,
              completedAt: 110,
              error: options.error ?? { message: 'private error text', codexErrorInfo: 'other' }
            }
          ]
        }
      }
      if (method !== 'thread/items/list') {
        throw new Error('unexpected mutation')
      }
      if (options.itemsUnavailable) {
        throw new Error('unavailable')
      }
      return {
        data: (options.items ?? []).map((item) => ({ turnId: identity.turnId, item })),
        nextCursor: options.nextCursor ?? null
      }
    }
  }
}

describe('read-only native root facts', () => {
  it('detects failed history without JSONL or children and excludes raw error text', async () => {
    const rpc = rpcFor()
    const observation = await readTraexRootHistory(rpc, identity)
    expect(observation).toMatchObject({
      state: 'failed',
      operations: 'settled',
      errorCode: 'other',
      retryable: false
    })
    expect(JSON.stringify(observation)).not.toContain('private error text')
    expect(rpc.calls).toEqual(['thread/read', 'thread/turns/list', 'thread/items/list'])
  })
  it('refuses a different native turn', async () => {
    expect(await readTraexRootHistory(rpcFor({ turnId: 'old' }), identity)).toMatchObject({
      state: 'unknown',
      operations: 'unknown'
    })
  })
  it.each([
    [{ type: 'commandExecution', status: 'inProgress' }, 'pending'],
    [{ type: 'futureExternalOperation', status: 'completed' }, 'unknown'],
    [{ type: 'dynamicToolCall' }, 'unknown'],
    [{ type: 'commandExecution', status: 'completed' }, 'settled']
  ])('checks operation completion for %j', async (item, operations) => {
    expect(await readTraexRootHistory(rpcFor({ items: [item] }), identity)).toMatchObject({
      state: 'failed',
      operations
    })
  })
  it('settles terminal interactions only with the completed parent command', async () => {
    const interaction = { type: 'terminalInteraction', processId: 'process' }
    expect(
      await readTraexRootHistory(
        rpcFor({
          items: [
            interaction,
            { type: 'commandExecution', processId: 'process', status: 'completed' }
          ]
        }),
        identity
      )
    ).toMatchObject({ operations: 'settled' })
    expect(await readTraexRootHistory(rpcFor({ items: [interaction] }), identity)).toMatchObject({
      operations: 'unknown'
    })
  })
  it('keeps the failed root when operation history is unavailable', async () => {
    expect(await readTraexRootHistory(rpcFor({ itemsUnavailable: true }), identity)).toMatchObject({
      state: 'failed',
      operations: 'unknown'
    })
  })
  it('rejects incomplete pagination', async () => {
    expect(await readTraexRootHistory(rpcFor({ nextCursor: 'repeat' }), identity)).toMatchObject({
      operations: 'unknown'
    })
  })
  it.each([
    ['other', false],
    ['unauthorized', false],
    ['quotaExceeded', false],
    ['rateLimitExceeded', true],
    [{ responseStreamDisconnected: { httpStatusCode: 503 } }, true],
    [{ responseStreamDisconnected: { httpStatusCode: 401 } }, false]
  ])('normalizes typed error %j', async (codexErrorInfo, retryable) => {
    expect(
      await readTraexRootHistory(rpcFor({ error: { codexErrorInfo } }), identity)
    ).toMatchObject({ retryable })
  })
})
