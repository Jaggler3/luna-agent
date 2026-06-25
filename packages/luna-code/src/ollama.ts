import type { Msg, ToolCall } from './types'
import type { ToolDef } from './types'

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const MODEL = process.env.LUNA_MODEL ?? 'gpt-oss:120b-cloud'

interface StreamCallbacks {
  onToken?: (t: string) => void
  onReasoning?: (t: string) => void
}

export async function callOllamaStream(
  messages: Msg[],
  tools: ToolDef[],
  callbacks?: StreamCallbacks
): Promise<{ content: string; toolCalls?: ToolCall[] }> {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
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
        if (delta.reasoning) callbacks?.onReasoning?.(delta.reasoning)
        if (delta.content) {
          content += delta.content
          if (!delta.tool_calls) callbacks?.onToken?.(delta.content)
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
      } catch { }
    }
  }

  const toolCalls = toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined
  return { content, toolCalls }
}
