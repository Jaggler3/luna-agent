import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { ToolDef, ToolCall } from './types'

const execAsync = promisify(exec)
function getCWD(): string {
  return process.env.LUNA_CWD ?? process.cwd()
}



export const TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read the contents of a file', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the file' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write content to a file (creates directories if needed)', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the file' }, content: { type: 'string', description: 'File content' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace exact string match in a file with new content', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the file' }, oldString: { type: 'string', description: 'Exact text to replace' }, newString: { type: 'string', description: 'Replacement text' } }, required: ['path', 'oldString', 'newString'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command and get its output. Commands that do not exit within 30 seconds will be killed. Avoid commands that start long-running servers; ensure tests clean up server processes in afterAll/teardown.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Command to run' }, description: { type: 'string', description: 'Short description of the command' } }, required: ['command', 'description'] } } },
  { type: 'function', function: { name: 'glob', description: 'Search for files matching a glob pattern', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.ts)' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'search', description: 'Search file contents under a path for plain text', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File or directory path to search in' }, query: { type: 'string', description: 'Plain text to search for' } }, required: ['path', 'query'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents with a regex pattern', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern to search for' }, include: { type: 'string', description: 'File glob to filter (e.g. *.ts)' } }, required: ['pattern'] } } },
]

function resolvePath(p: string): string {
  return join(getCWD(), p)
}

function truncateToolResult(result: string): string {
  const maxChars = 24_000
  if (result.length <= maxChars) return result
  return `${result.slice(0, maxChars)}\n\n[tool result truncated: ${result.length - maxChars} more characters]`
}

