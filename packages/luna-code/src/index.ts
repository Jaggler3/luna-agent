import type { Msg, ToolCall, SimpleRunCallbacks } from './types'
import { TOOLS, normalizeToolCall, coerceTextToolCall, executeTool } from './tools'
import { callOllamaStream } from './ollama'
import { buildSystemPrompt } from './prompts'
import { generateDiff } from './diff'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type { SimpleRunCallbacks }

function getCWD(): string {
  return process.env.LUNA_CWD ?? process.cwd()
}



function resolvePath(p: string): string {
  return join(getCWD(), p)
}

function truncateToolResult(result: string): string {
  const maxChars = 24_000
  if (result.length <= maxChars) return result
  return `${result.slice(0, maxChars)}\n\n[tool result truncated: ${result.length - maxChars} more characters]`
}

function looksLikeUnexecutedInvestigation(content: string): boolean {
  const text = content.toLowerCase()
  if (!text.trim()) return false
  const investigationSignals = [/\bwe need to\b/, /\bi need to\b/, /\blet'?s\b/, /\bsearch\b/, /\binspect\b/, /\bread\b/, /\blist\b/, /\bopen\b/, /\bfind\b/, /\bgrep\b/, /\bglob\b/, /\bbash\b/, /\brun\b/]
  const completionSignals = [/\bimplemented\b/, /\bfixed\b/, /\bupdated\b/, /\bcreated\b/, /\bverified\b/, /\bno code changes\b/, /\bi can'?t\b/, /\bnot able\b/]
  return investigationSignals.some((pattern) => pattern.test(text)) && !completionSignals.some((pattern) => pattern.test(text))
}

export async function simpleRun(prompt: string, callbacks?: SimpleRunCallbacks): Promise<void> {
  const messages: Msg[] = [
    { role: 'system', content: buildSystemPrompt(TOOLS) },
    { role: 'user', content: prompt },
  ]

  const maxIterations = 25
  let missingToolRetries = 0
  let emptyFinalRetries = 0
  let executedToolCount = 0
  const executedToolNames: string[] = []
  const toolCallCounts = new Map<string, number>()
  // Ring buffer of the last 3 [toolName, result] pairs for stagnation detection
  const recentToolResults: Array<{ tool: string; result: string }> = []

  for (let i = 0; i < maxIterations; i++) {
    let content = ''
    let toolCalls: ToolCall[] | undefined
    try {
      const result = await callOllamaStream(messages, TOOLS, {
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
            if (existsSync(fullPath)) oldContent = readFileSync(fullPath, 'utf-8')
            let newContent = ''
            if (tc.function.name === 'write_file') {
              newContent = args.content
            } else if (tc.function.name === 'edit_file') {
              newContent = oldContent.includes(args.oldString) ? oldContent.replace(args.oldString, args.newString) : oldContent
            }
            diff = generateDiff(args.path, oldContent, newContent)
          } catch (e) { }
        }

        callbacks?.onToolCall?.(tc.function.name, tc.function.arguments, diff)
        const result = truncateToolResult(await executeTool(tc))
        callbacks?.onToolResult?.(tc.function.name, result, tc.id)
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id })
        executedToolCount++
        executedToolNames.push(tc.function.name)
        toolCallCounts.set(tc.function.name, (toolCallCounts.get(tc.function.name) ?? 0) + 1)
        recentToolResults.push({ tool: tc.function.name, result })
        if (recentToolResults.length > 3) recentToolResults.shift()
      }
      // Stagnation check: if the last 3 results are all the same tool returning the same output,
      // the model is spinning. Inject a hard redirect before the next model call.
      if (recentToolResults.length === 3) {
        const [a, b, c] = recentToolResults
        if (a.tool === b.tool && b.tool === c.tool && a.result === b.result && b.result === c.result) {
          messages.push({
            role: 'user',
            content: `You have called [[${a.tool}]] 3 times in a row and received the same result each time. Stop repeating the same approach. Either try a fundamentally different tool or strategy, or report what is blocking you and stop.`,
          })
          recentToolResults.length = 0
        }
      }
      // Per-tool soft warning at 4+ calls of the same tool
      for (const [toolName, count] of toolCallCounts) {
        if (count === 4) {
          messages.push({
            role: 'user',
            content: `You have now called [[${toolName}]] ${count} times. Unless each call returned new information, consider whether continuing with this tool is productive.`,
          })
        }
      }
      continue
    }

    if (!content.trim() && executedToolCount > 0 && emptyFinalRetries < 2) {
      emptyFinalRetries++
      messages.push({ role: 'user', content: 'You have executed tools. Now provide a concise final response for the user that says what changed, whether anything failed or was unverified, and what they should try next. Do not call more tools unless you must verify a specific uncertainty.' })
      continue
    }

    if (!content.trim() && executedToolCount > 0) {
      const tools = [...new Set(executedToolNames)].join(', ')
      callbacks?.onToken?.(`I ran tools (${tools}), but the model did not produce a final response. Expand the thinking block or check Activity for the tool log before deciding what to try next.`)
      return
    }

    if (looksLikeUnexecutedInvestigation(content) && missingToolRetries < 2) {
      missingToolRetries++
      messages.push({ role: 'assistant', content })
      messages.push({ role: 'user', content: 'You described an investigation step but did not call a tool. Call read_file, grep, glob, or bash now. Do not narrate the search.' })
      continue
    }

    return
  }
}
