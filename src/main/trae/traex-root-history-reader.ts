import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import { resolveCliCommand } from '../codex-cli/command'
import { spawnCodexAppServerConnection } from '../codex/codex-app-server-connection'
import { initializeCodexAppServerConnection } from '../codex/app-server/codex-app-server-handshake'
import type { CodexAppServerConnection } from '../codex/app-server/codex-app-server-connection-types'
import type { RootTurnObservation } from '../../shared/root-turn-observation'
import { readTraexRootHistory } from './traex-root-history'

export type TraexRootHistoryQuery = {
  sessionId: string
  turnId: string
  transcriptPath: string
}

type HistoryConnection = Pick<CodexAppServerConnection, 'request' | 'close' | 'closed'>
type HistoryConnect = (home: string) => Promise<HistoryConnection>

export function traexHistoryHome(path: string): string | undefined {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) {
    return undefined
  }
  let parent = dirname(path)
  for (let i = 0; i < 3; i++) {
    if (!/^\d{2,4}$/.test(basename(parent))) {
      return undefined
    }
    parent = dirname(parent)
  }
  if (basename(parent) !== 'sessions') {
    return undefined
  }
  try {
    return realpathSync(dirname(parent))
  } catch {
    return undefined
  }
}

async function connectHistory(home: string): Promise<HistoryConnection> {
  const connection = await spawnCodexAppServerConnection({
    command: resolveCliCommand('traex'),
    args: ['-c', 'features.hooks=false', 'app-server'],
    env: { TRAECLI_HOME: home },
    envToDelete: Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('ORCA_'))
  })
  try {
    await initializeCodexAppServerConnection(connection, 3000)
    return connection
  } catch {
    await connection.close()
    throw new Error('native history connection unavailable')
  }
}

export class TraexRootHistoryReader {
  private readonly connections = new Map<string, Promise<HistoryConnection>>()
  private readonly pendingReads = new Set<Promise<void>>()
  private stopped = false

  constructor(private readonly connect: HistoryConnect = connectHistory) {}

  async read(query: TraexRootHistoryQuery): Promise<RootTurnObservation | undefined> {
    const home = traexHistoryHome(query.transcriptPath)
    if (!home || this.stopped || !query.turnId) {
      return undefined
    }
    const unknown: RootTurnObservation = {
      version: 1,
      sessionId: query.sessionId,
      turnId: query.turnId,
      observedAt: Date.now(),
      startedAt: 0,
      source: 'native-api',
      state: 'unknown',
      operations: 'unknown',
      errorCode: 'observation_unavailable',
      retryable: false
    }
    const deadline = Date.now() + 3000
    let result: RootTurnObservation = unknown
    const pending = (async () => {
      if (this.stopped || Date.now() >= deadline) {
        return
      }
      let opening = this.connections.get(home)
      if (!opening) {
        opening = this.connect(home)
        this.connections.set(home, opening)
      }
      try {
        const connection = await opening
        if (this.stopped || connection.closed) {
          throw new Error('history reader stopped')
        }
        result = await readTraexRootHistory(
          {
            request: async (method, params) => {
              const remaining = deadline - Date.now()
              if (this.stopped || remaining <= 0) {
                throw new Error('history read deadline')
              }
              return connection.request(method, params, { timeoutMs: remaining })
            }
          },
          { ...query, observedAt: Date.now() }
        )
      } catch {
        if (this.connections.get(home) === opening) {
          this.connections.delete(home)
        }
        void opening.then((connection) => connection.close()).catch(() => {})
      }
    })()
    this.pendingReads.add(pending)
    await pending
    this.pendingReads.delete(pending)
    return this.stopped ? undefined : result
  }

  async stop(): Promise<void> {
    this.stopped = true
    const connections = [...this.connections.values()]
    this.connections.clear()
    await Promise.allSettled(connections.map(async (opening) => (await opening).close()))
    await Promise.allSettled(this.pendingReads)
    this.pendingReads.clear()
  }
}
