import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SyntaxStyle } from '@opentui/core'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

export const LOG_FILE = join(homedir(), '.luna-code', 'harness.log')
export const AGENTS_DIR = join(homedir(), '.luna-code', 'agents')
export const APP_ROOT = resolve(SRC_DIR, '..')

mkdirSync(AGENTS_DIR, { recursive: true })

export function log(...args: unknown[]) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
    appendFileSync(LOG_FILE, line + '\n')
  } catch { }
}

export function currentWorkspaceCwd(): string {
  return process.env.LUNA_CWD ?? process.cwd()
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
  'keyword': { fg: theme.purple, bold: true },
  'keyword.directive': { fg: theme.cyan, bold: true },
  'string': { fg: theme.green },
  'string.escape': { fg: theme.yellow },
  'string.regexp': { fg: theme.cyan },
  'number': { fg: theme.yellow },
  'boolean': { fg: theme.purple, bold: true },
  'constant': { fg: theme.cyan },
  'constant.builtin': { fg: theme.cyan, bold: true },
  'function': { fg: theme.blue },
  'function.call': { fg: theme.blue },
  'function.method': { fg: theme.blue },
  'function.method.call': { fg: theme.blue },
  'constructor': { fg: theme.yellow },
  'variable': { fg: theme.fg },
  'variable.builtin': { fg: theme.cyan },
  'variable.member': { fg: theme.yellow },
  'property': { fg: theme.yellow },
  'label': { fg: theme.blue },
  'operator': { fg: theme.comment },
  'punctuation.delimiter': { fg: theme.comment },
  'punctuation.bracket': { fg: theme.comment },
  'punctuation.special': { fg: theme.comment },
  'attribute': { fg: theme.green },
  'comment': { fg: theme.comment, italic: true },
  'comment.documentation': { fg: theme.comment, italic: true },
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
