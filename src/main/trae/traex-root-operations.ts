import { isCodexRootAgentActivity } from '../codex/codex-subagent-activity'
import type { RootTurnObservation } from '../../shared/root-turn-observation'

export type RootHistoryRpc = {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

export type RootHistoryIdentity = {
  sessionId: string
  turnId: string
  observedAt: number
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

const informationalItems = new Set([
  'functionCallOutput',
  'userMessage',
  'taskNotification',
  'hookPrompt',
  'agentMessage',
  'sessionPeerMessage',
  'plan',
  'reasoning',
  'webSearch',
  'imageView',
  'enteredReviewMode',
  'exitedReviewMode',
  'worktreeSessionEntered',
  'worktreeSessionExited',
  'contextCompaction',
  'sleep'
])

const operationItems = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'imageGeneration'
])

export async function readTraexOperationSettlement(
  rpc: RootHistoryRpc,
  identity: RootHistoryIdentity,
  ancestors: ReadonlySet<string> = new Set()
): Promise<RootTurnObservation['operations']> {
  if (ancestors.has(identity.sessionId) || ancestors.size >= 8) {
    return 'unknown'
  }
  const lineage = new Set([...ancestors, identity.sessionId])
  let cursor: string | null = null
  let settlement: RootTurnObservation['operations'] = 'settled'
  const cursors = new Set<string>()
  const childSessions = new Set<string>()
  const settledChildTurns = new Map<string, string>()
  const terminalProcesses = new Set<string>()
  const settledProcesses = new Set<string>()
  for (let pages = 0; pages < 100; pages++) {
    const page = record(
      await rpc.request('thread/items/list', {
        threadId: identity.sessionId,
        cursor,
        limit: 100,
        sortDirection: 'asc'
      })
    )
    if (!Array.isArray(page?.data)) {
      return 'unknown'
    }
    for (const value of page.data) {
      const entry = record(value)
      if (typeof entry?.turnId !== 'string' || !entry.turnId) {
        return 'unknown'
      }
      const item = record(entry.item)
      if (!item || typeof item.type !== 'string') {
        return 'unknown'
      }
      if (item.type === 'subAgentActivity') {
        if (
          typeof item.agentThreadId !== 'string' ||
          !item.agentThreadId ||
          !['started', 'interacted', 'interrupted', 'completed'].includes(String(item.kind))
        ) {
          settlement = 'unknown'
        } else {
          if (
            item.agentThreadId !== identity.sessionId &&
            !isCodexRootAgentActivity({
              kind: String(item.kind),
              agentThreadId: item.agentThreadId,
              agentPath: typeof item.agentPath === 'string' ? item.agentPath : null
            })
          ) {
            childSessions.add(item.agentThreadId)
          }
        }
        continue
      }
      if (item.type === 'collabAgentToolCall') {
        if (!Array.isArray(item.receiverThreadIds)) {
          settlement = 'unknown'
        } else {
          for (const child of item.receiverThreadIds) {
            if (typeof child === 'string' && child) {
              childSessions.add(child)
            } else {
              settlement = 'unknown'
            }
          }
        }
      }
      if (item.type === 'terminalInteraction') {
        if (typeof item.processId !== 'string' || !item.processId) {
          settlement = 'unknown'
        } else {
          terminalProcesses.add(item.processId)
        }
        continue
      }
      if (
        item.type === 'commandExecution' &&
        item.source !== 'unifiedExecInteraction' &&
        typeof item.processId === 'string' &&
        ['completed', 'failed', 'declined', 'cancelled'].includes(String(item.status))
      ) {
        settledProcesses.add(item.processId)
      }
      if (informationalItems.has(item.type)) {
        continue
      }
      if (!operationItems.has(item.type)) {
        settlement = 'unknown'
        continue
      }
      if (['inProgress', 'in_progress', 'backgrounded'].includes(String(item.status))) {
        return 'pending'
      }
      if (
        item.status === 'failed' &&
        (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall')
      ) {
        // An external tool transport failure does not prove its side effects.
        settlement = 'unknown'
      }
      if (!['completed', 'failed', 'declined', 'cancelled'].includes(String(item.status))) {
        settlement = 'unknown'
      }
    }
    if (page.nextCursor === null) {
      if ([...terminalProcesses].some((id) => !settledProcesses.has(id))) {
        return 'unknown'
      }
      for (const sessionId of childSessions) {
        if (lineage.has(sessionId)) {
          continue
        }
        const metadata = record(
          await rpc.request('thread/read', { threadId: sessionId, includeTurns: false })
        )
        if (record(metadata?.thread)?.id !== sessionId) {
          return 'unknown'
        }
        const turns = record(
          await rpc.request('thread/turns/list', {
            threadId: sessionId,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'notLoaded'
          })
        )
        const turn = Array.isArray(turns?.data) ? record(turns.data[0]) : undefined
        if (!turn || typeof turn.id !== 'string' || !turn.id) {
          return 'unknown'
        }
        if (turn.status === 'inProgress') {
          return 'pending'
        }
        if (!['completed', 'failed', 'interrupted'].includes(String(turn.status))) {
          return 'unknown'
        }
        const child = await readTraexOperationSettlement(
          rpc,
          { ...identity, sessionId, turnId: turn.id },
          lineage
        )
        if (child === 'pending') {
          return 'pending'
        }
        if (child === 'unknown') {
          settlement = 'unknown'
        } else {
          settledChildTurns.set(sessionId, turn.id)
        }
      }
      for (const [sessionId, turnId] of settledChildTurns) {
        const page = record(
          await rpc.request('thread/turns/list', {
            threadId: sessionId,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'notLoaded'
          })
        )
        const turn = Array.isArray(page?.data) ? record(page.data[0]) : undefined
        if (turn?.status === 'inProgress') {
          return 'pending'
        }
        if (
          !turn ||
          turn.id !== turnId ||
          !['completed', 'failed', 'interrupted'].includes(String(turn.status))
        ) {
          return 'unknown'
        }
      }
      return settlement
    }
    if (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor)) {
      return 'unknown'
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  return 'unknown'
}
