import type { Connection } from 'luna-gateway'

export interface RawMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  thinkingExpanded?: boolean
  error?: boolean
  preprocessedContent?: string
  lastPreprocessedSource?: string
}

export interface AgentMeta {
  name: string
  pid: number | null
  createdAt: string
  cwd?: string
}

export interface AgentData {
  id: string
  meta: AgentMeta
  messages: RawMessage[]
  conn: Connection | null
  isRunning: boolean
  isBusy: boolean
  streamFrame: string
  diffLines: string[]
  namingPromise: Promise<void> | null
  animTimer: ReturnType<typeof setInterval> | null
  anim: any | null
  timeout: ReturnType<typeof setTimeout> | null
}
