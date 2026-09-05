import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

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
