import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execAsync = promisify(exec)

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const MODEL = process.env.LUNA_MODEL ?? 'gpt-oss:20b-cloud'
const CWD = process.env.LUNA_CWD ?? process.cwd()

interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates directories if needed)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace exact string match in a file with new content',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          oldString: { type: 'string', description: 'Exact text to replace' },
          newString: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command and get its output',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
          description: { type: 'string', description: 'Short description of the command' },
        },
        required: ['command', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Search for files matching a glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.ts)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search file contents under a path for plain text',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path to search in' },
          query: { type: 'string', description: 'Plain text to search for' },
        },
        required: ['path', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regex pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          include: { type: 'string', description: 'File glob to filter (e.g. *.ts)' },
        },
        required: ['pattern'],
      },
    },
  },
]

function buildSystemPrompt(): string {
  const parts: string[] = [
    `You are luna, a coding agent. You have access to tools that let you read, write, and edit files, run commands, and search code.`,
    ``,
    `## Working context`,
    `Working directory: ${CWD}`,
  ]

  try {
    const entries = readdirSync(CWD)
    const filtered = entries.filter((e) => !/^(node_modules|\.git|dist|\.next|\.cache|\.DS_Store)$/.test(e))
    if (filtered.length > 0) {
      parts.push(`Top-level contents:`)
      for (const e of filtered) {
        const full = join(CWD, e)
        const suffix = statSync(full).isDirectory() ? '/' : ''
        parts.push(`  ${e}${suffix}`)
      }
    }
    const pkgPath = join(CWD, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        const info: string[] = []
        if (pkg.name) info.push(`name: ${pkg.name}`)
        if (pkg.scripts) info.push(`scripts: ${Object.keys(pkg.scripts).join(', ')}`)
        if (pkg.description) info.push(`description: ${pkg.description}`)
        if (info.length) parts.push(`package.json: ${info.join(' | ')}`)
      } catch {}
    }
  } catch {}

  parts.push(
    ``,
    `All file paths in tools are relative to the working directory.`,
    ``,
    `## Rules`,
    `- Use tools to investigate and make changes as needed`,
    `- When you need to inspect files, search code, or run commands, call the appropriate tool. Do not describe the tool call in prose.`,
    `- Do not answer with an investigation plan like "I need to search" or "Let's inspect"; perform the tool call instead.`,
    `- After receiving tool results, synthesize them into a final response for the user`,
    `- Do NOT keep calling tools indefinitely. Once you have enough information, stop and answer.`,
    `- After making a change, verify it with an appropriate project command whenever possible.`,
    `- When you are done, provide a brief summary of what you did`,
    `- Be decisive. If the user says "implement it" and you just suggested a feature, implement it without asking for clarification.`,
    `- Never include internal deliberation, uncertainty, or "maybe" style reasoning in your responses. If you are unsure, ask a brief (1-2 sentence) clarifying question.`,
    `- Be concise. Keep responses short and to the point. Avoid lengthy explanations unless asked.`,
    `- Use concise bullet-point lists instead of tables when presenting structured information. Tables are hard to read in a terminal.`,
    ``,
    `## Code editing standards`,
    `- Make functional changes, not marker changes. If asked to remove something, delete the code and any now-unused helpers/imports/styles; do not replace it with a comment, placeholder, TODO, disabled block, or dead stub.`,
    `- Do not add comments explaining that code was removed or changed. Comments should explain non-obvious remaining code only.`,
    `- Preserve existing style and structure. Keep edits scoped to the user's request and avoid unrelated rewrites.`,
    `- After removing or renaming code, search for exact leftover references to every removed symbol, handler, label, CSS class, import, and rendered text. Fix any leftovers before answering.`,
    `- Prefer the smallest complete fix that leaves the app in a working state. If a change affects UI layout or behavior, update all connected state, event handlers, and rendering code.`,
    `- Run the narrowest available verification command after edits. Prefer lint or typecheck first, then targeted tests, then build. Use package scripts when present, such as lint, typecheck, test, or build.`,
    `- Do not claim a code change is complete until verification has run or you have a concrete reason it could not run. If verification fails, fix related failures before answering; otherwise report the exact failure and whether it appears related to your change.`,
    ``,
    `## Available tools`,
    `${TOOLS.map((t) => `  - ${t.function.name}: ${t.function.description}`).join('\n')}`,
  )

  return parts.join('\n')
}

