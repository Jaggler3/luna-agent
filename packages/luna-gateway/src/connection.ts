import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import type { Connection, ConnectionOptions } from './types'
import { createReceiveQueue, buildReceive } from './queue'

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

export async function connectSocket(socketPath: string): Promise<Connection> {
  const socket = await createSocketConnection(socketPath)
  socket.on('error', () => {})
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
        socket.on('error', () => {})
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
          () => {},
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
