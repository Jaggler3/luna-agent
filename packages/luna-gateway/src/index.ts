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

  async function* receive(): AsyncGenerator<GatewayMessage> {
    for await (const line of rl) {
      try {
        yield JSON.parse(line)
      } catch {
        yield { type: 'error', error: line }
      }
    }
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
