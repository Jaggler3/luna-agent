import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type GatewayMessage = Record<string, unknown>

export interface ServerOptions {
  agentId: string
  handler: (prompt: string, emit: (msg: GatewayMessage) => void) => Promise<string>
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
        const response = await handler(message, emit)
        process.stdout.write(JSON.stringify({ response }) + '\n')
      } catch (err) {
        process.stdout.write(JSON.stringify({ error: String(err) }) + '\n')
      }
    }
  }

  return { listen }
}

export interface ConnectionOptions {
  agentId: string
  entrypoint: string
}

export function connect(options: ConnectionOptions) {
  const { entrypoint } = options

  const child: ChildProcess = spawn('bun', ['run', entrypoint], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_ID: options.agentId },
  })

  child.stderr?.pipe(process.stderr)

  const rl = createInterface({ input: child.stdout! })

  function send(message: string) {
    child.stdin!.write(JSON.stringify({ message }) + '\n')
  }

  async function* receive(): AsyncGenerator<GatewayMessage> {
    for await (const line of rl) {
      try {
        yield JSON.parse(line)
      } catch {
        yield { response: line }
      }
    }
  }

  return { send, receive, child }
}
