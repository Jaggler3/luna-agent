import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

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

const SYSTEM_PROMPT = `You are luna, a coding agent. You have access to tools that let you read, write, and edit files, run commands, and search code.

Rules:
- Use tools to accomplish the user's request
- When the user describes a problem or asks a question, use your tools to investigate then make changes
- After making a change, verify it if possible
- When you are done, provide a summary of what you did

Available tools:
${TOOLS.map((t) => `  - ${t.function.name}: ${t.function.description}`).join('\n')}`

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
          callbacks?.onToken?.(delta.content)
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

function resolvePath(p: string): string {
  return join(CWD, p)
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
        let content = readFileSync(fullPath, 'utf-8')
        if (!content.includes(args.oldString)) {
          throw new Error(`oldString not found in ${args.path}`)
        }
        content = content.replace(args.oldString, args.newString)
        writeFileSync(fullPath, content, 'utf-8')
        return `edited ${args.path}`
      }
      case 'bash': {
        const output = execSync(args.command, {
          cwd: CWD,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        })
        return output || '(no output)'
      }
      case 'glob': {
        const g = new Bun.Glob(args.pattern)
        const matches: string[] = []
        for await (const match of g.scan({ cwd: CWD })) {
          matches.push(match)
        }
        return matches.join('\n') || '(no matches)'
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
            if (/^(node_modules|dist|\..+)/.test(file)) continue
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
  onToolCall?: (name: string, args: string) => void
  onToken?: (token: string) => void
  onReasoning?: (chunk: string) => void
}

export async function simpleRun(prompt: string, callbacks?: SimpleRunCallbacks): Promise<void> {
  const messages: Msg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]

  const maxIterations = 25

  for (let i = 0; i < maxIterations; i++) {
    const { content, toolCalls } = await callOllamaStream(messages, {
      onToken: callbacks?.onToken,
      onReasoning: callbacks?.onReasoning,
    })

    if (toolCalls && toolCalls.length > 0) {
      const assistantMsg: Msg = { role: 'assistant', content, tool_calls: toolCalls }
      messages.push(assistantMsg)

      for (const tc of toolCalls) {
        callbacks?.onToolCall?.(tc.function.name, tc.function.arguments)
        const result = await executeTool(tc)
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
      }
      continue
    }

    return
  }
}
