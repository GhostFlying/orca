import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { mergeAgentHookRequestHeaders } from '../shared/agent-hook-listener/hook-envelope'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../shared/agent-hook-listener/listener-limits'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { readRequestBody } from '../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../shared/agent-hook-listener/source-routing'
import {
  isHookRequestTruncatedError,
  type HookRequestTruncatedError
} from '../shared/agent-hook-transport-interference'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'

type RelayHookRequestEvent = {
  event: AgentHookEventPayload
  source: AgentHookSource
  body: unknown
  env?: string
  version?: string
}

type RelayHookRequestHandlerOptions = {
  token: string
  env: string
  state: HookListenerState
  onEvent: (input: RelayHookRequestEvent) => void
  onTransportInterference: (
    source: AgentHookSource | null,
    error: HookRequestTruncatedError
  ) => void
}

export function listenOnRelayHookServer(
  port: number,
  handleRequest: (request: IncomingMessage, response: ServerResponse) => void,
  updateServer: (server: Server | null) => void
): Promise<number> {
  const server = createServer(handleRequest)
  updateServer(server)
  return new Promise<number>((resolve, reject) => {
    const onStartupError = (error: Error): void => {
      server.off('listening', onListening)
      updateServer(null)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onStartupError)
      server.on('error', (error) => {
        process.stderr.write(`[relay-hook-server] server error: ${error.message}\n`)
      })
      const address = server.address()
      resolve(address && typeof address === 'object' ? address.port : 0)
    }
    server.once('error', onStartupError)
    server.listen(port, '127.0.0.1', onListening)
  })
}

export async function handleRelayHookRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RelayHookRequestHandlerOptions
): Promise<void> {
  if (request.method !== 'POST') {
    response.writeHead(404)
    response.end()
    return
  }
  if (request.headers['x-orca-agent-hook-token'] !== options.token) {
    response.writeHead(403)
    response.end()
    return
  }
  let destroyedBySlowlorisCap = false
  request.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
    destroyedBySlowlorisCap = true
    request.destroy()
  })
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const source = resolveHookSource(pathname)
    if (!source) {
      response.writeHead(404)
      response.end()
      return
    }
    const body = await readRequestBody(request)
    const hookBody = mergeAgentHookRequestHeaders(body, request.headers)
    const event = normalizeHookPayload(options.state, source, hookBody, options.env, {
      deferCompactOwnershipToClient: true
    })
    if (event) {
      options.onEvent({
        event,
        source: event.source ?? source,
        body: hookBody,
        env: hookBodyEnv(hookBody),
        version: hookBodyVersion(hookBody)
      })
    }
    response.writeHead(204)
    response.end()
  } catch (error) {
    if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
      options.onTransportInterference(null, error)
    }
    process.stderr.write(
      `[relay-hook-server] hook request failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    response.writeHead(204)
    response.end()
  }
}
