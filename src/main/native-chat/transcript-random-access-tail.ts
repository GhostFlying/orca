import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import type { NativeChatTurnLifecycleDecoder } from './transcript-turn-lifecycle'
import { TAIL_CHUNK_BYTES } from './transcript-tail-boundary'

export const MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024
export type NativeChatLineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export type TranscriptRangeReader = (
  position: number,
  length: number,
  signal?: AbortSignal
) => Promise<{ bytes: Buffer; bytesRead: number }>

export async function readTranscriptRandomAccessTail(args: {
  filePath: string
  size: number
  limit: number
  includeTrailingLine?: boolean
  endOffset?: number
  decode: NativeChatLineDecoder
  decodeLifecycle?: NativeChatTurnLifecycleDecoder | null
  readRange: TranscriptRangeReader
  signal?: AbortSignal
}): Promise<{
  messages: NativeChatMessage[]
  lifecycle?: NativeChatTurnLifecycle
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
  malformedRecordCount?: number
  oversizedRecordCount?: number
}> {
  const { filePath, limit, decode, decodeLifecycle, readRange, signal } = args
  signal?.throwIfAborted()
  const end = Math.min(args.size, args.endOffset ?? Number.MAX_SAFE_INTEGER)
  if (end === 0) {
    return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
  }

  const final = await readRange(end - 1, 1, signal)
  if (final.bytesRead !== 1) {
    return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
  }
  const finalByte = final.bytes[0]
  const consumedTo =
    args.includeTrailingLine || finalByte === 0x0a
      ? end
      : await findLastCompleteLineEnd(end, readRange, signal)
  if (consumedTo === 0) {
    return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
  }

  const newestFirst: { message: NativeChatMessage; offset: number }[] = []
  const lineParts: Buffer[] = []
  let lineBytes = 0
  let lineOversized = false
  let lifecycle: NativeChatTurnLifecycle | undefined
  let malformedRecordCount = 0
  let oversizedRecordCount = 0
  let ignoreNextMalformedRecord = finalByte !== 0x0a
  let cursor = consumedTo - (finalByte === 0x0a ? 1 : 0)

  while (cursor > 0 && newestFirst.length <= limit) {
    signal?.throwIfAborted()
    const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
    const result = await readRange(start, cursor - start, signal)
    signal?.throwIfAborted()
    if (result.bytesRead < cursor - start) {
      break
    }
    const buffer = result.bytes.subarray(0, result.bytesRead)
    let segmentEnd = buffer.length
    for (let index = buffer.length - 1; index >= 0 && newestFirst.length <= limit; index--) {
      if (buffer[index] !== 0x0a) {
        continue
      }
      retainPart(buffer.subarray(index + 1, segmentEnd))
      if (!lineOversized) {
        decodeLine(start + index + 1)
      }
      resetLine()
      segmentEnd = index
    }
    if (segmentEnd > 0) {
      retainPart(buffer.subarray(0, segmentEnd))
    }
    cursor = start
  }
  if (cursor === 0 && lineParts.length > 0 && newestFirst.length <= limit) {
    decodeLine(0)
  }
  const chronological = newestFirst.toReversed()
  const selected = limit > 0 ? chronological.slice(Math.max(0, chronological.length - limit)) : []
  return {
    messages: selected.map((entry) => entry.message),
    ...(lifecycle ? { lifecycle } : {}),
    consumedTo,
    hasMore: limit > 0 && chronological.length > limit,
    beforeOffset: selected[0]?.offset ?? end,
    ...(malformedRecordCount > 0 ? { malformedRecordCount } : {}),
    ...(oversizedRecordCount > 0 ? { oversizedRecordCount } : {})
  }

  function retainPart(part: Buffer): void {
    if (lineOversized) {
      return
    }
    lineBytes += part.length
    if (lineBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      lineParts.length = 0
      lineOversized = true
      oversizedRecordCount++
      return
    }
    lineParts.push(part)
  }

  function resetLine(): void {
    lineParts.length = 0
    lineBytes = 0
    lineOversized = false
  }

  function decodeLine(lineOffset: number): void {
    let line = Buffer.concat([...lineParts].toReversed()).toString('utf8')
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (!line) {
      return
    }
    try {
      JSON.parse(line)
    } catch {
      if (ignoreNextMalformedRecord) {
        ignoreNextMalformedRecord = false
        return
      }
      malformedRecordCount++
      return
    }
    ignoreNextMalformedRecord = false
    const fallbackId = transcriptFallbackId(filePath, lineOffset)
    lifecycle ??= decodeLifecycle?.(line, fallbackId) ?? undefined
    const message = decode(line, fallbackId)
    if (message) {
      newestFirst.push({ message, offset: lineOffset })
    }
  }
}

async function findLastCompleteLineEnd(
  end: number,
  readRange: TranscriptRangeReader,
  signal?: AbortSignal
): Promise<number> {
  let cursor = end
  while (cursor > 0) {
    signal?.throwIfAborted()
    const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
    const result = await readRange(start, cursor - start, signal)
    if (result.bytesRead < cursor - start) {
      return 0
    }
    const newline = result.bytes.subarray(0, result.bytesRead).lastIndexOf(0x0a)
    if (newline !== -1) {
      return start + newline + 1
    }
    cursor = start
  }
  return 0
}
