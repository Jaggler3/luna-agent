export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface SimpleRunCallbacks {
  onToolCall?: (name: string, args: string, diff?: string) => void
  onToolResult?: (name: string, result: string, toolCallId: string) => void
  onToken?: (token: string) => void
  onReasoning?: (chunk: string) => void
}
