import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer as createNetServer, createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { unlinkSync } from 'node:fs'

export type GatewayMessage = Record<string, unknown>

export interface ServerOptions {
  agentId: string
  handler: (prompt: string, emit: (msg: GatewayMessage) => void) => Promise<void>
  transport?: 'stdio' | 'socket'
  socketPath?: string
}

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

export interface ConnectionOptions {
  agentId: string
  entrypoint: string
  transport?: 'stdio' | 'socket'
  socketPath?: string
  spawnCwd?: string
  workspaceCwd?: string
}

export interface Connection {
  send: (message: string) => void
  receive: () => AsyncGenerator<GatewayMessage>
  getStderr: () => string
  kill: () => void
  exited: Promise<number | null>
  child: ChildProcess | null
}

function waitForSocket(socketPath: string, timeout = 15000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function poll() {
      try {
        const s = createConnection(socketPath, () => {
          s.end()
          resolve()
        })
        s.on('error', () => {
          s.destroy()
          if (Date.now() - start > timeout) {
            reject(new Error(`Socket ${socketPath} did not appear within ${timeout}ms`))
          } else {
            setTimeout(poll, 200)
          }
        })
      } catch {
        if (Date.now() - start > timeout) {
          reject(new Error(`Socket ${socketPath} did not appear within ${timeout}ms`))
        } else {
          setTimeout(poll, 200)
        }
      }
    }
    poll()
  })
}

function createSocketConnection(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => resolve(socket))
    socket.on('error', reject)
    const to = setTimeout(() => {
      socket.destroy()
      reject(new Error('Socket connection timeout'))
    }, 5000)
    socket.on('connect', () => clearTimeout(to))
  })
}

function buildReceive(socket: Socket): () => AsyncGenerator<GatewayMessage> {
  return function (): AsyncGenerator<GatewayMessage> {
    const buffer: string[] = []
    let pending: ((value: IteratorResult<GatewayMessage>) => void) | null = null
    let closed = false

    const rl = createInterface({ input: socket })
    rl.on('line', (line: string) => {
      if (pending) {
        const p = pending
        pending = null
        try { p({ value: JSON.parse(line), done: false }) }
        catch { p({ value: { type: 'error', error: line }, done: false }) }
      } else {
        buffer.push(line)
      }
    })

    rl.on('close', () => {
      closed = true
      if (pending) pending({ value: undefined as any, done: true })
    })

    return {
      [Symbol.asyncIterator]() { return this },
      next(): Promise<IteratorResult<GatewayMessage>> {
        if (buffer.length > 0) {
          const line = buffer.shift()!
          try { return Promise.resolve({ value: JSON.parse(line), done: false }) }
          catch { return Promise.resolve({ value: { type: 'error', error: line }, done: false }) }
        }
        if (closed) return Promise.resolve({ value: undefined as any, done: true })
        return new Promise((resolve) => { pending = resolve })
      },
      return(): Promise<IteratorResult<GatewayMessage>> {
        pending = null
        return Promise.resolve({ value: undefined as any, done: true })
      },
    } as unknown as AsyncGenerator<GatewayMessage>
  }
}

export async function connectSocket(socketPath: string): Promise<Connection> {
  const socket = await createSocketConnection(socketPath)
  socket.on('error', () => {
    // Prevent unhandled crashes from background socket issues
  })
  return {
    send: (message: string) => {
      if (socket.writable) {
        socket.write(JSON.stringify({ message }) + '\n')
      }
    },
    receive: buildReceive(socket),
    getStderr: () => '',
    kill: () => {
      try { socket.end() } catch {}
    },
    exited: new Promise(() => {}),
    child: null,
  }
}

