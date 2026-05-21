import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer as createNetServer, createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { unlinkSync } from 'node:fs'

export type GatewayMessage =
  | { type: 'token'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; name: string; args: string; diff?: string }
  | { type: 'tool_result'; name: string; result: string; toolCallId?: string }
  | { type: 'done' }
  | { type: 'error'; error: string }

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

function parseGatewayMessage(line: string): GatewayMessage {
  try {
    const parsed = JSON.parse(line)
    if (isGatewayMessage(parsed)) {
      return parsed
    }
  } catch {}
  return { type: 'error', error: line }
}

function isGatewayMessage(value: unknown): value is GatewayMessage {
  if (!value || typeof value !== 'object') return false
  const msg = value as Record<string, unknown>
  switch (msg.type) {
    case 'token':
    case 'reasoning':
      return typeof msg.content === 'string'
    case 'tool_call':
      return typeof msg.name === 'string'
        && typeof msg.args === 'string'
        && (msg.diff === undefined || typeof msg.diff === 'string')
    case 'tool_result':
      return typeof msg.name === 'string'
        && typeof msg.result === 'string'
        && (msg.toolCallId === undefined || typeof msg.toolCallId === 'string')
    case 'done':
      return true
    case 'error':
      return typeof msg.error === 'string'
    default:
      return false
  }
}

function createReceiveQueue(): {
  pushLine: (line: string) => void
  close: () => void
  receive: () => AsyncGenerator<GatewayMessage>
} {
  const buffer: GatewayMessage[] = []
  const waiters: Array<(value: IteratorResult<GatewayMessage>) => void> = []
  let closed = false

  function push(value: GatewayMessage) {
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
    } else {
      buffer.push(value)
    }
  }

  function close() {
    closed = true
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined as any, done: true })
    }
  }

  function receive(): AsyncGenerator<GatewayMessage> {
    return {
      [Symbol.asyncIterator]() { return this },
      next(): Promise<IteratorResult<GatewayMessage>> {
        if (buffer.length > 0) {
          return Promise.resolve({ value: buffer.shift()!, done: false })
        }
        if (closed) return Promise.resolve({ value: undefined as any, done: true })
        return new Promise((resolve) => { waiters.push(resolve) })
      },
      return(): Promise<IteratorResult<GatewayMessage>> {
        return Promise.resolve({ value: undefined as any, done: true })
      },
    } as unknown as AsyncGenerator<GatewayMessage>
  }

  return {
    pushLine: (line) => push(parseGatewayMessage(line)),
    close,
    receive,
  }
}

function buildReceive(socket: Socket): () => AsyncGenerator<GatewayMessage> {
  const queue = createReceiveQueue()
  const rl = createInterface({ input: socket })
  rl.on('line', queue.pushLine)
  rl.on('close', queue.close)
  return queue.receive
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
    const queue = createReceiveQueue()
    connectPromise.then(
      (socket) => {
        socket.on('error', () => {
          // Prevent unhandled socket exceptions on the connection
        })
        const rl = createInterface({ input: socket })
        rl.on('line', queue.pushLine)
        rl.on('close', queue.close)
      },
      () => queue.close(),
    )

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
      receive: queue.receive,
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
  const queue = createReceiveQueue()
  rl.on('line', queue.pushLine)
  rl.on('close', queue.close)

  function send(message: string) {
    child.stdin!.write(JSON.stringify({ message }) + '\n')
  }

  const receive = queue.receive

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
