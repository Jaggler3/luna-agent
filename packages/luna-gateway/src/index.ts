import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type GatewayMessage = Record<string, unknown>

export interface ServerOptions {
  agentId: string
  handler: (prompt: string, emit: (msg: GatewayMessage) => void) => Promise<void>
}

export function createServer(options: ServerOptions) {
  const { handler } = options

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
}

export interface Connection {
  send: (message: string) => void
  receive: () => AsyncGenerator<GatewayMessage>
  getStderr: () => string
  kill: () => void
  exited: Promise<number | null>
  child: ChildProcess
}

export function connect(options: ConnectionOptions): Connection {
  const { entrypoint } = options

  const child: ChildProcess = spawn('bun', ['run', entrypoint], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_ID: options.agentId },
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
    } as AsyncGenerator<GatewayMessage>
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
