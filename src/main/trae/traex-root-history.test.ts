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
    async request(method: string, _params?: Record<string, unknown>): Promise<unknown> {
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
    expect(rpc.calls).toEqual([
      'thread/read',
      'thread/turns/list',
      'thread/items/list',
      'thread/turns/list'
    ])
  })
  it('refuses a different native turn', async () => {
    expect(await readTraexRootHistory(rpcFor({ turnId: 'old' }), identity)).toMatchObject({
      state: 'unknown',
      operations: 'unknown'
    })
  })
  it.each([
    [{ type: 'commandExecution', status: 'inProgress' }, 'pending'],
    [{ type: 'commandExecution', source: 'unifiedExecStartup', status: 'backgrounded' }, 'pending'],
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
    expect(
      await readTraexRootHistory(
        rpcFor({
          items: [
            interaction,
            {
              type: 'commandExecution',
              source: 'unifiedExecInteraction',
              processId: 'process',
              status: 'completed'
            }
          ]
        }),
        identity
      )
    ).toMatchObject({ operations: 'unknown' })
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
  it('reads subagent settlement without changing the parent verdict', async () => {
    let childStatus = 'inProgress'
    let rootStatus = 'failed'
    const rpc = {
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const threadId = params.threadId
        if (method === 'thread/read') {
          return { thread: { id: threadId } }
        }
        if (method === 'thread/turns/list') {
          return {
            data: [
              {
                id: threadId === 'session' ? 'turn' : 'child-turn',
                status: threadId === 'session' ? rootStatus : childStatus,
                startedAt: 100,
                completedAt: 110,
                error: { codexErrorInfo: 'other' }
              }
            ]
          }
        }
        if (method !== 'thread/items/list') {
          throw new Error('unexpected mutation')
        }
        return {
          data:
            threadId === 'session'
              ? [
                  {
                    turnId: 'turn',
                    item: { type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child' }
                  }
                ]
              : [],
          nextCursor: null
        }
      }
    }
    expect(await readTraexRootHistory(rpc, identity)).toMatchObject({
      state: 'failed',
      operations: 'pending'
    })
    childStatus = 'completed'
    expect(await readTraexRootHistory(rpc, identity)).toMatchObject({
      state: 'failed',
      operations: 'settled'
    })
    rootStatus = 'completed'
    childStatus = 'failed'
    expect(await readTraexRootHistory(rpc, identity)).toMatchObject({
      state: 'completed',
      operations: 'settled'
    })
  })
  it('ignores root activity paths and retains unresolved external tool failures', async () => {
    expect(
      await readTraexRootHistory(
        rpcFor({
          items: [
            {
              type: 'subAgentActivity',
              kind: 'started',
              agentThreadId: 'root-agent',
              agentPath: '/root'
            }
          ]
        }),
        identity
      )
    ).toMatchObject({ operations: 'settled' })
    expect(
      await readTraexRootHistory(
        rpcFor({ items: [{ type: 'mcpToolCall', status: 'failed' }] }),
        identity
      )
    ).toMatchObject({ operations: 'unknown' })
  })
  it('checks background commands left by older child turns', async () => {
    const rpc = {
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        if (method === 'thread/read') {
          return { thread: { id: params.threadId } }
        }
        if (method === 'thread/turns/list') {
          return {
            data: [
              {
                id: params.threadId === 'session' ? 'turn' : 'new-child-turn',
                status: 'failed',
                startedAt: 100,
                completedAt: 110,
                error: { codexErrorInfo: 'other' }
              }
            ]
          }
        }
        if (method !== 'thread/items/list') {
          throw new Error('unexpected mutation')
        }
        if (params.threadId === 'session') {
          return {
            data: [
              {
                turnId: 'turn',
                item: {
                  type: 'subAgentActivity',
                  kind: 'started',
                  agentThreadId: 'child',
                  agentPath: '/root/child'
                }
              }
            ],
            nextCursor: null
          }
        }
        expect(params).not.toHaveProperty('turnId')
        return {
          data: [
            { turnId: 'old-child-turn', item: { type: 'commandExecution', status: 'inProgress' } }
          ],
          nextCursor: null
        }
      }
    }
    expect(await readTraexRootHistory(rpc, identity)).toMatchObject({
      state: 'failed',
      operations: 'pending'
    })
  })
  it('rejects a native turn replacement that happens during history pagination', async () => {
    const original = rpcFor()
    let lists = 0
    const rpc = {
      request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        if (method === 'thread/turns/list' && ++lists > 1) {
          return { data: [{ id: 'replacement', status: 'inProgress' }] }
        }
        return original.request(method, params)
      }
    }
    expect(await readTraexRootHistory(rpc, identity)).toMatchObject({
      state: 'unknown',
      operations: 'unknown',
      errorCode: 'ownership_changed',
      retryable: false
    })
  })
})