export function connect(options: ConnectionOptions): Connection {
  const { entrypoint } = options

  if (options.transport === 'socket') {
    const socketPath = options.socketPath!
    const child = spawn('bun', ['run', entrypoint], {
      stdio: 'ignore',
      detached: true,
      cwd: options.spawnCwd,
      env: {
        ...process.env,
        AGENT_ID: options.agentId,
        LUNA_TRANSPORT: 'socket',
        LUNA_SOCKET_PATH: socketPath,
        LUNA_CWD: options.workspaceCwd ?? options.spawnCwd ?? process.cwd(),
      },
    })
    child.unref()

    const connectPromise = waitForSocket(socketPath).then(() => createSocketConnection(socketPath))

    // On connection failure, close the receive stream so the consumer isn't stuck forever
    const onConnFail = () => {
      // The send/receive .then callbacks never ran, so the consumer is stuck.
      // We flag an error via closed=true so next() returns done.
    }

    return {
      send(message: string) {
        connectPromise.then(
          (socket) => {
            if (socket.writable) {
              socket.write(JSON.stringify({ message }) + '\n')
            }
          },
          () => {},  // connect failed — silent drop (caller handles via receive)
        )
      },
      receive() {
        const buffer: string[] = []
        let pending: ((value: IteratorResult<GatewayMessage>) => void) | null = null
        let closed = false
        let connFailed = false

        connectPromise.then(
          (s) => {
            s.on('error', () => {
              // Prevent unhandled socket exceptions on the connection
            })
            const rl = createInterface({ input: s })
            rl.on('line', (line: string) => {
              if (pending) {
                const p = pending
                pending = null
                try { p({ value: JSON.parse(line), done: false }) }
                catch { p({ value: { type: 'error', error: line }, done: false }) }
              } else {
                buffer.push(line)
              }
            })
            rl.on('close', () => {
              closed = true
              if (pending) pending({ value: undefined as any, done: true })
            })
          },
          () => {
            connFailed = true
            closed = true
            if (pending) pending({ value: undefined as any, done: true })
          },
        )

        return {
          [Symbol.asyncIterator]() { return this },
          next(): Promise<IteratorResult<GatewayMessage>> {
            if (buffer.length > 0) {
              const line = buffer.shift()!
              try { return Promise.resolve({ value: JSON.parse(line), done: false }) }
              catch { return Promise.resolve({ value: { type: 'error', error: line }, done: false }) }
            }
            if (closed) return Promise.resolve({ value: undefined as any, done: true })
            return new Promise((resolve) => { pending = resolve })
          },
          return(): Promise<IteratorResult<GatewayMessage>> {
            pending = null
            return Promise.resolve({ value: undefined as any, done: true })
          },
        } as unknown as AsyncGenerator<GatewayMessage>
      },
      getStderr: () => '',
      kill: () => child.kill(),
      exited: new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code))),
      child,
    }
  }

  const child: ChildProcess = spawn('bun', ['run', entrypoint], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.spawnCwd,
    env: {
      ...process.env,
      AGENT_ID: options.agentId,
      LUNA_CWD: options.workspaceCwd ?? options.spawnCwd ?? process.cwd(),
    },
  })

  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

  const rl = createInterface({ input: child.stdout! })

  function send(message: string) {
    child.stdin!.write(JSON.stringify({ message }) + '\n')
  }

  function receive(): AsyncGenerator<GatewayMessage> {
    const buffer: string[] = []
    let pending: ((value: IteratorResult<GatewayMessage>) => void) | null = null
    let closed = false

    rl.on('line', (line: string) => {
      if (pending) {
        const p = pending
        pending = null
        try {
          p({ value: JSON.parse(line), done: false })
        } catch {
          p({ value: { type: 'error', error: line }, done: false })
        }
      } else {
        buffer.push(line)
      }
    })

    rl.on('close', () => {
      closed = true
      if (pending) {
        pending({ value: undefined as any, done: true })
      }
    })

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next(): Promise<IteratorResult<GatewayMessage>> {
        if (buffer.length > 0) {
          const line = buffer.shift()!
          try {
            return Promise.resolve({ value: JSON.parse(line), done: false })
          } catch {
            return Promise.resolve({ value: { type: 'error', error: line }, done: false })
          }
        }
        if (closed) {
          return Promise.resolve({ value: undefined as any, done: true })
        }
        return new Promise((resolve) => {
          pending = resolve
        })
      },
      return(): Promise<IteratorResult<GatewayMessage>> {
        pending = null
        return Promise.resolve({ value: undefined as any, done: true })
      },
    } as unknown as AsyncGenerator<GatewayMessage>
  }

  function getStderr(): string {
    return Buffer.concat(stderrChunks).toString()
  }

  function kill() {
    child.kill()
  }

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code))
  })

  return { send, receive, getStderr, kill, exited, child }
}
