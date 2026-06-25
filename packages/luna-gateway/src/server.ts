import { createInterface } from 'node:readline'
import { createServer as createNetServer } from 'node:net'
import type { Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import type { GatewayMessage, ServerOptions } from './types'

export function createServer(options: ServerOptions) {
  const { handler, transport } = options

  if (transport === 'socket') {
    const socketPath = options.socketPath!
    try { unlinkSync(socketPath) } catch {}

    const sockets: Socket[] = []
    const server = createNetServer((socket) => {
      sockets.push(socket)

      function emit(msg: GatewayMessage) {
        socket.write(JSON.stringify(msg) + '\n')
      }

      const rl = createInterface({ input: socket })
      rl.on('line', async (line) => {
        try {
          const { message } = JSON.parse(line)
          await handler(message, emit)
        } catch (err) {
          socket.write(JSON.stringify({ type: 'error', error: String(err) }) + '\n')
        }
      })

      socket.on('close', () => {
        const idx = sockets.indexOf(socket)
        if (idx !== -1) sockets.splice(idx, 1)
      })
    })

    server.listen(socketPath)

    function cleanup() {
      for (const s of sockets) s.end()
      server.close()
      try { unlinkSync(socketPath) } catch {}
    }

    process.on('SIGTERM', () => { cleanup(); process.exit(0) })
    process.on('SIGINT', () => { cleanup(); process.exit(0) })
    process.on('exit', cleanup)
    process.on('uncaughtException', (err) => { cleanup(); console.error(err); process.exit(1) })

    return { listen: () => new Promise(() => {}) }
  }

  function emit(msg: GatewayMessage) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }

  async function listen() {
    const rl = createInterface({ input: process.stdin })
    for await (const line of rl) {
      try {
        const { message } = JSON.parse(line)
        await handler(message, emit)
      } catch (err) {
        process.stdout.write(JSON.stringify({ type: 'error', error: String(err) }) + '\n')
      }
    }
  }

  return { listen }
}