interface StreamCallbacks {
  onToken?: (t: string) => void
  onReasoning?: (t: string) => void
}

async function callOllamaStream(
  messages: Msg[],
  callbacks?: StreamCallbacks
): Promise<{ content: string; toolCalls?: ToolCall[] }> {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      stream: true,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ollama error (${res.status}): ${text}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCallsMap = new Map<number, ToolCall>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') continue

      try {
        const parsed = JSON.parse(data)
        const choice = parsed.choices?.[0]
        if (!choice) continue

        const delta = choice.delta
        if (!delta) continue

        if (delta.reasoning) {
          callbacks?.onReasoning?.(delta.reasoning)
        }
        if (delta.content) {
          content += delta.content
          // Only stream content live if this chunk has no tool_calls
          // (models often put tool call JSON in both fields)
          if (!delta.tool_calls) {
            callbacks?.onToken?.(delta.content)
          }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0
            if (!toolCallsMap.has(index)) {
              toolCallsMap.set(index, {
                id: tc.id || `call_${index}`,
                type: 'function',
                function: { name: '', arguments: '' },
              })
            }
            const existing = toolCallsMap.get(index)!
            if (tc.function?.name) existing.function.name += tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
            if (tc.id) existing.id = tc.id
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  const toolCalls = toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined
  return { content, toolCalls }
}

function normalizeToolName(name: string): string | null {
  const known = new Set(TOOLS.map((tool) => tool.function.name))
  return known.has(name) ? name : null
}

function parseToolArgs(argsStr: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(argsStr)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeToolCall(tc: ToolCall, index = 0): ToolCall | null {
  const normalized = normalizeToolName(tc.function.name)
  if (!normalized) return null

  const args = parseToolArgs(tc.function.arguments)
  if (!args) return null

  return {
    id: tc.id || `call_${index}`,
    type: 'function',
    function: {
      name: normalized,
      arguments: JSON.stringify(args),
    },
  }
}

function makeToolCall(name: string, args: Record<string, unknown>, index = 0): ToolCall | null {
  const normalized = normalizeToolName(name)
  if (!normalized) return null
  return {
    id: `text_call_${Date.now()}_${index}`,
    type: 'function',
    function: {
      name: normalized,
      arguments: JSON.stringify(args),
    },
  }
}

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function coerceTextToolCall(content: string): ToolCall[] | undefined {
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
    const call = makeToolCall('bash', {
      command: obj.command,
      description: typeof obj.description === 'string' ? obj.description : 'run command',
    })
    return call ? [call] : undefined
  }

  return undefined
}

function looksLikeUnexecutedInvestigation(content: string, reasoning?: string): boolean {
  const text = `${reasoning ?? ''}\n${content}`.toLowerCase()
  if (!text.trim()) return false

  const investigationSignals = [
    /\bwe need to\b/,
    /\bi need to\b/,
    /\blet'?s\b/,
    /\bsearch\b/,
    /\binspect\b/,
    /\bread\b/,
    /\blist\b/,
    /\bopen\b/,
    /\bfind\b/,
    /\bgrep\b/,
    /\bglob\b/,
    /\bbash\b/,
    /\brun\b/,
  ]

  const completionSignals = [
    /\bimplemented\b/,
    /\bfixed\b/,
    /\bupdated\b/,
    /\bcreated\b/,
    /\bverified\b/,
    /\bno code changes\b/,
    /\bi can'?t\b/,
    /\bnot able\b/,
  ]

  return investigationSignals.some((pattern) => pattern.test(text))
    && !completionSignals.some((pattern) => pattern.test(text))
}

function resolvePath(p: string): string {
  return join(CWD, p)
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
    } catch {
      // skip unreadable/binary files
    }
  }

  try {
    if (statSync(fullRoot).isFile()) {
      await scanFile(rootPath)
    } else {
      const g = new Bun.Glob(`${rootPath.replace(/\/$/, '')}/**/*`)
      for await (const file of g.scan({ cwd: CWD })) {
        await scanFile(file)
        if (count >= 100) break
      }
    }
  } catch {
    return `(path not found: ${rootPath})`
  }

  return results.join('\n') || '(no matches)'
}

