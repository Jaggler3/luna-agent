import { simpleRun } from 'luna-code'
import { createServer } from 'luna-gateway'

const transport = (process.env.LUNA_TRANSPORT as 'socket' | undefined) ?? 'stdio'

const server = createServer({
  agentId: process.env.AGENT_ID ?? 'agent',
  transport,
  socketPath: process.env.LUNA_SOCKET_PATH,
  handler: async (prompt, emit) => {
    await simpleRun(prompt, {
      onToolCall: (name, args, diff) => emit({ type: 'tool_call', name, args, diff }),
      onToolResult: (name, result, toolCallId) => emit({ type: 'tool_result', name, result, toolCallId }),
      onToken: (token) => emit({ type: 'token', content: token }),
      onReasoning: (chunk) => emit({ type: 'reasoning', content: chunk }),
    })
    emit({ type: 'done' })
  },
})

await server.listen()