function isHiddenPath(path: string): boolean {
  return /(^|\/)(node_modules|dist|\.git|\.next|\.cache)(\/|$)/.test(path)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeToolName(name: string): string | null {
  const known = new Set(TOOLS.map((tool) => tool.function.name))
  return known.has(name) ? name : null
}

export function parseToolArgs(argsStr: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(argsStr)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

export function normalizeToolCall(tc: ToolCall, index = 0): ToolCall | null {
  const normalized = normalizeToolName(tc.function.name)
  if (!normalized) return null
  const args = parseToolArgs(tc.function.arguments)
  if (!args) return null
  return {
    id: tc.id || `call_${index}`,
    type: 'function',
    function: { name: normalized, arguments: JSON.stringify(args) },
  }
}

export function makeToolCall(name: string, args: Record<string, unknown>, index = 0): ToolCall | null {
  const normalized = normalizeToolName(name)
  if (!normalized) return null
  return {
    id: `text_call_${Date.now()}_${index}`,
    type: 'function',
    function: { name: normalized, arguments: JSON.stringify(args) },
  }
}

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null
  try { return JSON.parse(candidate) } catch { return null }
}

export function coerceTextToolCall(content: string): ToolCall[] | undefined {
  const parsed = extractJsonObject(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const obj = parsed as Record<string, any>
  const rawName = obj.name ?? obj.tool ?? obj.function?.name ?? obj.function
  const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? obj.function?.arguments

  if (typeof rawName === 'string') {
    const args = typeof rawArgs === 'string'
      ? (() => { try { return JSON.parse(rawArgs) } catch { return null } })()
      : rawArgs
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const call = makeToolCall(rawName, args)
      return call ? [call] : undefined
    }
  }

  if (typeof obj.command === 'string') {
    const call = makeToolCall('bash', { command: obj.command, description: typeof obj.description === 'string' ? obj.description : 'run command' })
    return call ? [call] : undefined
  }

  return undefined
}

async function searchFiles(rootPath: string, query: string): Promise<string> {
  const fullRoot = resolvePath(rootPath)
  const results: string[] = []
  const re = new RegExp(escapeRegExp(query), 'i')
  let count = 0

  async function scanFile(file: string) {
    if (count >= 100 || isHiddenPath(file)) return
    const fullPath = resolvePath(file)
    try {
      if (statSync(fullPath).isDirectory()) return
      const content = readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${file}:${i + 1}: ${lines[i].trim()}`)
          count++
          if (count >= 100) break
        }
      }
    } catch { }
  }

  try {
    if (statSync(fullRoot).isFile()) {
      await scanFile(rootPath)
    } else {
      const g = new Bun.Glob(`${rootPath.replace(/\/$/, '')}/**/*`)
        for await (const file of g.scan({ cwd: getCWD() })) {

        await scanFile(file)
        if (count >= 100) break
      }
    }
  } catch { return `(path not found: ${rootPath})` }

  return results.join('\n') || '(no matches)'
}

export async function executeTool(tc: ToolCall): Promise<string> {
  const { name, arguments: argsStr } = tc.function
  const args = JSON.parse(argsStr)

  try {
    switch (name) {
      case 'read_file': {
        return readFileSync(resolvePath(args.path), 'utf-8')
      }
      case 'write_file': {
        const fullPath = resolvePath(args.path)
        const dir = fullPath.slice(0, fullPath.lastIndexOf('/'))
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(fullPath, args.content, 'utf-8')
        return `written ${args.path}`
      }
      case 'edit_file': {
        const fullPath = resolvePath(args.path)
        const content = readFileSync(fullPath, 'utf-8')
        const occurrences = content.split(args.oldString).length - 1
        if (occurrences === 0) throw new Error(`oldString not found in ${args.path}`)
        if (occurrences > 1) throw new Error(`oldString is not unique! Found ${occurrences} occurrences in ${args.path}. Please provide a larger block of unique context.`)
        writeFileSync(fullPath, content.replace(args.oldString, args.newString), 'utf-8')
        return `edited ${args.path}`
      }
      case 'bash': {
        const cmd = String(args.command ?? '')
        if (!cmd.trim()) return '(empty command)'
        if (cmd.length > 16_384) return '(command too long)'
        const dangerous = /(\brm\s+[-][^]*?\b\/\s)|(\bmv\s+\/\s)|(\bsudo\b)|(>\s*\/dev\/(sda|sdb|sdc|nvme|disk))|(:\(\)\s*\{.*:\s*\|:\s*\})/.test(cmd)
        if (dangerous) return '(command rejected: potentially destructive)'
        try {
            const { stdout, stderr } = await execAsync(cmd, { cwd: getCWD(), maxBuffer: 10 * 1024 * 1024, timeout: 30_000 })

          return stdout || stderr || '(no output)'
        } catch (err: any) {
          if (err.killed || err.signal === 'SIGTERM' || String(err.message).includes('timed out')) {
            const partial = err.stdout ? `\nPartial output:\n${err.stdout}` : ''
            return `command timed out after 30s (process was still running — it may be a long-running server or hanging test). If this is a test command that starts a server, ensure the server is stopped after tests, or run it in the background.${partial}`.trim()
          }
          const out = err.stdout ? `stdout:\n${err.stdout}` : ''
          const errorText = err.stderr ? `stderr:\n${err.stderr}` : ''
          return `command failed with exit code ${err.code || 1}\n${out}\n${errorText}`.trim()
        }
      }
      case 'glob': {
        const g = new Bun.Glob(args.pattern)
        const matches: string[] = []
        for await (const match of g.scan({ cwd: getCWD() })) matches.push(match)
        return matches.join('\n') || '(no matches)'
      }
      case 'search': {
        return await searchFiles(args.path ?? '.', args.query ?? '')
      }
      case 'grep': {
        const { pattern, include } = args
        const g = new Bun.Glob(include ?? '**/*')
        const results: string[] = []
        const re = new RegExp(pattern)
        let count = 0
    for await (const file of g.scan({ cwd: getCWD() })) {

          if (count >= 100) break
          const fullPath = resolvePath(file)
          try {
            if (statSync(fullPath).isDirectory()) continue
            if (isHiddenPath(file)) continue
            const content = readFileSync(fullPath, 'utf-8')
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                results.push(`${file}:${i + 1}: ${lines[i].trim()}`)
                count++
                if (count >= 100) break
              }
            }
          } catch { }
        }
        return results.join('\n') || '(no matches)'
      }
      default:
        return `unknown tool: ${name}`
    }
  } catch (err) {
    return `error: ${err}`
  }
}