async function executeTool(tc: ToolCall): Promise<string> {
  const { name, arguments: argsStr } = tc.function
  const args = JSON.parse(argsStr)

  try {
    switch (name) {
      case 'read_file': {
        const content = readFileSync(resolvePath(args.path), 'utf-8')
        return content
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
        if (occurrences === 0) {
          throw new Error(`oldString not found in ${args.path}`)
        }
        if (occurrences > 1) {
          throw new Error(`oldString is not unique! Found ${occurrences} occurrences in ${args.path}. Please provide a larger block of unique context.`)
        }
        const updated = content.replace(args.oldString, args.newString)
        writeFileSync(fullPath, updated, 'utf-8')
        return `edited ${args.path}`
      }
      case 'bash': {
        try {
          const { stdout, stderr } = await execAsync(args.command, {
            cwd: CWD,
            maxBuffer: 10 * 1024 * 1024,
          })
          return stdout || stderr || '(no output)'
        } catch (err: any) {
          const out = err.stdout ? `stdout:\n${err.stdout}` : ''
          const errorText = err.stderr ? `stderr:\n${err.stderr}` : ''
          return `command failed with exit code ${err.code || 1}\n${out}\n${errorText}`.trim()
        }
      }
      case 'glob': {
        const g = new Bun.Glob(args.pattern)
        const matches: string[] = []
        for await (const match of g.scan({ cwd: CWD })) {
          matches.push(match)
        }
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
        for await (const file of g.scan({ cwd: CWD })) {
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
          } catch {
            // skip unreadable
          }
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

export interface SimpleRunCallbacks {
  onToolCall?: (name: string, args: string, diff?: string) => void
  onToolResult?: (name: string, result: string, toolCallId: string) => void
  onToken?: (token: string) => void
  onReasoning?: (chunk: string) => void
}

export async function simpleRun(prompt: string, callbacks?: SimpleRunCallbacks): Promise<void> {
  const messages: Msg[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: prompt },
  ]

  const maxIterations = 25
  let missingToolRetries = 0
  let executedToolCount = 0

  for (let i = 0; i < maxIterations; i++) {
    let content = ''
    let toolCalls: ToolCall[] | undefined
    try {
      const result = await callOllamaStream(messages, {
        onToken: callbacks?.onToken,
        onReasoning: callbacks?.onReasoning,
      })
      content = result.content
      toolCalls = result.toolCalls
    } catch (err) {
      if (executedToolCount > 0) {
        callbacks?.onToken?.(`I ran ${executedToolCount} tool call${executedToolCount === 1 ? '' : 's'}, but the model failed while synthesizing the result: ${String(err)}`)
        return
      }
      throw err
    }

    const effectiveToolCalls = (toolCalls ?? coerceTextToolCall(content))
      ?.map((tc, index) => normalizeToolCall(tc, index))
      .filter((tc): tc is ToolCall => tc !== null)

    if (effectiveToolCalls && effectiveToolCalls.length > 0) {
      const assistantMsg: Msg = { role: 'assistant', content, tool_calls: effectiveToolCalls }
      messages.push(assistantMsg)

      for (const tc of effectiveToolCalls) {
        let diff: string | undefined
        if (tc.function.name === 'write_file' || tc.function.name === 'edit_file') {
          try {
            const args = JSON.parse(tc.function.arguments)
            const fullPath = resolvePath(args.path)
            let oldContent = ''
            if (existsSync(fullPath)) {
              oldContent = readFileSync(fullPath, 'utf-8')
            }
            let newContent = ''
            if (tc.function.name === 'write_file') {
              newContent = args.content
            } else if (tc.function.name === 'edit_file') {
              if (oldContent.includes(args.oldString)) {
                newContent = oldContent.replace(args.oldString, args.newString)
              } else {
                newContent = oldContent
              }
            }
            diff = generateDiff(args.path, oldContent, newContent)
          } catch (e) {
            // silent catch
          }
        }

        callbacks?.onToolCall?.(tc.function.name, tc.function.arguments, diff)
        const result = truncateToolResult(await executeTool(tc))
        callbacks?.onToolResult?.(tc.function.name, result, tc.id)
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
        executedToolCount++
      }
      continue
    }

    if (looksLikeUnexecutedInvestigation(content) && missingToolRetries < 2) {
      missingToolRetries++
      messages.push({ role: 'assistant', content })
      messages.push({
        role: 'user',
        content: 'You described an investigation step but did not call a tool. Call read_file, grep, glob, or bash now. Do not narrate the search.',
      })
      continue
    }

    return
  }
}

export function generateDiff(path: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent ? oldContent.split(/\r?\n/) : []
  const newLines = newContent ? newContent.split(/\r?\n/) : []
  
  const m = oldLines.length
  const n = newLines.length
  
  if (m > 1000 || n > 1000) {
    return `--- a/${path}\n+++ b/${path}\n@@ -1,${m} +1,${n} @@\n[File too large to diff - showing replacement]\n- ${oldLines.slice(0, 5).join('\n- ')}\n...\n+ ${newLines.slice(0, 5).join('\n+ ')}\n...`
  }
  
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1) as any)
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }
  
  interface DiffItem {
    type: 'added' | 'removed' | 'unchanged'
    value: string
    oldLineNum: number
    newLineNum: number
  }
  
  const diffItems: DiffItem[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffItems.unshift({ type: 'unchanged', value: oldLines[i - 1], oldLineNum: i, newLineNum: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffItems.unshift({ type: 'added', value: newLines[j - 1], oldLineNum: -1, newLineNum: j })
      j--
    } else {
      diffItems.unshift({ type: 'removed', value: oldLines[i - 1], oldLineNum: i, newLineNum: -1 })
      i--
    }
  }
  
  const contextSize = 3
  const hunks: string[] = []
  let currentHunk: DiffItem[] = []
  
  for (let k = 0; k < diffItems.length; k++) {
    const item = diffItems[k]
    if (item.type !== 'unchanged') {
      const startIdx = Math.max(0, k - contextSize)
      if (currentHunk.length > 0) {
        const lastItemIdx = diffItems.indexOf(currentHunk[currentHunk.length - 1])
        if (startIdx <= lastItemIdx) {
          for (let idx = lastItemIdx + 1; idx <= k; idx++) {
            currentHunk.push(diffItems[idx])
          }
          continue
        } else {
          hunks.push(formatHunk(currentHunk))
          currentHunk = []
        }
      }
      for (let idx = startIdx; idx <= k; idx++) {
        currentHunk.push(diffItems[idx])
      }
    } else if (currentHunk.length > 0) {
      const lastChangeIdx = findLastChangeIdx(diffItems, currentHunk)
      const currentIdxInDiff = k
      if (currentIdxInDiff - lastChangeIdx <= contextSize) {
        currentHunk.push(item)
      } else {
        hunks.push(formatHunk(currentHunk))
        currentHunk = []
      }
    }
  }
  
  if (currentHunk.length > 0) {
    hunks.push(formatHunk(currentHunk))
  }
  
  if (hunks.length === 0) {
    return ''
  }
  
  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`
}

function findLastChangeIdx(diffItems: any[], hunk: any[]): number {
  for (let i = hunk.length - 1; i >= 0; i--) {
    if (hunk[i].type !== 'unchanged') {
      return diffItems.indexOf(hunk[i])
    }
  }
  return 0
}

function formatHunk(hunk: any[]): string {
  const oldStart = hunk.find(h => h.oldLineNum !== -1)?.oldLineNum ?? 0
  const newStart = hunk.find(h => h.newLineNum !== -1)?.newLineNum ?? 0
  
  const oldLen = hunk.filter(h => h.type !== 'added').length
  const newLen = hunk.filter(h => h.type !== 'removed').length
  
  const lines = hunk.map(h => {
    if (h.type === 'added') return `+${h.value}`
    if (h.type === 'removed') return `-${h.value}`
    return ` ${h.value}`
  })
  
  return `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n${lines.join('\n')}`
}
