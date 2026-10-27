import { createHash } from 'node:crypto'
import type { RootTurnObservation } from '../../shared/root-turn-observation'
import { TraexRootHistoryReader, type TraexRootHistoryQuery } from './traex-root-history-reader'

export type TraexRootOwner = TraexRootHistoryQuery & {
  paneKey: string
  launchToken: string
}

function sameOwner(a: TraexRootOwner, b: TraexRootOwner | undefined): boolean {
  return Boolean(
    b &&
    a.paneKey === b.paneKey &&
    a.launchToken === b.launchToken &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.transcriptPath === b.transcriptPath
  )
}

/** Owns bounded read-only queries; hooks never wait for native history. */
export class TraexRootObserver {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pending = new Set<string>()
  private stopped = false

  constructor(
    private readonly current: (paneKey: string) => TraexRootOwner | undefined,
    private readonly publish: (owner: TraexRootOwner, observation: RootTurnObservation) => void,
    private readonly reader: Pick<
      TraexRootHistoryReader,
      'read' | 'stop'
    > = new TraexRootHistoryReader()
  ) {}

  schedule(paneKey: string): void {
    if (
      this.stopped ||
      this.timers.has(paneKey) ||
      this.pending.has(paneKey) ||
      !this.current(paneKey)
    ) {
      return
    }
    const timer = setTimeout(() => {
      void this.poll(paneKey)
    }, 5000)
    timer.unref?.()
    this.timers.set(paneKey, timer)
  }

  private async poll(paneKey: string): Promise<void> {
    this.timers.delete(paneKey)
    const owner = this.current(paneKey)
    if (this.stopped || !owner) {
      return
    }
    this.pending.add(paneKey)
    try {
      const observation = await this.reader.read(owner)
      if (!this.stopped && observation && sameOwner(owner, this.current(paneKey))) {
        this.publish(owner, {
          ...observation,
          paneKey,
          launchId: createHash('sha256').update(owner.launchToken).digest('hex')
        })
      }
    } finally {
      this.pending.delete(paneKey)
      this.schedule(paneKey)
    }
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    void this.reader.stop()
  }
}

export function traexRootPollHook(
  owner: TraexRootOwner,
  row: { paneKey: string; launchToken?: string; tabId?: string; worktreeId?: string },
  env: string
) {
  return {
    paneKey: row.paneKey,
    launchToken: row.launchToken,
    tabId: row.tabId,
    worktreeId: row.worktreeId,
    observedAgent: 'traex',
    env,
    payload: {
      session_id: owner.sessionId,
      turn_id: owner.turnId,
      transcript_path: owner.transcriptPath
    }
  }
}
