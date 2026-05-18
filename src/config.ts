import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, appendFileSync } from 'node:fs'
import { SyntaxStyle } from '@opentui/core'

export const LOG_FILE = join(homedir(), '.luna-code', 'harness.log')
export const AGENTS_DIR = join(homedir(), '.luna-code', 'agents')

mkdirSync(AGENTS_DIR, { recursive: true })

export function log(...args: unknown[]) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
    appendFileSync(LOG_FILE, line + '\n')
  } catch { }
}

export const theme = {
  bg: "#1a1b26",
  fg: "#a9b1d6",
  border: "#414868",
  blue: "#7aa2f7",
  purple: "#bb9af7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
  comment: "#565f89",
  bgHighlight: "#292e42",
}

export const syntaxStyle = SyntaxStyle.fromStyles({
  'markup.heading.1': { fg: theme.blue, bold: true },
  'markup.heading.2': { fg: theme.blue, bold: true },
  'markup.heading.3': { fg: theme.blue, bold: true },
  'markup.bold': { bold: true },
  'markup.italic': { italic: true },
  'markup.strikethrough': { fg: theme.comment },
  'markup.inline.code': { fg: theme.cyan },
  'markup.code': { fg: theme.cyan },
  'markup.link': { fg: theme.blue, underline: true },
  'markup.quote': { fg: theme.comment, bg: theme.bgHighlight },
  'markup.list': { fg: theme.blue },
  'markup.horizontal_rule': { fg: theme.comment },
})
