import type { TextRenderable, MarkdownRenderable } from "@opentui/core"
import type { GitDiffSection, GitFileChange } from '../git-activity'

export const MSG_BG = {
  user: '#20283a',
  assistant: '#1a1b26',
  thoughts: '#1e1d2e',
  system: '#1e2030',
  error: '#2a1520',
} as const

export type MessageRole = keyof typeof MSG_BG
export type BodyMode = 'text' | 'markdown'

export type MessageBlock = {
  key: string
  boxId: string
  role: MessageRole
  mode: BodyMode
  content: string
  body: TextRenderable | MarkdownRenderable
  box: any
}

export type GitActivityBlock = {
  key: string
  boxId: string
  path: string
  status: string
  sections: GitDiffSection[]
  expanded: boolean
  header: TextRenderable
  body: any
  box: any
}

export const slashCommands = [
  { command: '/clear', description: 'Clear the active conversation' },
  { command: '/reset', description: 'Reset the active agent to the boilerplate entrypoint' },
  { command: '/debug', description: 'Copy conversation and activity diagnostics' },
  { command: '/thought', description: 'Toggle the latest thinking block' },
  { command: '/t', description: 'Alias for /thought' },
  { command: '/thought <n>', description: 'Toggle a specific assistant thinking block' },
  { command: '/t <n>', description: 'Alias for /thought <n>' },
]

export type { GitDiffSection, GitFileChange }
