import type { ChildProcess } from 'node:child_process'

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

export function isGatewayMessage(value: unknown): value is GatewayMessage {
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

export function parseGatewayMessage(line: string): GatewayMessage {
  try {
    const parsed = JSON.parse(line)
    if (isGatewayMessage(parsed)) {
      return parsed
    }
  } catch {}
  return { type: 'error', error: line }
}
