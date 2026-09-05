import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import type { IFilesystemProvider } from '../providers/types'
import {
  readTranscriptRandomAccessTail,
  type NativeChatLineDecoder
} from './transcript-random-access-tail'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'

const MAX_WHOLE_FILE_TRANSCRIPT_BYTES = 10 * 1024 * 1024

export type RemoteTranscriptTail = Awaited<ReturnType<typeof readTranscriptRandomAccessTail>>

export async function readRemoteTranscriptTail(
  provider: IFilesystemProvider,
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder,
  beforeOffset?: number,
  signal?: AbortSignal,
  knownSize?: number
): Promise<RemoteTranscriptTail> {
  const size = knownSize ?? (await provider.stat(filePath)).size
  signal?.throwIfAborted()
  const rangeSupported =
    provider.readFileRange != null &&
    (provider.supportsFileRangeRead == null || (await provider.supportsFileRangeRead({ signal })))
  signal?.throwIfAborted()
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent('traex')
  if (rangeSupported && provider.readFileRange) {
    return readTranscriptRandomAccessTail({
      filePath,
      size,
      limit,
      includeTrailingLine: true,
      endOffset: beforeOffset,
      decode,
      decodeLifecycle,
      readRange: (position, length, rangeSignal) =>
        provider.readFileRange!(filePath, position, Math.min(length, MAX_FILE_RANGE_READ_BYTES), {
          signal: rangeSignal
        }),
      signal
    })
  }

  const result = await provider.readFile(filePath, {
    maxTextBytes: MAX_WHOLE_FILE_TRANSCRIPT_BYTES
  })
  signal?.throwIfAborted()
  if (result.isBinary) {
    throw new Error('Transcript is not UTF-8 text')
  }
  const bytes = Buffer.from(result.content, 'utf8')
  return readTranscriptRandomAccessTail({
    filePath,
    size: bytes.length,
    limit,
    includeTrailingLine: true,
    endOffset: beforeOffset,
    decode,
    decodeLifecycle,
    readRange: async (position, length) => {
      const slice = bytes.subarray(position, position + length)
      return { bytes: slice, bytesRead: slice.length }
    },
    signal
  })
}
